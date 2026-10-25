/**
 * The small motion vocabulary every surface shares.
 *
 * Measured from affectUI's rendered components (Thinking State, Thinking
 * Loader, Toaster, Message Actions) and rebuilt for this app rather than
 * copied: one ease (`--af-ease`, cubic-bezier(0.22, 1, 0.36, 1)), new text
 * rising 4-6px out of a 3px blur, checks that pop on an overshoot curve
 * and then draw their tick, and one light band that sweeps a live label.
 *
 * The rule that keeps it quiet: each of these marks a real state change.
 * Nothing here loops unless the thing it labels is actually working.
 */
import '../theme/text-motion.css';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A quiet, compositor-driven highlight over a fully readable label.
 * Arc UI's text-shimmer informed the state/lifecycle policy, not its code.
 * The hidden copy never enters the accessibility tree. Offscreen, hidden,
 * reduced-motion and inactive labels keep their text but stop the clock.
 */
export function Shine({ text, active = true, className = '' }: {
  text: string; active?: boolean; className?: string;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!active) { setRunning(false); return; }
    const element = host.current;
    if (!element) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let inView = typeof IntersectionObserver === 'undefined';
    const update = () => setRunning(inView && !document.hidden && !motion.matches);
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      inView = entries.some(entry => entry.isIntersecting);
      update();
    });
    observer?.observe(element);
    document.addEventListener('visibilitychange', update);
    motion.addEventListener('change', update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', update);
      motion.removeEventListener('change', update);
    };
  }, [active]);
  return (
    <span ref={host} className={`af-shine ${active ? 'is-active' : ''} ${running && active ? 'is-running' : ''} ${className}`}>
      {text}
      <span className="af-shine-window" aria-hidden="true"><span className="af-shine-copy" data-text={text} /></span>
    </span>
  );
}

/**
 * Change a short status in place, never a per-letter dance. The current
 * node survives every update; the outgoing copy is absolutely positioned
 * so it cannot resize the row. Bursts snap to the newest text instead of
 * stacking unfinished transitions. Existing callers own dwell/aria-live.
 */
export function RollText({ text, shine = false, className = '' }: {
  text: string; shine?: boolean; className?: string;
}) {
  const [prev, setPrev] = useState<string | null>(null);
  const current = useRef<HTMLSpanElement>(null);
  const last = useRef(text);
  const changedAt = useRef(-Infinity);
  const animation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    if (last.current === text) return;
    const old = last.current;
    last.current = text;
    const now = performance.now();
    const burst = now - changedAt.current < 320;
    changedAt.current = now;
    animation.current?.cancel();
    animation.current = null;
    const quiet = document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (quiet || burst || !old.trim()) { setPrev(null); return; }
    setPrev(old);
    animation.current = current.current?.animate?.(
      [{ opacity: 0.55, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }],
      { duration: 240, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    ) ?? null;
  }, [text]);
  useEffect(() => {
    if (prev === null) return;
    const id = window.setTimeout(() => setPrev(null), 180);
    return () => window.clearTimeout(id);
  }, [prev]);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const settle = () => {
      if (motion.matches || document.hidden) { animation.current?.cancel(); setPrev(null); }
    };
    motion.addEventListener('change', settle);
    document.addEventListener('visibilitychange', settle);
    return () => {
      animation.current?.cancel();
      motion.removeEventListener('change', settle);
      document.removeEventListener('visibilitychange', settle);
    };
  }, []);
  return (
    <span className={`af-roll ${className}`}>
      {prev !== null ? <span className="af-roll-label is-out" aria-hidden="true">{prev}</span> : null}
      <span ref={current} className="af-roll-label is-current">
        {shine ? <Shine text={text} /> : text}
      </span>
    </span>
  );
}

/**
 * A filled check that pops in and then draws its tick.
 *
 * `animate` is false for anything remounted from history: a check that
 * replays every time a row scrolls back into view is decoration, not news.
 */
export function DoneCheck({
  size = 18,
  animate = true,
  tone = 'done',
}: {
  size?: number;
  animate?: boolean;
  tone?: 'done' | 'quiet';
}) {
  return (
    <svg
      className={`af-check is-${tone} ${animate ? 'is-animated' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="9" />
      <path d="M6 10.4l2.6 2.6L14 7.6" pathLength={14} />
    </svg>
  );
}

/** A bare tick that draws itself; for copy and similar confirmations. */
export function DrawTick({ size = 16, animate = true }: { size?: number; animate?: boolean }) {
  return (
    <svg
      className={`af-tick ${animate ? 'is-animated' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="M3.5 8.4l2.9 2.9L12.6 5" pathLength={1} />
    </svg>
  );
}

/**
 * Eight rays that fade one after another, so the spinner turns without
 * rotating. Reads as "working" at 12px where a rotating arc reads as a
 * blur, and it has no seam to catch the eye.
 */
export function RaySpinner({ size = 14, label = 'working' }: { size?: number; label?: string }) {
  const rays = [];
  for (let i = 0; i < 8; i += 1) {
    const a = (i * Math.PI) / 4;
    const x1 = 8 + Math.sin(a) * 3.4;
    const y1 = 8 - Math.cos(a) * 3.4;
    const x2 = 8 + Math.sin(a) * 6.4;
    const y2 = 8 - Math.cos(a) * 6.4;
    rays.push(
      <line
        key={i}
        x1={x1.toFixed(2)}
        y1={y1.toFixed(2)}
        x2={x2.toFixed(2)}
        y2={y2.toFixed(2)}
        style={{ animationDelay: `${(i - 8) * 100}ms` }}
      />,
    );
  }
  return (
    <svg
      className="spinner af-rays"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      /* Presentation attributes, so the rays draw even where affect.css is
         not loaded (the Mac desk, galleries); its rules still win where it is. */
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      role="img"
      aria-label={label}
    >
      {rays}
    </svg>
  );
}

/**
 * A stable key that changes only when `value` changes after mount, for
 * one-shot entrance classes. History renders with `fresh === false`.
 */
export function useFreshChange<T>(value: T): boolean {
  const first = useRef(value);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (!Object.is(first.current, value)) setFresh(true);
  }, [value]);
  return fresh;
}

/** A wrapper whose children rise out of a light blur once, on mount. */
export function BlurIn({
  children,
  delay = 0,
  as: Tag = 'span',
  className = '',
}: {
  children: ReactNode;
  delay?: number;
  as?: 'span' | 'div';
  className?: string;
}) {
  return (
    <Tag className={`af-blur-in ${className}`} style={delay ? { animationDelay: `${delay}ms` } : undefined}>
      {children}
    </Tag>
  );
}

/**
 * Two icons in one cell: the resting glyph blurs and shrinks away while
 * the confirmation blurs in and draws its tick (affectUI Message Actions).
 * Interruptible, because both layers are transitions, not keyframes.
 */
export function IconMorph({
  on,
  idle,
  done,
  size = 16,
}: {
  on: boolean;
  idle: ReactNode;
  done?: ReactNode;
  size?: number;
}) {
  return (
    <span className="af-morph" style={{ width: size, height: size }}>
      <span className="af-layer" data-on={on ? undefined : ''}>{idle}</span>
      <span className="af-layer is-confirm" data-on={on ? '' : undefined}>
        {done ?? (
          <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 8.4l2.9 2.9L12.6 5" pathLength={1} />
          </svg>
        )}
      </span>
    </span>
  );
}

/**
 * Words that arrive one after another, each rising 2px once on first view
 * (Arc-inspired restraint: 440ms, 40ms apart, capped at eight steps).
 * `play` false renders plain text with no wrappers' motion.
 */
export function TextReveal({
  text,
  play,
  delay = 0,
  accent,
}: {
  text: string;
  play: boolean;
  delay?: number;
  /** One word drawn in the clay gradient (affectUI Gradient Text), e.g. a name. */
  accent?: string;
}) {
  const isAccent = (piece: string) =>
    Boolean(accent) && piece.replace(/[^\p{L}\p{N}'-]/gu, '') === accent;
  if (!play) {
    if (!accent) return <>{text}</>;
    return (
      <>
        {text.split(/(\s+)/).map((piece, i) =>
          isAccent(piece) ? <span key={i} className="af-grad is-still" data-text={piece}>{piece}</span> : piece,
        )}
      </>
    );
  }
  const words = text.split(/(\s+)/);
  let i = 0;
  return (
    <span className="af-reveal" aria-label={text} style={{ ['--af-rv-delay' as string]: `${delay}ms` }}>
      {words.map((piece, index) =>
        /^\s+$/.test(piece) || !piece ? (
          piece
        ) : (
          <span
            key={index}
            className={`af-reveal-w${isAccent(piece) ? ' af-grad' : ''}`}
            data-text={isAccent(piece) ? piece : undefined}
            aria-hidden="true"
            style={{ ['--i' as string]: Math.min(i++, 8) }}
          >
            {piece}
          </span>
        ),
      )}
    </span>
  );
}

/**
 * Content that swaps in place (affectUI Blur Crossfade): the old copy
 * blurs, fades and grows 2% while the new one sharpens in from 98%.
 * Only the latest leaving copy is ever kept, so quick changes stay clean.
 */
export function BlurSwap({
  value,
  children,
  className = '',
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const [out, setOut] = useState<{ node: ReactNode; n: number } | null>(null);
  const prevNode = useRef<ReactNode>(children);
  const prevValue = useRef(value);
  const n = useRef(0);
  useLayoutEffect(() => {
    if (prevValue.current !== value) {
      // Arriving from nothing is a first paint, not a change: no swap.
      if (prevValue.current.trim()) {
        n.current += 1;
        setOut({ node: prevNode.current, n: n.current });
      }
      prevValue.current = value;
    }
    prevNode.current = children;
  });
  useEffect(() => {
    if (!out) return undefined;
    const id = window.setTimeout(() => setOut(null), 320);
    return () => window.clearTimeout(id);
  }, [out]);
  return (
    <span className={`af-swap ${out ? 'is-busy' : ''} ${className}`}>
      {out ? (
        <span key={`o${out.n}`} className="af-swap-layer is-out" aria-hidden="true">
          {out.node}
        </span>
      ) : null}
      <span key={`i${n.current}`} className={`af-swap-layer ${n.current ? 'is-in' : ''}`}>
        {children}
      </span>
    </span>
  );
}

/**
 * A number whose digits roll (affectUI Number Ticker): up when it grows,
 * down when it shrinks, a new column sliding in when it gains a digit.
 * Tabular figures, so the width holds while it rolls. Non-digits sit
 * still. The accessible text is the plain value.
 */
export function NumberTicker({ value, className = '' }: { value: number | string; className?: string }) {
  const text = String(value);
  const prevText = useRef(text);
  const grew = useRef(true);
  if (prevText.current !== text) {
    const a = Number(String(prevText.current).replace(/[^\d.-]/g, ''));
    const b = Number(text.replace(/[^\d.-]/g, ''));
    grew.current = !(Number.isFinite(a) && Number.isFinite(b) && b < a);
    prevText.current = text;
  }
  const chars = text.split('');
  // Columns that appear after mount slide in; the first render is still.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return (
    <span className={`af-ticker ${className}`}>
      <span className="af-sr">{text}</span>
      <span className="af-ticker-track" aria-hidden="true">
        {chars.map((ch, i) => {
          // Keyed from the right, so the ones column stays the ones column
          // when the number gains a digit on the left.
          const key = chars.length - i;
          if (!/\d/.test(ch)) return <span key={`s${key}`} className="af-ticker-static">{ch}</span>;
          return <TickerColumn key={`d${key}`} digit={Number(ch)} grew={grew.current} enter={mounted.current} />;
        })}
      </span>
    </span>
  );
}

function TickerColumn({ digit, grew, enter }: { digit: number; grew: boolean; enter: boolean }) {
  // Cells 0-9 then a second 0, so 9 -> 0 while growing rolls forward.
  const [entering] = useState(enter);
  const [pos, setPos] = useState(digit);
  const [instant, setInstant] = useState(false);
  const last = useRef(digit);
  useEffect(() => {
    if (last.current === digit) return undefined;
    const from = last.current;
    last.current = digit;
    if (grew && digit < from) {
      setInstant(false);
      setPos(digit === 0 ? 10 : digit);
      if (digit === 0) {
        const id = window.setTimeout(() => {
          setInstant(true);
          setPos(0);
        }, 520);
        return () => window.clearTimeout(id);
      }
      return undefined;
    }
    setInstant(false);
    setPos(digit);
    return undefined;
  }, [digit, grew]);
  return (
    <span className={`af-ticker-col ${entering ? 'is-enter' : ''}`}>
      <span
        className={`af-ticker-stack ${instant ? 'is-instant' : ''}`}
        style={{ transform: `translateY(${(-pos * 100) / 11}%)` }}
      >
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d, i) => (
          <span key={i} className="af-ticker-cell">{d}</span>
        ))}
      </span>
    </span>
  );
}
