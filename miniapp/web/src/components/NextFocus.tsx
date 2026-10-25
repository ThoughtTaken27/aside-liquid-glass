/**
 * Focus: one task, full screen, a timer, and nothing else.
 *
 * Quick add: a task in his own words, a due day, and a rough size.
 */
import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { haptic } from '../telegram';
import { Spinner, TodoCircle, X } from './Icons';
import { Sheet } from './Sheet';
import { useBackStack } from '../utils/backStack';
import type { NextItem, NextSpace } from '../types';
import { dayKey } from '../utils/nextPlanFormat';
import { parseQuickAdd } from '../utils/quickAdd';
import { useSpaceHint } from '../hooks/useSpaceHint';
import { SpaceChoice } from './NextSpace';

const BLOCKS = [15, 25, 45, 60];

function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function FocusMode({ item, onDone, onExit }: { item: NextItem; onDone: () => void; onExit: () => void }) {
  useBackStack([{ key: 'focus', back: onExit }], 500);
  const defaultBlock = item.estMinutes && item.estMinutes <= 60 ? BLOCKS.find((b) => b >= item.estMinutes!) ?? 25 : 25;
  const [block, setBlock] = useState(defaultBlock);
  const [left, setLeft] = useState(defaultBlock * 60);
  const [running, setRunning] = useState(false);
  const [ticked, setTicked] = useState<Record<number, boolean>>({});
  const endAt = useRef<number | null>(null);
  const lock = useRef<{ release: () => Promise<void> } | null>(null);

  // Keep the screen awake while the timer runs (Safari 16.4+).
  useEffect(() => {
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    if (running && wl) {
      wl.request('screen').then((l) => (lock.current = l)).catch(() => undefined);
    }
    return () => {
      void lock.current?.release().catch(() => undefined);
      lock.current = null;
    };
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => {
      const rem = ((endAt.current ?? Date.now()) - Date.now()) / 1000;
      setLeft(rem);
      if (rem <= 0) {
        setRunning(false);
        endAt.current = null;
        haptic('success');
      }
    }, 250);
    return () => window.clearInterval(t);
  }, [running]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onExit();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  const startPause = () => {
    haptic('light');
    if (running) {
      setRunning(false);
      endAt.current = null;
    } else {
      const secs = left > 0 ? left : block * 60;
      endAt.current = Date.now() + secs * 1000;
      setLeft(secs);
      setRunning(true);
    }
  };

  const pick = (b: number) => {
    setBlock(b);
    setLeft(b * 60);
    setRunning(false);
    endAt.current = null;
  };

  const total = block * 60;
  const frac = Math.min(1, Math.max(0, 1 - left / total));
  const R = 92;
  const C = 2 * Math.PI * R;
  const finished = left <= 0;

  return (
    <div className="nf" role="dialog" aria-modal="true" aria-label={`Focus on ${item.title}`}>
      <header className="nf-head">
        <button type="button" className="icon-button" onClick={onExit} aria-label="Leave focus">
          <X size={20} strokeWidth={1.75} />
        </button>
        <span className="nf-eyebrow">Focus</span>
        <span className="next-header-spacer" aria-hidden />
      </header>
      <div className="nf-body">
        <p className="nf-context">{item.context}</p>
        <h1 className="next-title nf-title">{item.title}</h1>
        <div className="nf-ring" aria-hidden>
          <svg viewBox="0 0 200 200" width="200" height="200">
            <circle cx="100" cy="100" r={R} className="nf-track" />
            <circle cx="100" cy="100" r={R} className="nf-fill" strokeDasharray={C} strokeDashoffset={C * (1 - frac)} transform="rotate(-90 100 100)" />
          </svg>
        </div>
        <p className="nf-time" role="timer" aria-live="off">
          {finished ? 'Time' : mmss(left)}
        </p>
        <p className="np-sr" aria-live="polite">
          {finished ? 'Block finished.' : running ? '' : 'Timer paused.'}
        </p>
        <div className="np-chips nf-blocks" role="radiogroup" aria-label="Block length">
          {BLOCKS.map((b) => (
            <button type="button" key={b} role="radio" aria-checked={block === b} className={block === b ? 'is-on' : ''} onClick={() => pick(b)} disabled={running}>
              {b} min
            </button>
          ))}
        </div>
        {item.steps.length ? (
          <ol className="next-steps nf-steps">
            {item.steps.map((s, i) => (
              <li key={i}>
                <button type="button" className="next-step" aria-pressed={!!ticked[i]} onClick={() => setTicked((t) => ({ ...t, [i]: !t[i] }))}>
                  <TodoCircle status={ticked[i] ? 'completed' : 'pending'} size={17} />
                  <span>{s}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <footer className="nf-foot">
        <button type="button" className="next-secondary" onClick={startPause}>
          {running ? <Pause size={16} strokeWidth={2} /> : <Play size={16} strokeWidth={2} />}
          {running ? 'Pause' : finished ? 'Another block' : left < total ? 'Resume' : 'Start'}
        </button>
        <button
          type="button"
          className="next-primary"
          onClick={() => {
            haptic('success');
            onDone();
          }}
        >
          Done
        </button>
      </footer>
    </div>
  );
}

// --------------------------------------------------------------------------

function dueChoices(now: Date): Array<{ id: string; label: string; day: string | null }> {
  const at = (n: number) => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));
  const toSat = (6 - now.getDay() + 7) % 7 || 7;
  return [
    { id: 'none', label: 'No date', day: null },
    { id: 'today', label: 'Today', day: at(0) },
    { id: 'tomorrow', label: 'Tomorrow', day: at(1) },
    { id: 'weekend', label: 'Weekend', day: at(toSat) },
    { id: 'week', label: 'In a week', day: at(7) },
  ];
}

const SIZES = [10, 30, 60, 120];

export function QuickAddSheet({
  onClose,
  onAdd,
  space: startSpace,
}: {
  onClose: () => void;
  onAdd: (task: { title: string; due: string | null; estMinutes: number | null; space: NextSpace }) => Promise<void>;
  space: NextSpace;
}) {
  const [chosen, setChosen] = useState<NextSpace | null>(null);
  const [title, setTitle] = useState('');
  // Until he taps a chip himself, the title can pick the space.
  const hinted = useSpaceHint(title, chosen === null);
  const space: NextSpace = chosen ?? hinted ?? startSpace;
  const setSpace = (s: NextSpace) => setChosen(s);
  const now = new Date();
  const choices = dueChoices(now);
  const [due, setDue] = useState('today');
  const [size, setSize] = useState<number | null>(30);
  const [busy, setBusy] = useState(false);
  // "Call Mom tomorrow 15m" fills When and How long by itself.
  const typed = parseQuickAdd(title, now);
  const typedDueId = typed.dueLabel === 'Today' || typed.dueLabel === 'Tonight' ? 'today' : typed.dueLabel === 'Tomorrow' ? 'tomorrow' : typed.due ? 'typed' : null;
  const dueId = typedDueId ?? due;
  const sizeNow = typed.estMinutes ?? size;
  const submit = async () => {
    const clean = typed.title || title.trim();
    if (!clean) return;
    setBusy(true);
    try {
      await onAdd({ title: clean, due: dueId === 'typed' ? typed.due : choices.find((c) => c.id === dueId)?.day ?? null, estMinutes: sizeNow, space });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet side="bottom" title="Add a task" subtitle={`It joins your ${space === 'school' ? 'School' : 'Personal'} list`} onClose={onClose}>
      <form
        className="np-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          <span>Task</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={space === 'school' ? 'Email Mr. Rhodes tomorrow 10m' : 'Call the dentist Friday 15m'} maxLength={140} autoFocus enterKeyHint="done" />
        </label>
        {typed.due || typed.estMinutes ? (
          <p className="np-typed">
            Adds “{typed.title || '…'}”{typed.dueLabel ? `, ${typed.dueLabel.toLowerCase()}` : ''}
            {typed.estMinutes ? `, ${typed.estMinutes < 60 ? `${typed.estMinutes} min` : `${Math.floor(typed.estMinutes / 60)} h${typed.estMinutes % 60 ? ` ${typed.estMinutes % 60} min` : ''}`}` : ''}
          </p>
        ) : null}
        <SpaceChoice value={space} onChange={setSpace} />
        {chosen === null && hinted && hinted !== startSpace ? <p className="np-typed">Put in {hinted === 'school' ? 'School' : 'Personal'} from the title. Tap to change.</p> : null}
        <div className="np-chips" role="radiogroup" aria-label="When">
          {choices.map((c) => (
            <button type="button" key={c.id} role="radio" aria-checked={dueId === c.id} className={dueId === c.id ? 'is-on' : ''} onClick={() => setDue(c.id)} disabled={!!typedDueId}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="np-chips" role="radiogroup" aria-label="How long">
          {SIZES.map((m) => (
            <button type="button" key={m} role="radio" aria-checked={sizeNow === m} className={sizeNow === m ? 'is-on' : ''} onClick={() => setSize(size === m ? null : m)} disabled={typed.estMinutes != null}>
              {m < 60 ? `${m} min` : `${m / 60} h`}
            </button>
          ))}
        </div>
        <button type="submit" className="next-primary" disabled={!(typed.title || title.trim()) || busy}>
          {busy ? <Spinner size={15} /> : null} Add
        </button>
      </form>
    </Sheet>
  );
}
