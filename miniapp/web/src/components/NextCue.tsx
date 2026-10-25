import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatDueShort } from '../utils/nextFormat';
import { ListTodo } from './Icons';
import type { NextItem } from '../types';

const REFRESH_MS = 60_000;

/** The one line on the home screen. Quiet until there is something to say. */
export function NextCue({ onOpen }: { onOpen: () => void }) {
  const [item, setItem] = useState<NextItem | null>(null);
  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .next()
        .then((p) => alive && setItem(p.now))
        .catch(() => undefined);
    pull();
    const timer = window.setInterval(pull, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  if (!item) return null;
  const now = new Date();
  return (
    <button type="button" className={`next-cue${item.lateConfirmed ? ' is-late' : ''}`} onClick={onOpen}>
      <span className="next-cue-label">Next</span>
      <span className="next-cue-title">{item.title}</span>
      <span className="next-cue-meta">{formatDueShort(item.dueISO, now)}</span>
    </button>
  );
}

/**
 * Next's own door: the top-left icon on the home screen, mirroring the
 * browser button on the right. It replaced the cue under the greeting, so
 * the resting screen is the greeting alone and Next is one tap away.
 *
 * The cue said what was next; the button keeps only the part that matters
 * at a glance. A small dot appears when the current item is late or due
 * within a day, and nothing otherwise, so the dot never becomes wallpaper.
 */
export function NextButton({ onOpen }: { onOpen: () => void }) {
  const [item, setItem] = useState<NextItem | null>(null);
  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .next()
        .then((p) => alive && setItem(p.now))
        .catch(() => undefined);
    pull();
    const timer = window.setInterval(pull, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  const due = item?.dueISO ? new Date(item.dueISO).getTime() - Date.now() : Infinity;
  const urgent = !!item && (item.lateConfirmed || due < 24 * 60 * 60 * 1000);
  const label = item ? `Next: ${item.title}` : 'Next';
  return (
    <button type="button" className="icon-button home-next-button" onClick={onOpen} aria-label={label}>
      <ListTodo size={19} strokeWidth={1.75} />
      {urgent ? <span className={`home-next-dot${item?.lateConfirmed ? ' is-late' : ''}`} aria-hidden /> : null}
    </button>
  );
}
