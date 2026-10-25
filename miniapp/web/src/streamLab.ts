/**
 * Dev-only: a turn that streams like a real one, for frame-tracing motion.
 *
 * Mirrors useThread's semantics: provisional text arrives as `stream_delta`
 * chunks into a single `streaming` row; a `thread_delta` from the
 * transcript replaces it (mid-turn commentary folds into the work block,
 * the final answer settles as an `answer` row with its own id).
 *
 * `?cadence=token` sends 1-4 words every ~45ms (a fast model);
 * `?cadence=burst` sends 8-40 words every 350-900ms (a buffered pipe).
 * Seeded, so every run is the same run.
 */
import { useEffect, useState } from 'react';
import type { ThreadItem, WorkStep } from './types';

const ANSWER = `I traced the jitter to two places: the transcript snaps to the end on every new line, and long chunks land all at once.

## What changed

- **Scrolling** now follows the newest line with a soft, critically damped glide instead of a jump.
- **Text** flows in at an even pace, so a burst of forty words reads like the rest.
- **Lists and tables** hold their shape while they are still arriving.

| Area | Before | After |
| --- | --- | --- |
| Follow | Instant snap | Smooth glide |
| Reveal | Bursty | Even |

\`\`\`ts
const next = current + (target - current) * k;
\`\`\`

The rest of the screen stays exactly where it was, and nothing moves unless the content underneath it really changed. Tap the arrow if you scroll up and want to get back to the live end.`;

const COMMENTARY = 'Let me check the scroll code first, then measure the frames before changing anything.';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Split into word-plus-trailing-space pieces, keeping newlines intact. */
function pieces(text: string): string[] {
  return text.match(/\S+\s*/g) || [];
}

const step = (id: string, label: string, status: WorkStep['status'] = 'success', tool = 'bash'): WorkStep =>
  ({ kind: 'step', id, label, tool, icon: 'terminal', status, diffstat: null, detail: { command: label, output: 'ok' }, images: [] }) as WorkStep;

export function useStreamSim(enabled: boolean) {
  const params = new URLSearchParams(location.search);
  const cadence = params.get('cadence') === 'burst' ? 'burst' : 'token';
  const [items, setItems] = useState<ThreadItem[]>([
    { kind: 'user', id: 'su', text: 'Why does the text jitter when it streams? Fix it carefully.', ts: 1 },
  ]);
  const [phase, setPhase] = useState('idle');

  useEffect(() => {
    if (!enabled) return undefined;
    const rand = rng(7);
    const timers: number[] = [];
    let t = 600;
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    const user = { kind: 'user', id: 'su', text: 'Why does the text jitter when it streams? Fix it carefully.', ts: 1 } as ThreadItem;
    let steps: any[] = [step('s1', 'Read App.tsx', 'pending', 'read_file')];
    const work = (running: boolean) => ({ kind: 'work', id: 'sw', durationMs: 4000, running, items: steps }) as ThreadItem;
    let stream = '';
    const view = (running: boolean, extra: ThreadItem[] = []) =>
      setItems([user, work(running), ...extra, ...(stream.trim() ? [{ kind: 'streaming', id: 'streaming', text: stream.trim() } as ThreadItem] : [])]);

    const streamText = (text: string) => {
      const words = pieces(text);
      let i = 0;
      while (i < words.length) {
        const n = cadence === 'burst' ? 8 + Math.floor(rand() * 33) : 1 + Math.floor(rand() * 4);
        const chunk = words.slice(i, i + n).join('');
        i += n;
        t += cadence === 'burst' ? 350 + rand() * 550 : 25 + rand() * 40;
        at(t, () => {
          stream += chunk;
          view(true);
        });
      }
    };

    at(t, () => { setPhase('work'); view(true); });
    t += 700;
    // Mid-turn commentary, then the transcript takes it over.
    streamText(COMMENTARY);
    t += 500;
    at(t, () => {
      stream = '';
      steps = [step('s1', 'Read App.tsx', 'success', 'read_file'), { kind: 'text', id: 'c1', text: COMMENTARY }, step('s2', 'Traced 240 frames', 'pending')];
      view(true);
    });
    t += 1400;
    at(t, () => {
      steps = steps.map((s: any) => (s.id === 's2' ? { ...s, status: 'success' } : s));
      setPhase('answer');
      view(true);
    });
    t += 300;
    streamText(ANSWER);
    t += 700;
    at(t, () => {
      stream = '';
      setPhase('settled');
      setItems([user, work(false), { kind: 'answer', id: 'sa', text: ANSWER, ts: 3 } as ThreadItem]);
    });
    t += 1500;
    at(t, () => setPhase('done'));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [enabled, cadence]);

  useEffect(() => {
    document.documentElement.dataset.simPhase = phase;
  }, [phase]);
  return items;
}
