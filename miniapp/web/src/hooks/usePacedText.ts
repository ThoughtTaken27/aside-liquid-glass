import { useEffect, useRef, useState } from 'react';

/**
 * How far behind the arriving text the reveal is allowed to run, in
 * seconds. A chunk is spread over roughly this long instead of landing in
 * one frame.
 */
export const PACE_LAG_S = 0.55;
/** The slowest the reveal ever goes, in characters per second. */
export const PACE_MIN_CPS = 70;
/** Buffered paragraphs must not accelerate into a multi-line flash. */
export const PACE_MAX_CPS = 420;
/** Fewest milliseconds between two re-renders of the answer. */
export const PACE_MIN_COMMIT_MS = 48;
/** Arriving text this old with no more behind it is complete enough to show its last word. */
const TAIL_IDLE_MS = 140;
/** Opening a chat mid-answer shows what is already there instead of retyping it. */
const RETYPE_LIMIT = 160;

const commonPrefix = (a: string, b: string) => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
};

/**
 * Even out a streaming answer.
 *
 * Text reaches the phone in whatever pieces the CLI's pipe hands over:
 * sometimes three words every 50ms, sometimes forty words at once and then
 * nothing for most of a second. Rendering each piece the frame it lands
 * makes the reading line lurch -- a whole sentence appears, then the
 * screen holds, then another. Traced on a buffered stream: six updates of
 * about a hundred characters each.
 *
 * This reveals at a rate proportional to the backlog (so a burst is spread
 * over about half a second and a trickle is shown almost as it arrives),
 * a whole word at a time, never re-rendering more than ~20 times a second.
 *
 * `active` is the stream being live. When it ends and the settled text
 * still starts with what is on screen, the reveal finishes its run
 * instead of dumping the remainder; anything else is shown at once.
 */
export function usePacedText(target: string, active: boolean, paceInitial = false): { text: string; revealing: boolean } {
  const [shown, setShown] = useState(() =>
    active && (paceInitial || target.length <= RETYPE_LIMIT) ? 0 : target.length,
  );
  const pos = useRef(shown);
  const committed = useRef(shown);
  const targetRef = useRef(target);
  // Mount counts as a change: a short first chunk is paced, not treated
  // as long settled and shown whole on the first frame.
  const changedAt = useRef(typeof performance !== 'undefined' ? performance.now() : 0);
  const activeRef = useRef(active);
  const raf = useRef(0);

  if (targetRef.current !== target) {
    const keep = commonPrefix(targetRef.current.slice(0, committed.current), target);
    if (keep < committed.current) {
      // The text under the reveal changed (a rewrite, not an append). While
      // live, continue from where they still agree; once settled, a
      // different text is simply shown -- retyping an answer is worse.
      committed.current = active ? keep : target.length;
      pos.current = committed.current;
    }
    targetRef.current = target;
    changedAt.current = typeof performance !== 'undefined' ? performance.now() : 0;
  }
  activeRef.current = active;

  const behind = committed.current < target.length;
  const pacing = active || behind;

  useEffect(() => {
    if (typeof requestAnimationFrame === 'undefined' || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      committed.current = targetRef.current.length;
      pos.current = committed.current;
      setShown(committed.current);
      return undefined;
    }
    if (!pacing || raf.current) return undefined;
    let last = performance.now();
    let lastCommit = 0;
    const tick = (now: number) => {
      raf.current = 0;
      const text = targetRef.current;
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      const backlog = text.length - pos.current;
      if (backlog > 0) {
        pos.current = Math.min(text.length, pos.current + Math.min(PACE_MAX_CPS, Math.max(PACE_MIN_CPS, backlog / PACE_LAG_S)) * dt);
      }
      // A whole word at a time; the trailing word only once nothing more
      // is coming for it (the stream paused or ended).
      let cut = Math.floor(pos.current);
      if (cut >= text.length) {
        const settled = !activeRef.current || now - changedAt.current > TAIL_IDLE_MS;
        cut = settled ? text.length : Math.max(committed.current, text.search(/\s\S*$/) + 1);
      } else {
        const space = text.lastIndexOf(' ', cut);
        const line = text.lastIndexOf('\n', cut);
        cut = Math.max(committed.current, Math.max(space, line) + 1);
      }
      if (cut !== committed.current && (now - lastCommit >= PACE_MIN_COMMIT_MS || cut === text.length)) {
        committed.current = cut;
        lastCommit = now;
        setShown(cut);
      }
      // Keep running only while there is something to show, or the newest
      // word is still waiting out its idle beat. A stream that pauses (a
      // slow network, a long think) costs nothing; the next chunk makes
      // `behind` true again, which restarts this loop.
      if (committed.current < text.length || (activeRef.current && now - changedAt.current <= TAIL_IDLE_MS)) {
        raf.current = requestAnimationFrame(tick);
      }
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
    // The loop reads the latest text through refs, so new chunks do not
    // restart it; it only (re)starts when there is something to pace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pacing, behind]);

  void shown; // state only schedules the re-render; the ref is the truth
  const length = Math.min(committed.current, target.length);
  return {
    text: pacing ? target.slice(0, length) : target,
    revealing: pacing && (active || length < target.length),
  };
}
