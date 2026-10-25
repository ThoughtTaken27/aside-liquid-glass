import { useAnimatedClose } from '../hooks/useAnimatedClose';
import { Disclosure } from './Collapse';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Brain, ChevronDown, ChevronRight, ChevronsUpDown, Clock3, ExternalLink, Globe, Info, Pause, Play, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Trash2 } from 'lucide-react';
import { api, ApiError } from '../api';
import { useBackStack } from '../utils/backStack';
import { contextChanged, contextEpoch, contextFreshness, minimumContextRevision, onContextChanged } from '../utils/contextPrivacy';
import type { ContextSource, ForgetTarget, MemoryEvent, MemoryHistory, MemoryPreferences, MemoryStatus, MemoryWindow } from '../contextTypes';
import type { NextItem, NextSpace } from '../types';
import '../theme/context.css';

const SOURCE_LABEL: Record<ContextSource, string> = { schoology: 'Schoology task status', 'work-trail': 'Existing work trail' };
const SOURCE_DETAIL: Record<ContextSource, string> = { schoology: 'Task names, dates and reported status from the existing feed.', 'work-trail': 'Allowlisted browser visits already available to Next. Timing is an estimate.' };
const time = (s: string) => new Date(s).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
const dateKey = (at: number) => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at); return ['year', 'month', 'day'].map(k => p.find(x => x.type === k)!.value).join('-'); };
const stamp = (s: string) => { const day = dateKey(Date.parse(s)); const label = day === dateKey(Date.now()) ? 'Today' : day === dateKey(Date.now() - 86_400_000) ? 'Yesterday' : new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' }); return `${label} at ${time(s)}`; };
const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
function problem(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) return 'Context changed on another screen. I refreshed it; try the change again.';
  if (e instanceof ApiError && e.status === 404) return 'This server does not have the context upgrade yet.';
  if (e instanceof ApiError && e.status === 423) return 'Next is paused. Resume it before refreshing context.';
  if (e instanceof ApiError && e.reason === 'invalid_context_settings') return 'Use a website name such as example.com, without a path or spaces.';
  return 'Could not reach or read protected context on your Mac. No new context is shown.';
}

function Confirmation({ title, description, children, action, danger = false, busy, disabled, onConfirm, onClose }: { title: string; description: string; children?: ReactNode; action: string; danger?: boolean; busy: boolean; disabled?: boolean; onConfirm: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), label = useId(), detail = useId();
  const exit = useAnimatedClose(onClose, ref);
  useEffect(() => { const d = ref.current; if (!d) return; if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); return () => { if (typeof d.close === 'function') d.close(); }; }, []);
  useBackStack([{ key: 'context-confirmation', back: () => { if (!busy) exit.close(); } }], 110);
  return <dialog ref={ref} className="nc-dialog" data-leaving={exit.leaving || undefined} inert={exit.leaving || undefined} role={danger ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={label} aria-describedby={detail} onCancel={e => { e.preventDefault(); if (!busy) exit.close(); }}>
    <h2 id={label}>{title}</h2><p id={detail}>{description}</p>{children}
    <div className="nc-dialog-actions"><button type="button" className="nc-button" autoFocus={danger} onClick={exit.close} disabled={busy}>Cancel</button><button type="button" className={`nc-button is-primary${danger ? ' is-danger' : ''}`} disabled={disabled || busy} onClick={onConfirm}>{busy ? 'Saving…' : action}</button></div>
  </dialog>;
}

function mergeWindows(a: MemoryWindow[], b: MemoryWindow[]): MemoryWindow[] {
  const windows = new Map(a.map(w => [w.id, w]));
  for (const w of b) {
    const old = windows.get(w.id);
    if (!old) { windows.set(w.id, w); continue; }
    const evidence = [...new Map([...old.evidence, ...w.evidence].map(e => [e.id, e])).values()];
    const latest = new Map<string, MemoryEvent>(); [...evidence].sort((x, y) => x.observedAt.localeCompare(y.observedAt)).forEach(e => latest.set(e.source + e.sourceId, e));
    const facts = [...latest.values()], checked = facts.filter(e => e.source === 'schoology'), activity = facts.filter(e => e.source === 'work-trail');
    const names = [...new Set(facts.map(e => e.title))];
    windows.set(w.id, { ...w, title: names.length === 1 ? names[0] : `${names.length} tasks in this window`, summary: [checked.length ? `${checked.length} tasks checked, ${checked.filter(e => e.value === 'reported-complete').length} reported complete.` : '', activity.length ? `${new Set(activity.map(e => e.sourceId)).size} matching page${new Set(activity.map(e => e.sourceId)).size === 1 ? '' : 's'} visited. Not proof of completion.` : ''].filter(Boolean).join(' '), evidence });
  }
  return [...windows.values()].sort((x, y) => y.from.localeCompare(x.from));
}

export function NextContext({ initialSpace = 'school', embedded = false }: { initialSpace?: NextSpace; embedded?: boolean }) {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [history, setHistory] = useState<MemoryHistory | null>(null);
  const [error, setError] = useState<string | null>(null), [mutationError, setMutationError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [space, setSpace] = useState(initialSpace), [day, setDay] = useState(dateKey(Date.now()));
  const [source, setSource] = useState<ContextSource | ''>(''), [query, setQuery] = useState(''), [searchQuery, setSearchQuery] = useState('');
  const [windowSize, setWindowSize] = useState<'ten-minutes' | 'six-hours'>('ten-minutes');
  const [setup, setSetup] = useState<ContextSource[] | null>(null), [forget, setForget] = useState<ForgetTarget | null>(null), [retention, setRetention] = useState<7 | 14 | 30 | null>(null);
  const [excluded, setExcluded] = useState(''), [exclusion, setExclusion] = useState<string | null>(null);
  const requestSeq = useRef(0), mounted = useRef(true), busyRef = useRef(false), lastRead = useRef(0), controller = useRef<AbortController | null>(null);
  const invalidate = useCallback(() => { controller.current?.abort(); requestSeq.current += 1; setHistory(null); setStatus(null); setSetup(null); setForget(null); setRetention(null); setExclusion(null); setExcluded(''); setError('Context is hidden while this screen is offline or not in view. Reconnect to your Mac to view it.'); setLoading(false); }, []);
  const options = useCallback((offset = 0) => ({ space, ...(searchQuery ? { q: searchQuery } : day !== 'all' ? { day } : {}), ...(source ? { source } : {}), offset, limit: 40, window: windowSize }), [space, searchQuery, day, source, windowSize]);
  const load = useCallback(async () => {
    if (document.visibilityState === 'hidden' || navigator.onLine === false || busyRef.current) return;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const timeout = window.setTimeout(() => abort.abort(), 15_000);
    const sequence = ++requestSeq.current, epoch = contextEpoch();
    setLoading(true);
    try {
      const [s, h] = await Promise.all([api.nextContextStatus(abort.signal), api.nextContextHistory(options(), abort.signal)]);
      if (!mounted.current || sequence !== requestSeq.current || epoch !== contextEpoch()) return;
      if (s.revision !== h.revision || s.revision < minimumContextRevision()) { setHistory(null); setStatus(null); setError('Context changed while loading. Refresh to see the current version.'); return; }
      lastRead.current = Date.now(); setStatus(s); setHistory(h); setError(null);
    } catch (e) { if (mounted.current && sequence === requestSeq.current) { setHistory(null); setStatus(null); setError(problem(e)); } }
    finally { window.clearTimeout(timeout); if (mounted.current && sequence === requestSeq.current) setLoading(false); }
  }, [options]);
  useEffect(() => { const t = window.setTimeout(() => setSearchQuery(query.trim()), 150); return () => window.clearTimeout(t); }, [query]);
  useEffect(() => { mounted.current = true; void load(); const interval = window.setInterval(() => void load(), 15_000); const privacyLease = window.setInterval(() => { if (lastRead.current && Date.now() - lastRead.current > 30_000) { lastRead.current = 0; invalidate(); } }, 1000); const wake = () => document.visibilityState === 'hidden' ? invalidate() : void load(); const offline = () => invalidate(); const online = () => void load(); const unsubscribe = onContextChanged(() => { controller.current?.abort(); requestSeq.current += 1; setHistory(null); setStatus(null); setSetup(null); setForget(null); setRetention(null); setExclusion(null); setExcluded(''); if (!busyRef.current) void load(); }); document.addEventListener('visibilitychange', wake); window.addEventListener('offline', offline); window.addEventListener('online', online); return () => { mounted.current = false; requestSeq.current += 1; window.clearInterval(interval); window.clearInterval(privacyLease); controller.current?.abort(); unsubscribe(); document.removeEventListener('visibilitychange', wake); window.removeEventListener('offline', offline); window.removeEventListener('online', online); }; }, [load, invalidate]);

  const mutation = async (action: () => Promise<MemoryStatus>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setMutationError(null); controller.current?.abort(); requestSeq.current += 1; setHistory(null);
    try { const s = await action(); if (!mounted.current) return; contextChanged(s.revision); if (s.revision >= minimumContextRevision()) setStatus(s); setSetup(null); setForget(null); setRetention(null); setExclusion(null); setExcluded(''); setError(null); }
    catch (e) { if (mounted.current) { setMutationError(problem(e)); setSetup(null); setForget(null); setRetention(null); setExclusion(null); } }
    finally { busyRef.current = false; if (mounted.current) { setBusy(false); await load(); } }
  };
  const save = (p: MemoryPreferences, acknowledgement?: string, retentionAcknowledgement?: string, exclusionAcknowledgement?: string) => status && void mutation(() => exclusionAcknowledgement ? api.nextContextSettings(p, status.revision, acknowledgement, retentionAcknowledgement, exclusionAcknowledgement) : api.nextContextSettings(p, status.revision, acknowledgement, retentionAcknowledgement));
  const toggle = () => { if (!status) return; if (status.preferences.enabled) save({ ...status.preferences, enabled: false, pausedUntil: null }); else setSetup([...status.preferences.sources]); };
  const toggleSource = (id: ContextSource) => { if (!status) return; const selected = status.preferences.sources; if (!selected.includes(id)) setSetup([...selected, id]); else { const sources = selected.filter(s => s !== id); save({ ...status.preferences, sources, enabled: sources.length > 0 }); } };
  const refresh = () => void mutation(() => api.nextContextRefresh());
  const more = async () => {
    if (!history || busyRef.current) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort; const timeout = window.setTimeout(() => abort.abort(), 15_000);
    const sequence = ++requestSeq.current, epoch = contextEpoch(); setBusy(true); busyRef.current = true;
    try { const h = await api.nextContextHistory(options(history.events.length), abort.signal); if (!mounted.current || sequence !== requestSeq.current || epoch !== contextEpoch()) return; if (h.revision !== history.revision) { setHistory(null); setError('History changed. Refresh before loading older facts.'); return; } setHistory({ ...h, events: [...history.events, ...h.events], windows: mergeWindows(history.windows, h.windows) }); }
    catch (e) { if (mounted.current) { setHistory(null); setError(problem(e)); } }
    finally { window.clearTimeout(timeout); busyRef.current = false; if (mounted.current) { setBusy(false); if (epoch !== contextEpoch()) void load(); } }
  };
  const days = Array.from({ length: status?.preferences.retentionDays ?? 14 }, (_, i) => ({ key: dateKey(Date.now() - i * 86_400_000), label: i === 0 ? 'Today' : i === 1 ? 'Yesterday' : new Date(Date.now() - i * 86_400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' }) }));
  const pauseValue = status?.state === 'paused' ? status.preferences.pausedUntil === 'until-resumed' ? 'forever' : 'paused' : '';
  const forgetLabel = forget?.kind === 'all' ? 'all saved context' : forget?.kind === 'ten-minutes' ? 'the last 10 minutes' : forget?.kind === 'hour' ? 'the last hour' : forget?.kind === 'today' ? 'today’s context' : forget?.kind === 'source' ? SOURCE_LABEL[forget.source] : 'this task’s saved context';

  const stateTitle = !status ? '' : status.state === 'off' ? 'Context memory is off' : status.nextPaused ? 'Next is paused' : status.state === 'paused' ? 'Remembering is paused' : 'On, encrypted on this Mac';
  const stateDetail = !status ? '' : status.state === 'off' ? 'No new facts are stored. Existing history stays.' : status.nextPaused ? 'Resume Next in Actions. Saved history stays.' : status.state === 'paused' ? status.preferences.pausedUntil === 'until-resumed' ? 'Paused until you choose Resume.' : `Paused until ${time(status.preferences.pausedUntil!)}.` : 'Remembers task facts and matching activity.';
  const dayLabel = searchQuery ? 'All days' : day === 'all' ? 'All days' : days.find(d => d.key === day)?.label ?? 'Today';
  const sourceLabel = source === 'schoology' ? 'Task status' : source === 'work-trail' ? 'Work trail' : 'All sources';
  const sourcesOn = status?.preferences.sources.length ?? 0;

  return <section className="nc" aria-label="Context awareness">
    {embedded ? <h2 className="nc-visually-hidden">Context</h2> : <header className="nc-heading"><h2>Context</h2><p>Remember useful facts. Keep control of the details.</p></header>}
    {mutationError || error ? <div className="nc-notice" role="alert">
      <span className="nc-tile is-quiet"><ShieldCheck size={17} aria-hidden /></span>
      <div><p>{mutationError ?? error}</p><button type="button" className="nc-link" onClick={() => { setMutationError(null); void load(); }} disabled={busy}>Try again</button></div>
    </div> : null}
    {!status && !error ? <div className="nc-group nc-loading" role="status"><span className="nc-skeleton" /><span className="nc-skeleton is-short" /><span className="nc-visually-hidden">Loading context controls…</span></div> : null}

    {status ? <>
      <section className={`nc-block${status.state === 'paused' || status.nextPaused ? ' is-paused' : ''}`} aria-label="Context controls">
        <div className="nc-group">
          <div className="nc-row nc-row-hero">
            <span className={`nc-tile${status.state === 'ready' && !status.nextPaused ? ' is-live' : ''}`}><Brain size={18} aria-hidden /></span>
            <div className="nc-row-text"><span className="nc-row-title">Remember context</span><h3 className="nc-row-sub">{stateTitle}</h3></div>
            <button type="button" className="nc-switch" role="switch" aria-label="Use context memory" aria-checked={status.preferences.enabled} onClick={toggle} disabled={busy}><span aria-hidden /></button>
          </div>
          {status.preferences.enabled ? status.state === 'paused' ? <button type="button" className="nc-row nc-row-action" disabled={busy || status.nextPaused} onClick={() => save({ ...status.preferences, pausedUntil: null })}>
            <span className="nc-tile is-quiet"><Play size={16} aria-hidden /></span><span className="nc-row-title">Resume</span>
          </button> : <label className="nc-row nc-menu">
            <span className="nc-tile is-quiet"><Pause size={16} aria-hidden /></span><span className="nc-row-title">Pause remembering</span>
            <span className="nc-row-value">Off</span><ChevronsUpDown size={15} className="nc-row-chevron" aria-hidden />
            <select aria-label="Pause remembering" value={pauseValue} disabled={busy || status.nextPaused} onChange={e => { const v = e.target.value; if (v) save({ ...status.preferences, pausedUntil: v === 'forever' ? 'until-resumed' : new Date(Date.now() + Number(v) * 60_000).toISOString() }); }}><option value="">Off</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="forever">Until I resume</option></select>
          </label> : null}
          {status.preferences.enabled ? <button type="button" className="nc-row nc-row-action" aria-label="Refresh existing context sources" disabled={busy || status.nextPaused || status.state !== 'ready'} onClick={refresh}>
            <span className="nc-tile is-quiet"><RefreshCw size={16} className={busy ? 'nc-spin' : ''} aria-hidden /></span><span className="nc-row-title">Check sources now</span>
          </button> : null}
        </div>
        <p className="nc-footer">{stateDetail}</p>
      </section>

      <Disclosure className="nc-block nc-settings">
        <summary className="nc-group nc-row">
          <span className="nc-tile is-quiet"><SlidersHorizontal size={16} aria-hidden /></span>
          <span className="nc-row-title">Sources and privacy</span>
          <span className="nc-row-value">{sourcesOn} on, {status.preferences.retentionDays} days</span><ChevronRight size={16} className="nc-row-chevron nc-disclose" aria-hidden />
        </summary>
        <div className="nc-settings-body">
          <h3 className="nc-header">Sources</h3>
          <div className="nc-group">
            {(['schoology', 'work-trail'] as ContextSource[]).map(id => { const seen = status.sources.find(s => s.id === id)?.lastObservedAt; return <div className="nc-row nc-row-tall" key={id}>
              <span className="nc-tile is-quiet">{id === 'schoology' ? <BookOpen size={16} aria-hidden /> : <Globe size={16} aria-hidden />}</span>
              <div className="nc-row-text"><h3 className="nc-row-title">{SOURCE_LABEL[id]}</h3><p className="nc-row-sub">{SOURCE_DETAIL[id]}</p><small className="nc-row-meta">{seen ? `Last observed ${stamp(seen)}` : 'No saved observations yet'}</small></div>
              <button type="button" className="nc-switch" role="switch" aria-label={`Use ${SOURCE_LABEL[id]}`} aria-checked={status.preferences.sources.includes(id)} disabled={busy || !status.preferences.enabled} onClick={() => toggleSource(id)}><span aria-hidden /></button>
            </div>; })}
          </div>
          <p className="nc-footer">Only facts Next already has. No new page text, typed text, screenshots or app capture.</p>

          <h3 className="nc-header">Retention</h3>
          <div className="nc-group">
            <label className="nc-row nc-menu">
              <span className="nc-row-title">Keep facts for</span><span className="nc-row-value">{status.preferences.retentionDays} days</span><ChevronsUpDown size={15} className="nc-row-chevron" aria-hidden />
              <select aria-label="Context retention" value={status.preferences.retentionDays} disabled={busy} onChange={e => { const n = Number(e.target.value) as 7 | 14 | 30; if (n < status.preferences.retentionDays) setRetention(n); else save({ ...status.preferences, retentionDays: n }); }}><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select>
            </label>
            <div className="nc-row"><span className="nc-row-title">Storage used</span><span className="nc-row-value nc-num">{bytes(status.storageBytes)}{status.averageDailyBytes !== null ? `, about ${bytes(status.averageDailyBytes)} a day` : ''}</span></div>
          </div>
          <p className="nc-footer">Facts, document links and summaries expire together.{status.capped ? ' Storage cap reached; oldest facts expired.' : ''}</p>

          <h3 className="nc-header">Never include</h3>
          <div className="nc-group">
            {status.preferences.excludedHosts.map(h => <div className="nc-row" key={h}><span className="nc-tile is-quiet"><Globe size={16} aria-hidden /></span><span className="nc-row-title nc-host">{h}</span><button type="button" className="nc-link is-danger" aria-label={`Remove ${h} exclusion`} disabled={busy} onClick={() => save({ ...status.preferences, excludedHosts: status.preferences.excludedHosts.filter(x => x !== h) })}>Remove</button></div>)}
            <form className="nc-row nc-add" onSubmit={e => { e.preventDefault(); const h = excluded.trim().toLowerCase(); if (!h || status.preferences.excludedHosts.includes(h)) return; setExclusion(h); }}>
              <span className="nc-tile is-quiet"><Plus size={16} aria-hidden /></span>
              <input aria-label="Website to exclude" placeholder="Add a website" autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode="url" value={excluded} onChange={e => setExcluded(e.target.value)} maxLength={253} disabled={busy} />
              <button className="nc-pill" type="submit" disabled={busy || !excluded.trim()}>Exclude</button>
            </form>
          </div>
          <p className="nc-footer">Stops new observations and removes saved facts and document links for the site and its subdomains.</p>

          <Disclosure className="nc-group nc-processing">
            <summary className="nc-row"><span className="nc-tile is-quiet"><Info size={16} aria-hidden /></span><span className="nc-row-title">What is and isn’t collected</span><ChevronRight size={16} className="nc-row-chevron nc-disclose" aria-hidden /></summary>
            <div className="nc-prose"><p>Only selected structured task facts and existing allowlisted visit estimates enter this memory. No new page text, typed text, screenshots, OCR or native-app capture is implemented here. Personal email is excluded.</p><p>Summaries and search use local rules, not an AI model or cloud service. This is factual and keyword recall, not rich semantic memory.</p><p>The stored journal is encrypted with a private key on this Mac. That does not protect against someone controlling the Mac, root, malware or backups.</p></div>
          </Disclosure>
        </div>
      </Disclosure>
    </> : null}

    <section className="nc-block nc-history" aria-label="Context history">
      <div className="nc-history-head">
        <h3>History</h3>
        <label className="nc-pulldown"><span>{space === 'school' ? 'School' : 'Personal'}</span><ChevronDown size={14} aria-hidden /><select aria-label="History space" value={space} onChange={e => setSpace(e.target.value as NextSpace)} disabled={busy}><option value="school">School</option><option value="personal">Personal</option></select></label>
      </div>
      <label className="nc-search"><Search size={16} aria-hidden /><input type="search" aria-label="Search context history" placeholder="Search saved facts" value={query} onChange={e => setQuery(e.target.value)} maxLength={200} autoComplete="off" disabled={!status} /></label>
      <div className="nc-chips">
        <label className={`nc-chip${day !== dateKey(Date.now()) || searchQuery ? ' is-set' : ''}`}><span>{dayLabel}</span><ChevronDown size={13} aria-hidden /><select aria-label="History day" value={searchQuery ? 'all' : day} disabled={busy || Boolean(searchQuery) || !status} onChange={e => setDay(e.target.value)}><option value="all">All days</option>{days.map(d => <option value={d.key} key={d.key}>{d.label}</option>)}</select></label>
        <label className={`nc-chip${source ? ' is-set' : ''}`}><span>{sourceLabel}</span><ChevronDown size={13} aria-hidden /><select aria-label="History source" value={source} disabled={busy || !status} onChange={e => setSource(e.target.value as ContextSource | '')}><option value="">All sources</option><option value="schoology">Task status</option><option value="work-trail">Work trail</option></select></label>
        <label className={`nc-chip${windowSize === 'six-hours' ? ' is-set' : ''}`}><span>{windowSize === 'ten-minutes' ? 'Every 10 min' : 'Every 6 hours'}</span><ChevronDown size={13} aria-hidden /><select aria-label="Summary window" value={windowSize} disabled={busy || !status} onChange={e => setWindowSize(e.target.value as 'ten-minutes' | 'six-hours')}><option value="ten-minutes">Every 10 min</option><option value="six-hours">Every 6 hours</option></select></label>
      </div>
      {loading && !history ? <div className="nc-group nc-loading" role="status"><span className="nc-skeleton" /><span className="nc-skeleton is-short" /><span className="nc-visually-hidden">Loading saved facts…</span></div> : history?.windows.length ? <>
        <p className="nc-result-meta">{history.events.length === history.total ? `${history.total} ${history.total === 1 ? 'fact' : 'facts'}` : `${history.events.length} of ${history.total} facts`}{history.queryKind === 'lexical' ? ' matching keywords' : ''}, Chicago time</p>
        <ol className="nc-group nc-timeline">{history.windows.map(w => <li key={w.id}><Disclosure className="nc-window">
          <summary className="nc-row nc-row-tall">
            <time dateTime={w.from}>{(searchQuery || day === 'all') ? <span className="nc-history-date">{new Date(w.from).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' })}</span> : null}{time(w.from)}</time>
            <div className="nc-row-text"><h4 className="nc-row-title">{w.title}</h4><p className="nc-row-sub">{w.summary}</p></div>
            <ChevronRight size={16} className="nc-row-chevron nc-disclose" aria-hidden />
          </summary>
          <ul className="nc-facts">{w.evidence.map(e => { const f = contextFreshness(e); return <li key={e.id}>
            <div className="nc-fact-text">
              <span className={`nc-fresh is-${f}`}>{f === 'fresh' ? 'Recent' : f === 'stale' ? 'Stale' : 'Unknown time'}</span>
              <h5>{e.title}</h5>
              <p>{e.kind === 'source-status' ? e.value === 'reported-complete' ? 'Feed reported complete' : 'Feed reported open' : `About ${e.minutes} min of matching browser activity`}</p>
              <small>{SOURCE_LABEL[e.source]} · {stamp(e.observedAt)}</small>
              {e.url ? <a href={e.url} target="_blank" rel="noopener noreferrer" className="nc-link">View original source <ExternalLink size={13} aria-hidden /></a> : null}
            </div>
            <button type="button" className="nc-icon" aria-label={`Forget saved context for ${e.title}`} disabled={busy} onClick={() => setForget({ kind: 'item', taskId: e.taskId })}><Trash2 size={16} aria-hidden /></button>
          </li>; })}</ul>
        </Disclosure></li>)}</ol>
        {history.more ? <button type="button" className="nc-group nc-row nc-row-action nc-more" disabled={busy} onClick={() => void more()}><span className="nc-row-title">{busy ? 'Loading…' : 'Show older facts'}</span></button> : null}
      </> : history && !error ? <div className="nc-group nc-empty">
        <span className="nc-tile is-quiet is-large"><Clock3 size={22} aria-hidden /></span>
        <h4>{searchQuery ? 'No matching facts' : status && status.count > 0 ? day !== 'all' ? 'Nothing on this day yet' : 'No facts in this view' : status?.documentCount ? 'No observed facts yet' : 'Nothing remembered here yet'}</h4>
        <p>{searchQuery ? 'Try a task name or change the source filter; search only covers saved facts.' : status && status.count > 0 ? 'Try another day, source or space. Facts outside this view have not been removed.' : status?.state === 'off' ? 'Choose sources above to start remembering useful task facts.' : 'Refresh the selected sources, or choose another day or space.'}</p>
        {searchQuery ? <button type="button" className="nc-pill" onClick={() => { setQuery(''); setSearchQuery(''); }}>Clear search</button> : status && status.count > 0 && day !== 'all' ? <button type="button" className="nc-pill" onClick={() => setDay('all')}>Show all days</button> : status?.state === 'ready' && !status.nextPaused ? <button type="button" className="nc-pill" disabled={busy} onClick={refresh}>Refresh sources</button> : status?.state === 'off' ? <button type="button" className="nc-pill" onClick={() => setSetup([...status.preferences.sources])}>Choose sources</button> : null}
      </div> : null}
    </section>

    {status ? <section className="nc-block" aria-label="Forget context">
      <div className="nc-group">
        <label className="nc-row nc-menu is-danger">
          <span className="nc-row-title">Forget context…</span><ChevronsUpDown size={15} className="nc-row-chevron" aria-hidden />
          <select aria-label="Forget context scope" value="" disabled={busy || (status.count === 0 && !status.documentCount)} onChange={e => { const v = e.target.value; if (v.startsWith('source:')) setForget({ kind: 'source', source: v.slice(7) as ContextSource }); else if (v) setForget({ kind: v as 'all' | 'ten-minutes' | 'hour' | 'today' }); }}><option value="">Forget…</option><option value="ten-minutes">Last 10 minutes</option><option value="hour">Last hour</option><option value="today">Today</option><option value="all">All saved context</option><option value="source:schoology">Schoology facts</option><option value="source:work-trail">Work-trail facts</option></select>
        </label>
      </div>
      <p className="nc-footer">Original tasks and documents stay untouched.</p>
    </section> : null}
    {setup !== null && status ? <Confirmation title="Choose what Next remembers" description="Use existing structured sources for local memory and planning. This does not enable new activity capture or send anything to a model." action="Start remembering" busy={busy} disabled={!setup.length} onClose={() => setSetup(null)} onConfirm={() => save({ ...status.preferences, enabled: true, sources: setup, pausedUntil: null }, 'local-structured-context-v1')}>{(['schoology', 'work-trail'] as ContextSource[]).map(id => <label className="nc-consent-source" key={id}><input type="checkbox" checked={setup.includes(id)} onChange={e => setSetup(s => e.target.checked ? [...(s ?? []), id] : (s ?? []).filter(x => x !== id))} /><span><strong>{SOURCE_LABEL[id]}</strong><small>{SOURCE_DETAIL[id]}</small></span></label>)}</Confirmation> : null}
    {forget && status ? <Confirmation title={`Forget ${forgetLabel}?`} description={'Permanently removes matching facts, document links and derived summaries from Next’s current storage. It does not delete original tasks/documents or erase backups, exports or anything already shared.' + (forget.kind === 'item' ? '' : ' This scope includes both School and Personal context. History filters do not narrow it.')}  action="Forget" danger busy={busy} onClose={() => setForget(null)} onConfirm={() => void mutation(() => api.nextContextForget(forget, status.revision))} /> : null}
    {exclusion && status ? <Confirmation title={`Exclude ${exclusion}?`} description="Stops new observations and permanently removes matching stored facts and document links for this site and its subdomains, across both School and Personal. Original tasks and documents stay untouched; removing the exclusion later cannot restore deleted facts." action="Exclude website" danger busy={busy} onClose={() => setExclusion(null)} onConfirm={() => save({ ...status.preferences, excludedHosts: [...status.preferences.excludedHosts, exclusion] }, undefined, undefined, 'exclude-context-site-v1')} /> : null}
    {retention && status ? <Confirmation title={`Keep only ${retention} days?`} description="Older saved facts, document links and their summaries will be removed from Next. Increasing the limit later cannot restore them." action="Change retention" danger busy={busy} onClose={() => setRetention(null)} onConfirm={() => save({ ...status.preferences, retentionDays: retention }, undefined, 'shorten-context-retention-v1')} /> : null}
  </section>;
}

export function ContextEvidence({ item }: { item: NextItem }) {
  const evidence = item.evidence;
  if (!evidence?.records.length || evidence.revision < minimumContextRevision()) return null;
  return <Disclosure className="nc-evidence"><summary><ShieldCheck size={15} aria-hidden /><span>Why this task?</span><ChevronDown size={15} aria-hidden /></summary><p>{evidence.influence === 'equal-priority-resume' ? 'Recent activity on this exact task broke an equal-priority tie. It never outranks a more urgent deadline.' : 'These observations explain what Next knows, not whether you finished the work.'}</p><ul>{evidence.records.map(r => <li key={r.source + r.sourceId}><strong>{SOURCE_LABEL[r.source]}</strong><span>{r.kind === 'source-status' ? r.value === 'reported-complete' ? 'Feed reported complete' : 'Feed reported open' : `About ${r.minutes} min of matching browser activity`}</span><small>{r.observedAt ? `Observed ${stamp(r.observedAt)}; ${contextFreshness(r) === 'fresh' ? 'within freshness window' : contextFreshness(r) === 'stale' ? 'stale, check the source' : 'time unverified; freshness unknown'}` : 'No verified check time; freshness unknown'}</small></li>)}</ul></Disclosure>;
}

export { Confirmation as ContextConfirmation };
