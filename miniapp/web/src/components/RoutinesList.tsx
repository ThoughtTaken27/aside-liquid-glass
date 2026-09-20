/**
 * A read-only list of the account's scheduled routines.
 *
 * Genuinely read-only, not just presented that way: `aside.routines`
 * exposes `list`/`get` and nothing else (verified against the live daemon,
 * plan section 1.4). There is no pause/resume/edit control here because
 * there is no request this server could make that would do one -- that
 * would need a full `aside exec` turn calling the `routine_update` tool,
 * which is a different cost model and out of scope for this screen.
 *
 * `RoutineRow` is typed as `{ [key: string]: unknown }` because the shape
 * is whatever the facade hands back; every field below is read
 * defensively rather than assumed.
 */
import { useEffect, useState } from 'react';
import { CalendarDays, ChevronLeft, Clock, Spinner } from './Icons';
import { api } from '../api';
import type { RoutineRow } from '../types';

function str(row: RoutineRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value ? value : null;
}

/** RRULE text is an implementation detail; users read cadence and time. */
export function routineScheduleLabel(row: RoutineRow): string | null {
  const friendly =
    str(row, 'schedule') ||
    str(row, 'cadence') ||
    str(row, 'frequency') ||
    str(row, 'runAt');
  if (friendly) return friendly;

  const raw = str(row, 'rrule');
  if (!raw) {
    return typeof row.scheduleKind === 'string' && row.scheduleKind
      ? row.scheduleKind
      : null;
  }
  const upper = raw.toUpperCase();
  const interval = /INTERVAL=(\d+)/.exec(upper)?.[1];
  const every = interval && interval !== '1' ? `Every ${interval} ` : 'Every ';
  if (upper.includes('FREQ=DAILY')) return `${every}day`;
  if (upper.includes('FREQ=WEEKLY')) return `${every}week`;
  if (upper.includes('FREQ=HOURLY')) return `${every}hour`;
  if (upper.includes('FREQ=MINUTELY')) return `${every}minute`;
  if (upper.includes('FREQ=MONTHLY')) return `${every}month`;
  if (upper.includes('FREQ=YEARLY')) return `${every}year`;
  return 'Repeating schedule';
}

export function routineNextRunLabel(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return null;
    return `Next ${date.toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    })}`;
  }
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime()) && /\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}/.test(value)) {
    return `Next ${parsed.toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    })}`;
  }
  return value.startsWith('Next ') ? value : `Next ${value}`;
}

function RoutineCard({ row }: { row: RoutineRow }) {
  const name = str(row, 'name') || 'Unnamed routine';
  const schedule = routineScheduleLabel(row);
  const state = str(row, 'state');
  const nextRun = routineNextRunLabel(
    row.nextRun ?? row.next_run ?? row.nextRunAt ?? null,
  );
  const active = (state ?? '').toLowerCase() === 'active';

  return (
    <div
      className={`routine-card surface-card${active ? ' is-active' : ''}`}
      data-surface-card="routine"
      data-state={active ? 'active' : state || 'unknown'}
    >
      <span className="routine-card-mark" aria-hidden="true">
        <CalendarDays size={16} strokeWidth={1.75} />
      </span>
      <span className="routine-card-main">
        <span className="routine-card-head">
          <span className="panel-row-name">{name}</span>
          {state ? (
            <span
              className={`badge surface-meta${active ? '' : ' is-muted'}`}
              data-surface-meta="state"
            >
              {state}
            </span>
          ) : null}
        </span>
        {schedule ? (
          <span className="settings-row-description">{schedule}</span>
        ) : null}
        {nextRun ? (
          <span
            className="routine-card-next surface-meta"
            data-surface-meta="next-run"
          >
            <Clock size={12} strokeWidth={2} aria-hidden="true" />
            {nextRun}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function RoutinesList({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<RoutineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.routines().then(
      (res) => alive && setRows(res.routines),
      (err) => alive && setError((err as Error).message),
    );
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div
      className="app settings-screen destination-surface"
      data-surface="destination"
      data-destination="routines"
    >
      <header className="thread-header surface-header" data-surface-header>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Back"
        >
          <ChevronLeft size={20} strokeWidth={1.75} />
        </button>
        <span className="thread-titles">
          <span className="thread-title">Routines</span>
        </span>
      </header>
      <div className="settings-scroll surface-content" data-surface-content>
        <p className="settings-note surface-meta" data-surface-meta="note">
          Read-only -- create or edit routines from Aside on your computer.
        </p>
        {error ? <p className="list-empty">{error}</p> : null}
        {!rows && !error ? (
          <p className="list-empty">
            <Spinner size={14} /> Loading…
          </p>
        ) : null}
        {rows && rows.length === 0 ? (
          <p className="list-empty">No routines.</p>
        ) : null}
        {rows?.map((row, index) => (
          <RoutineCard key={str(row, 'id') || index} row={row} />
        ))}
      </div>
    </div>
  );
}
