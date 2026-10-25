import { ACTIVITY_REVEAL_EVENT } from '../utils/activityReveal';
import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react';

export interface EndFollowRefs {
  /** The reader is at the end and wants to stay there. */
  pinned: MutableRefObject<boolean>;
  /** The position is ours for the moment (a session open or a jump). */
  landing: MutableRefObject<boolean>;
  /** A finger is on the glass. */
  touching: MutableRefObject<boolean>;
}

export interface EndFollow {
  /** True while a glide is moving the scroller (its scroll events are ours). */
  active: () => boolean;
  /** Content may have changed: follow it if the reader is at the end. */
  kick: () => void;
  /** A real gesture cancels all automatic scroll work immediately. */
  cancel: () => void;
}

/**
 * How long the glide takes to catch up, in seconds (a spring's "response").
 *
 * Measured before this existed: every new line of a streaming answer moved
 * the whole transcript 26px in one frame, and a buffered chunk moved it up
 * to 126px. That snap, many times a second, is the frantic repositioning.
 * A critically damped spring (no overshoot, Apple's default for moving
 * something into place) carries the same distance over a few frames and
 * starts from wherever the scroller actually is, so a new line arriving
 * mid-glide just extends it instead of restarting it.
 *
 * 0.5s is unhurried without trailing the text: while an answer flows at
 * reading pace the glide sits a few pixels behind the newest line.
 */
export const FOLLOW_RESPONSE_S = 0.5;
const OMEGA = (2 * Math.PI) / FOLLOW_RESPONSE_S;

/**
 * Stick to the bottom whenever the content grows under us.
 *
 * The first attempt at this was a rAF loop that gave up after 1200ms.
 * It was not enough, and the reason is worth keeping: the transcript
 * that most needs to land at the bottom is the long one, and the long
 * one is exactly the one whose deferred markdown, highlighting and font
 * swap take longest to finish. Measured on a real session here, the
 * scroller settled 6802px above the true bottom -- the timer expired
 * with two thirds of the document still to lay out.
 *
 * A clock was the wrong instrument. This watches the thing that
 * actually matters: the height of the content. Any growth while we are
 * pinned re-pins, for as long as it keeps growing, whether that is two
 * frames or ten seconds. It covers the open, the stream and the late
 * async chunk with one mechanism, and it costs nothing when idle.
 *
 * Opening a session (`landing`) still goes instantly: that is arriving,
 * not following, and gliding through history on open is its own jank.
 * So does a resize of the scroller itself (the keyboard), which already
 * moved on its own curve. Only content growing under a reader who is at
 * the end glides.
 *
 * The children are observed rather than the scroller, because a
 * scroll container's own box does not change when its content does.
 * The MutationObserver re-subscribes when React swaps that child list.
 */
export function useEndFollow(
  scroller: RefObject<HTMLElement | null>,
  refs: EndFollowRefs,
  onMove: () => void,
): EndFollow {
  const { pinned, landing, touching } = refs;
  const api = useRef<EndFollow>({ active: () => false, kick: () => {}, cancel: () => {} });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    let raf = 0;
    let v = 0;
    let x = 0;
    let last = 0;
    let revealTarget: HTMLElement | null = null;
    let revealStarted = 0;
    const end = () => Math.max(0, el.scrollHeight - el.clientHeight);
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      v = 0;
    };
    const cancel = () => { revealTarget = null; stop(); };
    const targetPosition = () => {
      if (!revealTarget) return end();
      if (!revealTarget.isConnected || !el.contains(revealTarget)) { revealTarget = null; return el.scrollTop; }
      const dock = Number.parseFloat(getComputedStyle(el.parentElement ?? el).getPropertyValue('--dock-h')) || 0;
      const bottom = revealTarget.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop;
      return Math.max(el.scrollTop, Math.min(end(), bottom - el.clientHeight + dock + 12));
    };
    const allowed = () =>
      (revealTarget !== null || pinned.current || landing.current) &&
      // A finger on the glass owns the position: never tug it back to the
      // end mid-drag (that tug is the "pushback" near the bottom).
      !(touching.current && !landing.current);
    const jump = () => {
      stop();
      el.scrollTo({ top: targetPosition(), behavior: 'instant' as ScrollBehavior });
      onMove();
    };
    const frame = (now: number) => {
      raf = 0;
      if (!allowed()) {
        revealTarget = null;
        v = 0;
        return;
      }
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      const target = targetPosition();
      // Only an input gesture releases ownership. A shrinking document
      // can clamp scrollTop upward too; that is not the reader leaving.
      // Moved otherwise (content clamped it, the keyboard): continue from
      // where it really is, never from where the glide thought it was.
      if (Math.abs(el.scrollTop - x) > 2) x = el.scrollTop;
      // The closed-form critically damped step, exact for any frame length.
      // A plain Euler step after one slow frame (a 43ms render) threw the
      // first step 41px instead of 12, which read as the very jump this
      // replaces.
      const previousX = x;
      const x0 = x - target;
      const omega = revealTarget ? 2 * Math.PI / 0.38 : OMEGA;
      const k = v + omega * x0;
      const decay = Math.exp(-omega * dt);
      x = target + (x0 + k * dt) * decay;
      v = (v - omega * k * dt) * decay;
      // Late media/large buffered chunks must not trigger a multi-screen
      // snap. Cap automatic travel to 1.5 viewports per second; a gesture
      // can always interrupt it. Explicit Jump remains a separate action.
      const maxStep = Math.max(1, el.clientHeight * (revealTarget ? 4 : 1.5)) * dt;
      if (x - previousX > maxStep) {
        x = previousX + maxStep;
        v = Math.min(v, maxStep / dt);
      }
      if (x >= target) {
        x = target;
        v = 0;
      }
      if (target - x < 0.5 && Math.abs(v) < 12) {
        el.scrollTo({ top: target, behavior: 'instant' as ScrollBehavior });
        v = 0;
        // Follow the same 320ms unfold, including its initially-zero frame.
        if (revealTarget && now - revealStarted < 400) raf = requestAnimationFrame(frame);
        else revealTarget = null;
        onMove();
        return;
      }
      el.scrollTo({ top: x, behavior: 'instant' as ScrollBehavior });
      onMove();
      raf = requestAnimationFrame(frame);
    };
    const glide = () => {
      if (!allowed()) return;
      if (landing.current || reduce?.matches || typeof requestAnimationFrame === 'undefined') {
        jump();
        if (revealTarget) { revealTarget = null; onMove(); }
        return;
      }
      const gap = targetPosition() - el.scrollTop;
      if (gap <= 0.5 && !revealTarget) {
        onMove();
        return;
      }
      if (!raf) {
        x = el.scrollTop;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    api.current = { active: () => raf !== 0 || revealTarget !== null, kick: glide, cancel };
    const onExpand = (event: Event) => {
      const target = (event as CustomEvent<{ target?: HTMLElement; expanded?: boolean }>).detail?.target;
      if (!(target instanceof HTMLElement) || !el.contains(target)) return;
      if ((event as CustomEvent<{ expanded?: boolean }>).detail.expanded === false) { cancel(); onMove(); return; }
      stop();
      landing.current = false;
      revealTarget = target;
      revealStarted = performance.now();
      // Wait until React commits the expanded body; reduced motion still
      // needs its final geometry, not the collapsed pre-click bounds.
      raf = requestAnimationFrame((now) => {
        raf = 0;
        if (reduce?.matches) { if (allowed()) jump(); revealTarget = null; onMove(); }
        else { last = now - 16; frame(now); }
      });
    };
    el.addEventListener(ACTIVITY_REVEAL_EVENT, onExpand);
    if (typeof ResizeObserver === 'undefined') return () => { cancel(); el.removeEventListener(ACTIVITY_REVEAL_EVENT, onExpand); };
    const ro = new ResizeObserver((entries) => {
      if (entries.some((entry) => entry.target === el)) {
        // The scroller's own box: the keyboard opened or closed, and it
        // already animated. Keep the last line exactly above the dock.
        if (allowed()) { if (revealTarget) glide(); else jump(); }
        return;
      }
      glide();
    });
    const watch = () => {
      ro.disconnect();
      // The scroller's own box too: when the software keyboard opens, the
      // layout viewport shrinks (interactive-widget=resizes-content), and a
      // pinned transcript has to follow its last line up above the dock.
      ro.observe(el);
      for (const child of Array.from(el.children)) ro.observe(child);
    };
    watch();
    const mo = new MutationObserver(() => {
      watch();
      glide();
    });
    mo.observe(el, { childList: true });
    // A wheel or trackpad is a gesture too. Upward means leaving the end:
    // unpin now, so the next resize cannot start a glide back down before
    // the scroll handler has caught up.
    const onWheel = (event: WheelEvent) => {
      cancel();
      if (event.deltaY < 0 && !landing.current) pinned.current = false;
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      cancel();
      el.removeEventListener(ACTIVITY_REVEAL_EVENT, onExpand);
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener('wheel', onWheel);
      api.current = { active: () => false, kick: () => {}, cancel: () => {} };
    };
  }, [scroller, pinned, landing, touching, onMove]);
  return useRef<EndFollow>({
    active: () => api.current.active(),
    kick: () => api.current.kick(),
    cancel: () => api.current.cancel(),
  }).current;
}
