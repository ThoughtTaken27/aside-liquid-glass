import { Collapse } from './Collapse';
/**
 * Activity: everything Next and its agents did, in order, and one switch
 * that stops all of it.
 *
 * The log is written by the Mac, never by a model, and each entry is
 * sealed to the one before it, so an edited or deleted entry shows up as a
 * broken seal here. The "what each part can do" list says honestly which
 * rules code enforces and which are only instructions to a model.
 */
import { Shine } from './Affect';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../api';
import { haptic } from '../telegram';
import { ChevronDown, ShieldCheck, Spinner, TriangleAlert } from './Icons';
import { toast } from './Toasts';
import type { LedgerEntry, NextSafety, NextSpace } from '../types';
import { NextContext } from './NextContext';
import { ACTOR_WORD, clock, dayKey, dayLabel } from '../utils/nextPlanFormat';

const FILTERS: Array<{ id: string; label: string }> = [
  { id: '', label: 'All' },
  { id: 'agents', label: 'Next' },
  { id: 'you', label: 'You' },
];

const HOW_WORD = { code: 'Built into Next', aside: 'Blocked by Aside', instruction: 'Only an instruction' } as const;

function ActivityAreas({ mode, setMode, idBase }: { mode: 'actions' | 'context'; setMode: (mode: 'actions' | 'context') => void; idBase: string }) {
  return <div className="na-context-tabs" role="tablist" aria-label="Activity area">{(['actions', 'context'] as const).map((id, index) => <button type="button" role="tab" key={id} id={`${idBase}-${id}`} aria-controls={`${idBase}-panel`} aria-selected={mode === id} tabIndex={mode === id ? 0 : -1} onClick={() => setMode(id)} onKeyDown={e => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); const i = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : 1 - index; setMode(i === 0 ? 'actions' : 'context'); (e.currentTarget.parentElement?.querySelectorAll('button')[i] as HTMLButtonElement | undefined)?.focus(); }}>{id === 'actions' ? 'Actions' : 'Context'}</button>)}</div>;
}
export function ActivityTab({ onPausedChange, space = 'school' }: { onPausedChange?: (paused: boolean) => void; space?: NextSpace }) {
  const [mode, setMode] = useState<'actions' | 'context'>('actions');
  const idBase = useId();
  const [safety, setSafety] = useState<NextSafety | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [partsOpen, setPartsOpen] = useState(false);
  const now = new Date();
  // A parent's inline callback is not a reason to restart network polling.
  const onPaused = useRef(onPausedChange);
  onPaused.current = onPausedChange;
  const lastPaused = useRef<boolean | undefined>(undefined);
  const activeFilter = useRef(filter);
  activeFilter.current = filter;
  const flights = useRef(new Map<string, Promise<void>>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const load = useCallback((): Promise<void> => {
    const existing = flights.current.get(filter);
    if (existing) return existing;
    const run = Promise.resolve().then(async () => {
      try {
        const [s, a] = await Promise.all([api.nextSafety(), api.nextActivity({ actor: filter || undefined, limit: 60 })]);
        if (!mounted.current || filter !== activeFilter.current) return;
        setSafety(s);
        setEntries(a.entries);
        setMore(a.more);
        if (lastPaused.current !== s.control.paused) {
          lastPaused.current = s.control.paused;
          onPaused.current?.(s.control.paused);
        }
      } catch {
        if (mounted.current && filter === activeFilter.current) toast('Could not load activity.', { tone: 'error' });
      } finally {
        flights.current.delete(filter);
      }
    });
    flights.current.set(filter, run);
    return run;
  }, [filter]);

  useEffect(() => {
    if (mode === 'context') return;
    const visibleLoad = () => { if (document.visibilityState === 'visible') void load(); };
    visibleLoad();
    const t = window.setInterval(visibleLoad, 30_000);
    document.addEventListener('visibilitychange', visibleLoad);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', visibleLoad); };
  }, [load, mode]);

  const loadMore = async () => {
    if (!entries?.length) return;
    const a = await api.nextActivity({ actor: filter || undefined, before: entries[entries.length - 1].seq, limit: 60 });
    setEntries([...entries, ...a.entries]);
    setMore(a.more);
  };

  const toggle = async () => {
    if (!safety) return;
    const paused = !safety.control.paused;
    setSwitching(true);
    haptic(paused ? 'warning' : 'light');
    try {
      const r = await api.nextPause(paused);
      toast(paused ? `Paused.${r.stopped ? ` Stopped ${r.stopped} running.` : ''} Nothing new starts.` : 'Next is on again. Nothing restarted on its own.');
      await load();
    } catch {
      toast('The switch did not save. Try again.', { tone: 'error' });
    } finally {
      setSwitching(false);
    }
  };

  if (mode === 'context') return <div className="na"><header className="n3-title-block"><h1 className="n3-title">Activity</h1><p className="n3-subtitle">What Next did, and what it remembers.</p></header><ActivityAreas mode={mode} setMode={setMode} idBase={idBase} /><div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-context`} tabIndex={0}><NextContext initialSpace={space} embedded /></div></div>;
  const paused = safety?.control.paused ?? false;
  const groups: Array<{ day: string; items: LedgerEntry[] }> = [];
  for (const e of entries ?? []) {
    const day = dayKey(new Date(e.at));
    const g = groups.at(-1);
    if (g && g.day === day) g.items.push(e);
    else groups.push({ day, items: [e] });
  }

  const renderEntry = (e: LedgerEntry, compact = false) => {
                const expanded = open === e.seq;
                const hasMore = Boolean(e.detail && Object.keys(e.detail).length) || Boolean(e.sessionId);
                return (
                  <li key={e.seq} className={`na-row is-${e.actor}${e.risk === 'low' || e.risk === 'high' ? ` is-risk-${e.risk}` : ''}`}>
                    <button type="button" className="na-row-main" onClick={() => setOpen(expanded ? null : e.seq)} aria-expanded={hasMore ? expanded : undefined} disabled={!hasMore}>
                      <span className="na-glyph" aria-hidden />
                      <span className="na-row-text">
                        <span className="na-row-who">
                          {ACTOR_WORD[e.actor] ?? e.actor}
                          <time dateTime={e.at}>{clock(e.at)}</time>
                        </span>
                        {compact ? null : <span className="na-row-summary">{e.summary}</span>}
                      </span>
                      {hasMore ? <ChevronDown size={15} strokeWidth={1.75} className={expanded ? 'is-open' : ''} /> : null}
                    </button>
                    <Collapse open={expanded}>
                      <dl className="na-detail">
                        {Object.entries(e.detail ?? {}).map(([k, v]) => (
                          <div key={k}>
                            <dt>{k}</dt>
                            <dd>{String(v)}</dd>
                          </div>
                        ))}
                        {e.sessionId ? (
                          <div>
                            <dt>chat</dt>
                            <dd>{e.sessionId}</dd>
                          </div>
                        ) : null}
                        <div>
                          <dt>entry</dt>
                          <dd>#{e.seq}</dd>
                        </div>
                      </dl>
                    </Collapse>
                  </li>
                );
  };

  return (
    <div className="na">
      <header className="n3-title-block">
        <h1 className="n3-title">Activity</h1>
        <p className="n3-subtitle">What Next did, and what it remembers.</p>
      </header>
      <ActivityAreas mode={mode} setMode={setMode} idBase={idBase} />
      <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-actions`} tabIndex={0}>
      <section className={`na-control${paused ? ' is-paused' : ''}`} aria-live="polite">
        <div className="na-control-text">
          <p className="na-control-state">{paused ? 'Next is paused' : 'Next is on'}</p>
          <p className="na-control-line">
            {paused
              ? 'Nothing runs, not even the email check, until you turn it back on.'
              : safety?.running.length
                ? `${safety.running.length} working now: ${safety.running.map((r) => r.title).join(', ')}.`
                : 'Nothing is running. Next only starts work when you tap a button.'}
          </p>
        </div>
        <button type="button" className={`na-switch${paused ? ' is-on' : ''}`} onClick={() => void toggle()} disabled={!safety || switching}>
          {switching ? <Spinner size={14} /> : null}
          {paused ? 'Turn on' : 'Pause'}
        </button>
      </section>

      {safety ? (
        <p className={`na-seal${safety.ledger.ok ? '' : ' is-broken'}`}>
          {safety.ledger.ok ? <ShieldCheck size={15} strokeWidth={1.75} aria-hidden /> : <TriangleAlert size={15} strokeWidth={1.75} aria-hidden />}
          {safety.ledger.ok
            ? `This log can't be edited after the fact. ${safety.ledger.count} entries, checked ${clock(safety.ledger.checkedAt)}.`
            : `Something edited this log after it was written, starting at entry ${safety.ledger.brokenAt}.`}
        </p>
      ) : null}

      <div className="na-filter" role="tablist" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id || 'all'} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'is-on' : ''} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      {!entries ? (
        <p className="list-empty">
          <Shine text="Loading…" className="af-loading" />
        </p>
      ) : !entries.length ? (
        <p className="np-quiet">Nothing yet. Every email check, reply, helper, and change you make shows up here.</p>
      ) : (
        groups.map((g) => (
          <section key={g.day} className="na-day" aria-label={dayLabel(g.day, now)}>
            <h2 className="np-block-head">{dayLabel(g.day, now)}</h2>
            <ol className="na-list">
              {runsOf(g.items).map((run) => {
                if (run.length === 1) return renderEntry(run[0]);
                // AI SDK Agents' run log / run-finished toast: repeats that
                // say the same thing share one row that counts them, newest
                // first; open it to see each one.
                const head = run[0];
                const key = `run:${head.seq}`;
                const runOpen = openRun === key;
                return (
                  <li key={key} className={`na-row na-run is-${head.actor}${runOpen ? ' is-open' : ''}`}>
                    <button type="button" className="na-row-main" onClick={() => setOpenRun(runOpen ? null : key)} aria-expanded={runOpen}>
                      <span className="na-glyph" aria-hidden />
                      <span className="na-row-text">
                        <span className="na-row-who">
                          {ACTOR_WORD[head.actor] ?? head.actor}
                          <time dateTime={head.at}>{clock(head.at)}</time>
                          <span className="na-run-count">Latest of {run.length} since {clock(run[run.length - 1].at)}</span>
                        </span>
                        <span className="na-row-summary">{head.summary}</span>
                      </span>
                      <ChevronDown size={15} strokeWidth={1.75} className={runOpen ? 'is-open' : ''} />
                    </button>
                    <Collapse open={runOpen}><ol className="na-list na-run-list">{run.map((e) => renderEntry(e, true))}</ol></Collapse>
                  </li>
                );
              })}
            </ol>
          </section>
        ))
      )}
      {more ? (
        <button type="button" className="np-new-row" onClick={() => void loadMore()}>
          Show older
        </button>
      ) : null}

      {safety ? (
        <section className="na-parts">
          <button type="button" className="np-settings-toggle" aria-expanded={partsOpen} onClick={() => setPartsOpen((v) => !v)}>
            What Next can and can't do
            <span>In plain words, with who enforces each rule</span>
          </button>
          {partsOpen
            ? safety.parts.map((part) => (
                <article key={part.id} className="na-part">
                  <h3>
                    {part.name}
                    <span>{part.model}</span>
                  </h3>
                  {part.reads.length ? (
                    <p>
                      <strong>Reads</strong> {part.reads.join('; ')}
                    </p>
                  ) : null}
                  {part.can.length ? (
                    <p>
                      <strong>Can</strong> {part.can.join('; ')}
                    </p>
                  ) : null}
                  {part.never.length ? (
                    <p>
                      <strong>Never</strong> {part.never.join('; ')}
                    </p>
                  ) : null}
                  <ul className="na-enforced">
                    {part.enforcedBy.map((r) => (
                      <li key={r.rule} className={`is-${r.how}`}>
                        <span>{HOW_WORD[r.how]}</span>
                        {r.rule}
                      </li>
                    ))}
                  </ul>
                </article>
              ))
            : null}
        </section>
      ) : null}
      </div>
    </div>
  );
}

/**
 * Back-to-back entries that say the same thing (the half-hourly email check,
 * mostly) collapse into one run, so a new kind of entry is not buried under
 * twenty identical ones. Anything flagged as risky never joins a run.
 */
export function runsOf(items: LedgerEntry[]): LedgerEntry[][] {
  const runs: LedgerEntry[][] = [];
  for (const e of items) {
    const last = runs.at(-1);
    const head = last?.[0];
    const joinable = (x: LedgerEntry) => x.risk !== 'high' && !x.sessionId;
    if (head && joinable(head) && joinable(e) && head.actor === e.actor && head.summary === e.summary) last!.push(e);
    else runs.push([e]);
  }
  return runs;
}
