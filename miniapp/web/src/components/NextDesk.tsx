import { Shine } from './Affect';
/**
 * Next on the Mac: a to-do list meant to live in a pinned Aside tab.
 *
 * Layout after Calesto (lists on the left, the day in the middle, one
 * inspector on the right) in Next's own materials: pearl, ink, hairlines,
 * clay only on a real deadline, one serif line (the Now title).
 *
 * Nothing here runs by itself. Every helper, lookup, and change starts from
 * a click or a key you press, and the inspector says what a helper will and
 * won't do before you start it.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, CalendarDays, Clock3, EyeOff, FolderOpen, Inbox, Lock, Mail, Search as SearchIcon, ShieldCheck, Sparkles, SunMedium, X as XIcon } from 'lucide-react';
import { api } from '../api';
import { Spinner } from './Icons';
import { ToastHost, toast } from './Toasts';
import { CheckCircle, ProgressRing, dueTone, isPlanned, whenText } from './NextToday';
import { laterChoices } from './NextItemSheet';
import { ResearchView, ReportSheet } from './NextResearch';
import { ProjectDetail, ProjectsList, NewProjectSheet } from './NextProjects';
import { ActivityTab } from './NextActivity';
import { ContextEvidence } from './NextContext';
import { DocumentLinkControl } from './NextDocument';
import { formatMinutes, senderLine, stamp } from '../utils/nextFormat';
import { HEALTH_WORD, hm } from '../utils/nextPlanFormat';
import { openUrl } from '../utils/openUrl';
import type { NextItem, NextProject, NextSpace, ResearchBrief } from '../types';
import { otherSpace, scopePlan, spaceLabel, spaceSummary, useSpace } from '../utils/nextSpace';
import { SpaceGlyph, SpaceSwitch } from './NextSpace';
import { NextBoundary } from './NextBoundary';
import { useLivePlan } from '../hooks/useLivePlan';
import { parseQuickAdd } from '../utils/quickAdd';
import { useSpaceHint } from '../hooks/useSpaceHint';
import { alsoLine, doneHintLine, estLabel, flagLine } from '../utils/jevMarks';
export { parseQuickAdd };

type View = 'today' | 'upcoming' | 'gmail' | 'projects' | 'research' | 'activity';

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
/** Tasks you typed yourself get "Remove"; everything Next found gets "Not for me". */
const skipLabel = (it: NextItem) => (it.source === 'manual' ? 'Remove' : 'Not for me');
type Leaving = 'done' | 'gone';

// --------------------------------------------------------------------------

export function NextDesk() {
  const { plan: rawPlan, setPlan, load, state: liveState, savedAt, error } = useLivePlan();
  const [space, setSpaceRaw] = useSpace();
  const [switched, setSwitched] = useState(false);
  // Everything below sees one space only. The server ranks once; this cuts.
  const plan = useMemo(() => (rawPlan ? scopePlan(rawPlan, space) : null), [rawPlan, space]);
  const summary = useMemo(
    () => (rawPlan ? { school: spaceSummary(rawPlan, 'school'), personal: spaceSummary(rawPlan, 'personal') } : undefined),
    [rawPlan],
  );
  const [view, setView] = useState<View>('today');
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState('');
  // The typed title can pick School or Personal; the sidebar space is the fallback.
  const qHint = useSpaceHint(q.trim() ? parseQuickAdd(q).title : '', true);
  const [qPick, setQPick] = useState<NextSpace | null>(null);
  useEffect(() => {
    if (!q.trim()) setQPick(null);
  }, [q]);
  const addSpace = qPick ?? qHint ?? space;
  const [busy, setBusy] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<Record<string, Leaving | undefined>>({});
  const [projects, setProjects] = useState<NextProject[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [newProject, setNewProject] = useState(false);
  const [report, setReport] = useState<ResearchBrief | null>(null);
  const [researchKey, setResearchKey] = useState(0);
  const [helperModel, setHelperModel] = useState<string | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const bar = useRef<HTMLInputElement>(null);
  const closeDetail = useRef<HTMLButtonElement>(null);
  // One selection surface that glides between lists (Arc morph select, Planes segmented control).
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ y: number; h: number; ready: boolean } | null>(null);

  useEffect(() => {
    void api.nextSafety().then((s) => setHelperModel(s.parts.find((p) => p.id === 'helper')?.model ?? null)).catch(() => {});
  }, []);

  useEffect(() => {
    if (view === 'projects' && !projectId) void api.nextProjects().then((r) => setProjects(r.projects)).catch(() => setProjects((p) => p ?? []));
  }, [view, projectId]);

  const now = new Date();
  const all = useMemo<NextItem[]>(
    () => (plan ? ([plan.now, ...plan.next, ...plan.later, ...plan.unsure, ...plan.withAside, ...(plan.review ?? [])].filter(Boolean) as NextItem[]) : []),
    [plan],
  );
  const item = sel ? all.find((it) => it.id === sel) ?? null : null;
  useEffect(() => {
    if (item) closeDetail.current?.focus({ preventScroll: true });
  }, [item?.id]);

  // Groups for the Today view, same rules as the phone.
  const groups = useMemo(() => {
    if (!plan) return [];
    const n = new Date();
    const later = plan.later;
    const dueToday = later.filter((it) => it.dueISO && !isPlanned(it) && new Date(it.dueISO).toDateString() === n.toDateString());
    const week = later.filter((it) => !dueToday.includes(it) && it.dueISO && new Date(it.dueISO).getTime() - n.getTime() < 7 * 86_400_000);
    const rest = later.filter((it) => !dueToday.includes(it) && !week.includes(it));
    return [
      { id: 'next', title: 'Up next', items: plan.next },
      { id: 'today', title: 'Also due today', items: dueToday },
      { id: 'week', title: 'This week', items: week },
      { id: 'unsure', title: 'Is this yours?', items: plan.unsure },
      { id: 'later', title: 'Later', items: rest },
    ].filter((g) => g.items.length);
  }, [plan]);

  // Upcoming: everything with a date, by day (Calesto / Things "Upcoming").
  const upcoming = useMemo(() => {
    const dated = all.filter((it) => it.dueISO && !it.trial && it.status === 'open').sort((a, b) => Date.parse(a.dueISO!) - Date.parse(b.dueISO!));
    const byDay = new Map<string, NextItem[]>();
    for (const it of dated) {
      const k = new Date(it.dueISO!).toDateString();
      byDay.set(k, [...(byDay.get(k) ?? []), it]);
    }
    return [...byDay.entries()].map(([k, items]) => ({ id: k, title: dayTitle(new Date(k), new Date()), items }));
  }, [all]);

  // The day at a glance: how many, how long, how many late.
  const todayStats = useMemo(() => {
    if (!plan) return null;
    const items = [plan.now, ...plan.next, ...(groups.find((g) => g.id === 'today')?.items ?? [])].filter(Boolean) as NextItem[];
    const t = new Date();
    return { n: items.length, mins: items.reduce((sum, it) => sum + (it.estMinutes ?? 0), 0), late: items.filter((it) => dueTone(it, t) === 'late').length };
  }, [plan, groups]);

  const match = (it: NextItem) => !q.trim() || `${it.title} ${it.context}`.toLowerCase().includes(q.trim().toLowerCase());
  const visible: NextItem[] =
    view === 'today' ? [...(plan?.now ? [plan.now] : []), ...groups.flatMap((g) => g.items)].filter(match)
    : view === 'upcoming' ? upcoming.flatMap((g) => g.items).filter(match)
    : view === 'gmail' ? (plan?.review ?? []).filter(match)
    : [];

  const act = async (it: NextItem, action: Parameters<typeof api.nextAction>[1], message?: string, undo = false) => {
    try {
      setPlan(await api.nextAction(it.id, action));
      if (message) toast(message, undo ? { action: { label: 'Undo', onClick: () => void act(it, { type: 'reopen' }) } } : {});
    } catch {
      toast('That did not save. Try again.', { tone: 'error' });
    }
  };

  // The row after this one, so keyboard triage can keep going without a click.
  const after = (it: NextItem): string | null => {
    const i = visible.findIndex((v) => v.id === it.id);
    return i < 0 ? null : (visible[i + 1] ?? visible[i - 1])?.id ?? null;
  };
  // Folds the row away, then saves. `then` picks what is selected next (keys only).
  const leave = (it: NextItem, how: Leaving, save: () => Promise<void>, then: string | null = null) => {
    setLeaving((l) => ({ ...l, [it.id]: how }));
    setSel((s) => (s === it.id ? then : s));
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(() => void save().finally(() => setLeaving((l) => ({ ...l, [it.id]: undefined }))), reduce ? 0 : how === 'done' ? 320 : 180);
  };
  const done = (it: NextItem, then: string | null = null) => leave(it, 'done', () => act(it, { type: 'done' }, `Done: ${it.title}`, true), then);
  /** Hides it for good (Undo in the toast). Never contacts anyone. */
  const notMine = (it: NextItem, then: string | null = null) =>
    leave(it, 'gone', () => act(it, { type: 'dismiss' }, `${it.source === 'manual' ? 'Removed' : 'Hidden'}: ${it.title}`, true), then);
  const later = (it: NextItem, until?: Date, label = 'tomorrow', then: string | null = null) => {
    const d = until ?? laterChoices(new Date()).find((c) => c.label === 'Tomorrow')!.until;
    leave(it, 'gone', () => act(it, { type: 'snooze', until: d.toISOString() }, `Back ${label.toLowerCase()}: ${it.title}`, true), then);
  };

  /** Only ever from a click on Start helper. */
  const help = async (it: NextItem) => {
    setBusy('help');
    try {
      const res = await api.nextStartWhenReady(it.id);
      setPlan(res.plan);
      toast(res.sessionId ? 'Started because you clicked. It stops before submitting anything.' : `Queued because you clicked. A locked helper is getting ready${res.readyInMin ? `, about ${res.readyInMin} min` : ''}.`);
    } catch {
      toast('Could not start it. Try again.', { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  const research = async (it: NextItem) => {
    setBusy('research');
    try {
      await api.researchStart({ itemId: it.id });
      await load();
      setResearchKey((k) => k + 1);
      toast('Looking into it because you clicked. The answer shows up in Research.');
    } catch {
      toast('Could not start that. Try again.', { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const setSpace = (s: NextSpace) => {
    if (s === space) return;
    setSwitched(true);
    setSpaceRaw(s);
    setSel(null);
    setProjectId(null);
    // From Gmail is a Personal list; School has no counterpart.
    if (s === 'school' && view === 'gmail') setView('today');
  };
  const moveTask = async (it: NextItem, to: NextSpace) => {
    try {
      setPlan(await api.nextMoveTask(it.id.replace(/^manual:/, ''), to));
      setSel(null);
      toast(`Moved to ${spaceLabel(to)}`, { action: { label: 'Show', onClick: () => setSpace(to) } });
    } catch {
      toast('Could not move it. Try again.', { tone: 'error' });
    }
  };

  const add = async () => {
    const p = parseQuickAdd(q);
    if (!p.title) return;
    try {
      setPlan(await api.nextAddTask({ title: p.title, due: p.due, estMinutes: p.estMinutes, space: addSpace }));
      setQ('');
      toast(`Added to ${spaceLabel(addSpace)}: ${p.title}${p.dueLabel ? `, ${p.dueLabel.toLowerCase()}` : ''}`);
    } catch {
      toast('Could not add it. Try again.', { tone: 'error' });
    }
  };

  // Keyboard: ⌘K or / to the bar, j/k or arrows to move, x done, l later,
  // n not for me, o open, Esc clears. After x, l, or n the next row is
  // selected, so a list can be cleared from the keyboard. Keys never start a
  // helper; that stays a click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA';
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        bar.current?.focus();
        return;
      }
      if (typing) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        bar.current?.focus();
        return;
      }
      if (e.key === '?') return setKeysOpen((o) => !o);
      if (e.key === 'Escape') {
        setKeysOpen(false);
        return setSel(null);
      }
      if (e.key === '1' || e.key === '2') return setSpace(e.key === '1' ? 'school' : 'personal');
      const idx = visible.findIndex((it) => it.id === sel);
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        const n = visible[Math.min(visible.length - 1, idx + 1)];
        if (n) setSel(n.id);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = visible[Math.max(0, idx - 1)];
        if (n) setSel(n.id);
      } else if (item && e.key === 'x') done(item, after(item));
      else if (item && e.key === 'l') later(item, undefined, 'tomorrow', after(item));
      else if (item && (e.key === 'n' || e.key === 'Backspace' || e.key === 'Delete') && visible.includes(item)) {
        e.preventDefault();
        notMine(item, after(item));
      } else if (item && e.key === 'o' && item.url) void openUrl(item.url);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const go = (v: View) => {
    setView(v);
    setSel(null);
    setProjectId(null);
  };

  const counts = {
    today: plan ? [plan.now, ...plan.next].filter(Boolean).length + groups.filter((g) => g.id === 'today').reduce((s, g) => s + g.items.length, 0) : 0,
    upcoming: upcoming.reduce((s, g) => s + g.items.length, 0),
    gmail: plan?.review?.length ?? 0,
  };
  const paused = Boolean(plan?.control?.paused);
  const projectCount = plan?.projects?.length ?? 0;
  useLayoutEffect(() => {
    const place = () => {
      const on = navRef.current?.querySelector<HTMLElement>('.dk-nav-btn.is-on');
      setPill((p) => (on ? { y: on.offsetTop, h: on.offsetHeight, ready: Boolean(p) } : null));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [view, projectId, space, projectCount]);
  const parsed = q.trim() ? parseQuickAdd(q) : null;
  const running = plan?.withAside ?? [];

  return (
    <div className={`dk dk4 n3${item ? ' has-sel' : ''}${running.length ? ' has-runs' : ''}`}>
      <ToastHost />
      <aside className="dk-side" aria-label="Lists">
        <div className="dk-brand">
          <span className="dk-brand-mark" aria-hidden />
          Next
        </div>
        <div className="dk-space">
          <SpaceSwitch space={space} onChange={setSpace} summary={summary} variant="desk" />
        </div>
        <nav className={`dk-nav${pill ? ' has-pill' : ''}`} key={space} ref={navRef}>
          {pill ? <span className={`dk-nav-pill${pill.ready ? ' is-ready' : ''}`} style={{ transform: `translateY(${pill.y}px)`, height: pill.h }} aria-hidden /> : null}
          <p className="dk-nav-head dk-nav-space">
            <SpaceGlyph space={space} size={7} />
            {spaceLabel(space)}
          </p>
          <NavBtn on={view === 'today'} onClick={() => go('today')} icon={<SunMedium size={16} strokeWidth={1.7} />} label="Today" count={counts.today} />
          <NavBtn on={view === 'upcoming'} onClick={() => go('upcoming')} icon={<CalendarDays size={16} strokeWidth={1.7} />} label="Upcoming" count={counts.upcoming} />
          {space === 'personal' ? (
            <NavBtn on={view === 'gmail'} onClick={() => go('gmail')} icon={<Mail size={16} strokeWidth={1.7} />} label="From Gmail" count={counts.gmail} tag="trial" />
          ) : null}
          <p className="dk-nav-head">Projects</p>
          {(plan?.projects ?? []).map((p) => (
            <button
              key={p.id}
              type="button"
              className={`dk-nav-btn${view === 'projects' && projectId === p.id ? ' is-on' : ''}`}
              aria-label={p.title}
              onClick={() => {
                setView('projects');
                setProjectId(p.id);
                setSel(null);
              }}
            >
              <span className="dk-nav-icon" title={HEALTH_WORD[p.health] ?? ''}>
                <ProgressRing done={p.done} total={p.total} health={p.health} size={16} />
              </span>
              <span className="dk-nav-label">{p.title}</span>
              <span className="dk-nav-count">
                {p.done}/{p.total}
              </span>
            </button>
          ))}
          <NavBtn on={view === 'projects' && !projectId} onClick={() => go('projects')} icon={<FolderOpen size={16} strokeWidth={1.7} />} label={(plan?.projects ?? []).length ? 'All projects' : 'New project'} />
          <p className="dk-nav-head">Both spaces</p>
          <NavBtn on={view === 'research'} onClick={() => go('research')} icon={<SearchIcon size={16} strokeWidth={1.7} />} label="Research" />
          <NavBtn on={view === 'activity'} onClick={() => go('activity')} icon={<ShieldCheck size={16} strokeWidth={1.7} />} label="Activity" dot={paused} />
        </nav>
        {running.length ? (
          <div className="dk-side-runs">
            <p className="dk-nav-head">
              Helpers
              {running.some((it) => it.live?.busy) ? <span className="dk-live">Live</span> : null}
            </p>
            <ul className="dk-runs">
              {running.map((it) => (
                <li key={it.id}>
                  <button type="button" onClick={() => setSel(it.id)}>
                    <span className={`dk-run-dot${it.live?.busy ? ' is-busy' : ''}`} aria-hidden />
                    <span className="dk-run-body">
                      <span className="dk-run-title">{it.title}</span>
                      <span className="dk-run-step"><Shine active={!!it.live?.busy} text={it.live?.busy ? it.live.step || 'Working on it' : 'Done. Waiting for you to check it'} /></span>
                    </span>
                    {it.live?.busy && it.live.startedAt ? <Elapsed since={it.live.startedAt} /> : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="dk-side-foot">
          <span className={`dk-state${paused ? ' is-paused' : ''}`}>
            <span aria-hidden />
            {paused ? 'Paused. Nothing runs.' : 'On. Acts only when you click.'}
          </span>
          <ul className="dk-sources" aria-label="Last checked">
            {(plan?.sources ?? []).map((s) => {
              const at = s.updatedAt ? new Date(s.updatedAt) : null;
              // Older than a day and a half means the sync itself is stuck, not just quiet.
              const stale = !s.ok || (at !== null && now.getTime() - at.getTime() > 36 * 3_600_000);
              return (
                <li key={s.id} className={stale ? 'is-stale' : undefined} title={stale ? `${s.label} has not synced since ${at ? at.toLocaleString() : 'it was turned on'}` : undefined}>
                  <span className="dk-source-dot" aria-hidden />
                  <span className="dk-source-label">{s.label}</span>
                  <span className="dk-source-time">{stale && at ? `last ${stamp(at, now)}` : at ? stamp(at, now) : s.ok ? 'on' : 'off'}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>

      <main className="dk-main">
        <div className="dk-main-space">
          <SpaceSwitch space={space} onChange={setSpace} summary={summary} variant="desk" />
        </div>
        <form
          className="dk-bar"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <SearchIcon size={16} strokeWidth={1.8} aria-hidden />
          <input ref={bar} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Add to ${spaceLabel(space)}, or search it`} aria-label={`Add a task to ${spaceLabel(space)}, or search`} />
          <kbd>⌘K</kbd>
        </form>
        {parsed?.title ? (
          <p className="dk-bar-hint">
            <kbd>↵</kbd> Add “{parsed.title}” to{' '}
            <button type="button" className="dk-space-pick" onMouseDown={(e) => e.preventDefault()} onClick={() => setQPick(addSpace === 'school' ? 'personal' : 'school')} title="Switch space">
              <SpaceGlyph space={addSpace} size={7} /> {spaceLabel(addSpace)}
            </button>
            {parsed.dueLabel ? ` · ${parsed.dueLabel}` : ''}
            {parsed.estMinutes ? ` · ${hm(parsed.estMinutes)}` : ''}
            <span> · Try “call Mom tomorrow 15m”</span>
          </p>
        ) : null}

        <div className="sp-wash" data-space={space} aria-hidden />
        <div className="dk-scroll" key={space}>
          {liveState === 'offline' && plan ? (
            <button type="button" className="n3-offline dk-offline" onClick={() => void load()}>
              <span className="n3-offline-dot" aria-hidden />
              <span>Next's server is not answering. Showing your list from {savedAt ? new Date(savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'earlier'}. Retrying on its own.</span>
            </button>
          ) : null}
          <NextBoundary resetKey={`${view}:${space}:${projectId ?? ''}`}>
          <div className={switched ? `sp-enter-${space}` : undefined}>
          {!plan ? (
            error ? <div className="dk-loading">{error}</div> : <DeskSkeleton />
          ) : view === 'today' ? (
            <>
              <header className="dk-head">
                <p className="dk-head-date">{now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
                <div className="dk-head-row">
                  <h1>Today</h1>
                  {todayStats && todayStats.n ? (
                    <dl className="dk-figs" aria-label="Today at a glance">
                      <div>
                        <dt>To do</dt>
                        <dd>{todayStats.n}</dd>
                      </div>
                      {todayStats.mins ? (
                        <div>
                          <dt>Planned</dt>
                          <dd>{formatMinutes(todayStats.mins)}</dd>
                        </div>
                      ) : null}
                      {todayStats.late ? (
                        <div className="is-late">
                          <dt>Overdue</dt>
                          <dd>{todayStats.late}</dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : null}
                </div>
                <p className="dk-head-line">{plan.dayLine || 'Choose what matters, then get going.'}</p>
              </header>
              {plan.now && match(plan.now) ? <DeskNow item={plan.now} on={sel === plan.now.id} onSelect={() => setSel(plan.now!.id)} onDone={() => done(plan.now!)} onLater={() => later(plan.now!)} onNotMine={() => notMine(plan.now!)} leaving={leaving[plan.now.id]} /> : null}
              {groups.map((g) => {
                const items = g.items.filter(match);
                return items.length ? (
                  <Section key={g.id} title={g.title} count={items.length}>
                    {items.map((it) => (
                      <Row key={it.id} it={it} on={sel === it.id} leaving={leaving[it.id]} onSelect={() => setSel(it.id)} onDone={() => done(it)} onLater={() => later(it)} onNotMine={() => notMine(it)} now={now} hideToday />
                    ))}
                  </Section>
                ) : null;
              })}
              {plan.notices.length && !q ? (
                <Section title={space === 'school' ? 'From school' : 'From your Gmail'} count={plan.notices.length}>
                  {plan.notices.map((n) => (
                    <div key={n.id} className="dk-row is-notice">
                      <span className="dk-lead">
                        <Inbox size={15} strokeWidth={1.7} />
                      </span>
                      <button type="button" className="dk-row-body" onClick={() => n.url && void openUrl(n.url)} disabled={!n.url}>
                        <span className="dk-row-title">{n.title}</span>
                        <span className="dk-row-meta">{n.flag ? `Looks suspicious: ${n.flagReason ?? 'check it in Gmail yourself'}` : n.why || senderLine(n.sender)}</span>
                      </button>
                      <button type="button" className="dk-quiet" onClick={() => void api.nextAction(n.id, { type: 'dismiss' }).then(setPlan)}>
                        Clear
                      </button>
                    </div>
                  ))}
                </Section>
              ) : null}
              {!plan.now && !groups.length ? (
                space === 'school' ? (
                  <Empty title="Nothing due for school right now." line="New work shows up here as soon as Schoology or your school email has it." />
                ) : (
                  <Empty title="Nothing personal needs you right now." line={`Tasks you add, your personal projects, and Gmail you keep show up here.${counts.gmail ? ` ${counts.gmail} from Gmail ${counts.gmail === 1 ? 'is' : 'are'} waiting in From Gmail.` : ''}`} />
                )
              ) : null}
            </>
          ) : view === 'upcoming' ? (
            <>
              <header className="dk-head">
                <p className="sp-eyebrow">
                  <SpaceGlyph space={space} size={7} />
                  {spaceLabel(space)}
                </p>
                <h1>Upcoming</h1>
                <p>Everything with a date, by day</p>
              </header>
              {upcoming.map((g) => {
                const items = g.items.filter(match);
                return items.length ? (
                  <Section key={g.id} title={g.title} count={items.length}>
                    {items.map((it) => (
                      <Row key={it.id} it={it} on={sel === it.id} leaving={leaving[it.id]} onSelect={() => setSel(it.id)} onDone={() => done(it)} onLater={() => later(it)} onNotMine={() => notMine(it)} now={now} timeOnly />
                    ))}
                  </Section>
                ) : null;
              })}
              {!upcoming.length ? <Empty title="Nothing dated yet." line="Tasks with a due date or a planned day show up here." /> : null}
            </>
          ) : view === 'gmail' ? (
            <>
              <header className="dk-head">
                <p className="sp-eyebrow">
                  <SpaceGlyph space={space} size={7} />
                  {spaceLabel(space)}
                </p>
                <h1>From Gmail</h1>
                <p>Your personal inbox, on trial. Keep puts a task on your list.</p>
              </header>
              {(plan.review ?? []).filter(match).length ? (
                <Section title="Might need you" count={(plan.review ?? []).filter(match).length}>
                  {(plan.review ?? []).filter(match).map((it) => (
                    <div key={it.id} className={`dk-row${sel === it.id ? ' is-on' : ''}`}>
                      <span className="dk-lead">
                        <Mail size={15} strokeWidth={1.7} />
                      </span>
                      <button type="button" className="dk-row-body" onClick={() => setSel(it.id)}>
                        <span className="dk-row-title">{it.title}</span>
                        <span className="dk-row-meta">{[cap(whenText(it, now)), it.context].filter(Boolean).join(' · ')}</span>
                      </button>
                      <button type="button" className="dk-quiet" onClick={() => void act(it, { type: 'dismiss' })}>
                        Skip
                      </button>
                      <button type="button" className="dk-pill" onClick={() => void act(it, { type: 'keep' }, 'Kept. It is on your list now.')}>
                        Keep
                      </button>
                    </div>
                  ))}
                </Section>
              ) : (
                <Empty title="Nothing waiting from Gmail." line="Next checks your unread Primary mail every hour." />
              )}
              <div className="dk-privacy">
                <Lock size={15} strokeWidth={1.7} aria-hidden />
                <div>
                  <p>{plan.personalNote ?? 'No private or flagged mail in the last check.'}</p>
                  <p className="dk-privacy-rules">
                    Codes, banks, government and visa mail, health, security alerts, tax, and family never reach any model. Next reads only a short preview of the rest, and never replies, drafts, or acts on personal mail.
                  </p>
                </div>
              </div>
            </>
          ) : view === 'projects' ? (
            <div className="dk-embed">
              {projectId ? (
                <ProjectDetail id={projectId} onGone={() => setProjectId(null)} />
              ) : (
                <ProjectsList projects={projects} space={space} onOpen={(id) => setProjectId(id)} onNew={() => setNewProject(true)} />
              )}
            </div>
          ) : view === 'research' ? (
            <div className="dk-embed">
              <ResearchView onOpen={(b) => setReport(b)} refreshKey={researchKey} />
            </div>
          ) : (
            <div className="dk-embed">
              <ActivityTab onPausedChange={() => void load()} space={space} />
            </div>
          )}
          </div>
          </NextBoundary>
        </div>
      </main>

      <button type="button" className={`dk-keys-hint${keysOpen ? ' is-on' : ''}`} onClick={() => setKeysOpen((o) => !o)} aria-expanded={keysOpen}>
        Shortcuts <kbd>?</kbd>
      </button>
      {keysOpen ? (
        <div className="dk-keys-pop" role="dialog" aria-label="Keyboard shortcuts">
          <dl>
            <div><dt>Add or search</dt><dd><kbd>⌘</kbd><kbd>K</kbd></dd></div>
            <div><dt>Move</dt><dd><kbd>J</kbd><kbd>K</kbd></dd></div>
            <div><dt>Done</dt><dd><kbd>X</kbd></dd></div>
            <div><dt>Later (tomorrow)</dt><dd><kbd>L</kbd></dd></div>
            <div><dt>Not for me</dt><dd><kbd>N</kbd></dd></div>
            <div><dt>Open</dt><dd><kbd>O</kbd></dd></div>
            <div><dt>School, Personal</dt><dd><kbd>1</kbd><kbd>2</kbd></dd></div>
            <div><dt>Close</dt><dd><kbd>Esc</kbd></dd></div>
          </dl>
        </div>
      ) : null}

      {item ? (
      <aside className="dk-inspector is-open" aria-label="Details">
        <button ref={closeDetail} type="button" className="dk-sheet-x" onClick={() => setSel(null)} aria-label="Close details" title="Close (Esc)">
          <XIcon size={15} strokeWidth={2} />
        </button>
        {item ? (
          <Inspector
            key={item.id}
            item={item}
            now={now}
            busy={busy}
            helperModel={helperModel}
            onDone={() => done(item)}
            onLater={(until, label) => later(item, until, label)}
            onRemove={() => notMine(item)}
            onHelp={() => void help(item)}
            onResearch={() => void research(item)}
            onCancel={() => void api.nextCancelStart(item.id).then(setPlan)}
            onMove={item.source === 'manual' ? () => void moveTask(item, otherSpace(space)) : undefined}
            moveLabel={`Move to ${spaceLabel(otherSpace(space))}`}
          />
        ) : null}
      </aside>
      ) : null}

      {report ? (
        <ReportSheet
          brief={report}
          onClose={() => setReport(null)}
          onDismissed={() => {
            setReport(null);
            setResearchKey((k) => k + 1);
          }}
          onOpenUrl={(u) => void openUrl(u)}
        />
      ) : null}
      {newProject ? (
        <NewProjectSheet
          space={space}
          onClose={() => setNewProject(false)}
          onCreated={(p) => {
            setNewProject(false);
            if (p.space && p.space !== space) setSpaceRaw(p.space);
            setProjectId(p.id);
          }}
        />
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------

function dayTitle(d: Date, now: Date): string {
  const diff = Math.round((new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86_400_000);
  if (diff < 0) return 'Past due';
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString('en-US', diff < 7 ? { weekday: 'long' } : { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Only this label re-renders each second, not the whole page. */
function Elapsed({ since }: { since: string }) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => document.visibilityState === 'visible' && setN((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <span className="dk-run-time">{elapsed(since)}</span>;
}

function elapsed(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

function NavBtn({ on, onClick, icon, label, count, tag, dot }: { on: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number; tag?: string; dot?: boolean }) {
  return (
    <button type="button" className={`dk-nav-btn${on ? ' is-on' : ''}`} onClick={onClick} aria-label={label} aria-current={on ? 'page' : undefined}>
      <span className="dk-nav-icon">
        {icon}
        {dot ? <span className="dk-nav-dot" aria-label="paused" /> : null}
      </span>
      <span className="dk-nav-label">
        {label}
        {tag ? <span className="dk-tag">{tag}</span> : null}
      </span>
      {count ? <span className="dk-nav-count">{count}</span> : null}
    </button>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="dk-section" aria-label={title}>
      <h2>
        {title}
        {count !== undefined ? <span>{count}</span> : null}
      </h2>
      <div className="dk-rows">{children}</div>
    </section>
  );
}

/** Same silhouette as the loaded page, so nothing jumps when the list arrives. */
function DeskSkeleton() {
  return (
    <div className="dk-skel" role="status" aria-busy="true" aria-label="Loading your list">
      <span className="dk-skel-bit is-eyebrow" />
      <span className="dk-skel-bit is-title" />
      <span className="dk-skel-bit is-sub" />
      <span className="dk-skel-bit is-card" />
      <div className="dk-skel-rows">
        {[0, 1, 2].map((i) => (
          <span key={i} className="dk-skel-bit is-row" />
        ))}
      </div>
    </div>
  );
}

function Empty({ title, line }: { title: string; line: string }) {
  return (
    <div className="dk-empty">
      <p>{title}</p>
      <p>{line}</p>
    </div>
  );
}

function Row({
  it,
  on,
  leaving,
  now,
  onSelect,
  onDone,
  onLater,
  onNotMine,
  hideToday,
  timeOnly,
}: {
  it: NextItem;
  on: boolean;
  leaving?: Leaving;
  now: Date;
  onSelect: () => void;
  onDone: () => void;
  onLater: () => void;
  onNotMine: () => void;
  hideToday?: boolean;
  timeOnly?: boolean;
}) {
  const tone = dueTone(it, now);
  let when = whenText(it, now);
  if (hideToday && when === 'planned for today') when = '';
  if (timeOnly && it.dueISO && !isPlanned(it)) when = /at (.+)$/.exec(when)?.[1] ?? when;
  if (timeOnly && isPlanned(it)) when = 'planned';
  const est = formatMinutes(it.estMinutes);
  return (
    <div className={`dk-row${on ? ' is-on' : ''}${leaving ? ' is-leaving' : ''}${tone === 'late' || tone === 'today' ? ` is-${tone}` : ''}`}>
      <button type="button" className="dk-check" onClick={onDone} aria-label={`Mark ${it.title} done`}>
        <CheckCircle done={leaving === 'done'} size={22} />
      </button>
      <button type="button" className="dk-row-body" onClick={onSelect}>
        <span className={`dk-row-title${leaving === 'done' ? ' is-struck' : ''}`}>{it.title}</span>
        <span className="dk-row-meta">
          {tone === 'late' || tone === 'today' ? <span className={`n3-due-mark is-${tone}`} aria-hidden /> : null}
          {when ? <span className="dk-row-when">{cap(when)}</span> : null}
          {it.context ? <span className="dk-row-context">{it.context}</span> : null}
          {it.brief.mode === 'agent' ? (
            <span className="dk-helper" title="A helper can do this when you click Start" aria-label="Helper available">
              <Sparkles size={12} strokeWidth={1.9} aria-hidden />
            </span>
          ) : null}
          {it.research?.state === 'ready' ? <span className="dk-chip">Answer ready</span> : null}
          {it.doneHint ? <span className="dk-chip is-done">Looks done?</span> : null}
          {it.alsoFrom?.length ? <span className="dk-chip" title={it.alsoFrom.map((x) => x.title).join('\n')}>+{it.alsoFrom.length} copy</span> : null}
        </span>
      </button>
      <span className="dk-row-end">
        {est ? <span className="dk-est">{est}</span> : null}
        <span className="dk-hover">
          <button type="button" className="dk-act" onClick={onLater} aria-label={`Later: move ${it.title} to tomorrow`} title="Back tomorrow (L)">
            <Clock3 size={14} strokeWidth={1.9} aria-hidden />
            Later
          </button>
          <button type="button" className="dk-act" onClick={onNotMine} aria-label={`${skipLabel(it)}: ${it.title}`} title={`${skipLabel(it)} (N)`}>
            {it.source === 'manual' ? <XIcon size={14} strokeWidth={1.9} aria-hidden /> : <EyeOff size={14} strokeWidth={1.9} aria-hidden />}
            {skipLabel(it)}
          </button>
        </span>
      </span>
    </div>
  );
}

function DeskNow({ item, on, onSelect, onDone, onLater, onNotMine, leaving }: { item: NextItem; on: boolean; onSelect: () => void; onDone: () => void; onLater: () => void; onNotMine: () => void; leaving?: Leaving }) {
  const now = new Date();
  const tone = dueTone(item, now);
  const est = formatMinutes(item.estMinutes);
  const when = whenText(item, now);
  return (
    <section className={`dk-now${on ? ' is-on' : ''}${leaving ? ' is-leaving' : ''}`} aria-label="Do this now">
      <div className="dk-now-top">
        <span className="dk-now-label">Your next move</span>
        {item.context ? <span className="dk-now-ctx">{item.context}</span> : null}
      </div>
      <button type="button" className="dk-now-title" onClick={onSelect}>
        {item.title}
      </button>
      {item.why ? <p className="dk-now-why">{item.why}</p> : null}
      <div className="dk-now-foot">
        <div className="dk-now-actions">
          {item.url ? (
            <button type="button" className="dk-btn is-primary" onClick={() => void openUrl(item.url!)}>
              Open <ArrowUpRight size={14} strokeWidth={2} />
            </button>
          ) : null}
          <button type="button" className={`dk-btn${item.url ? '' : ' is-primary'}`} onClick={onDone}>
            Done
          </button>
          <button type="button" className="dk-quiet" onClick={onLater} title="Back tomorrow">
            Later
          </button>
          <button type="button" className="dk-quiet" onClick={onNotMine}>
            {skipLabel(item)}
          </button>
          <button type="button" className="dk-quiet" onClick={onSelect}>
            Details
          </button>
        </div>
        {when || est ? (
          <dl className="dk-now-facts">
            {est ? (
              <div>
                <dt>
                  <Clock3 size={13} strokeWidth={1.9} aria-hidden /> Takes
                </dt>
                <dd>{est}</dd>
              </div>
            ) : null}
            {when ? (
              <div className={`is-${tone}`}>
                <dt>
                  <CalendarDays size={13} strokeWidth={1.9} aria-hidden /> {isPlanned(item) ? 'Planned' : 'Due'}
                </dt>
                <dd>{cap(when.replace(/^due /, '').replace(/^planned for /, ''))}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>
    </section>
  );
}

function Inspector({
  item,
  now,
  busy,
  helperModel,
  onDone,
  onLater,
  onRemove,
  onHelp,
  onResearch,
  onCancel,
  onMove,
  moveLabel,
}: {
  onMove?: () => void;
  moveLabel?: string;
  item: NextItem;
  now: Date;
  busy: string | null;
  helperModel: string | null;
  onDone: () => void;
  onLater: (until: Date, label: string) => void;
  onRemove: () => void;
  onHelp: () => void;
  onResearch: () => void;
  onCancel: () => void;
}) {
  const tone = dueTone(item, now);
  const b = item.brief;
  const est = formatMinutes(item.estMinutes);
  const when = whenText(item, now).replace(/^due /, '').replace(/^planned for /, '');
  const helping = item.status === 'handed-off';
  const waiting = item.handoff?.state === 'waiting';
  return (
    <div className="dk-insp">
      <p className="dk-insp-eyebrow">{item.trial ? 'From your Gmail · trial' : item.context || (item.taint === 'email' ? 'School email' : 'Task')}</p>
      <h2 className="dk-insp-title">{item.title}</h2>
      <dl className="dk-facts">
        {item.dueISO ? (
          <div>
            <dt>
              <CalendarDays size={15} strokeWidth={1.8} aria-hidden />
              {isPlanned(item) ? 'Planned' : 'Due'}
            </dt>
            <dd className={`n3-due is-${tone}`}>{cap(when)}</dd>
          </div>
        ) : null}
        {est ? (
          <div>
            <dt>
              <Clock3 size={15} strokeWidth={1.8} aria-hidden />
              Takes
            </dt>
            <dd>{estLabel(item, est)}</dd>
          </div>
        ) : null}
        {item.taint === 'email' ? (
          <div>
            <dt>
              <Mail size={15} strokeWidth={1.8} aria-hidden />
              From
            </dt>
            <dd>{item.trial ? item.sender?.name || item.context : senderLine(item.sender)}</dd>
          </div>
        ) : null}
      </dl>
      {item.flag ? <p className="n3-warn">{flagLine(item)}</p> : null}
      {item.doneHint && item.status === 'open' ? (
        <div className="n3-donehint" role="note">
          <p>{doneHintLine(item, now)}</p>
          <button type="button" className="dk-btn" onClick={onDone}>
            Mark done
          </button>
        </div>
      ) : null}
      {item.why ? <p className="dk-insp-why">{item.why}</p> : null}
      <ContextEvidence item={item} />
      <DocumentLinkControl item={item} />
      {alsoLine(item) ? <p className="dk-insp-why n3-also">{alsoLine(item)}</p> : null}

      <div className="dk-insp-actions">
        {item.url ? (
          <button type="button" className="dk-btn is-primary" onClick={() => void openUrl(item.url!)}>
            {item.taint === 'email' ? 'Open email' : 'Open'} <ArrowUpRight size={15} strokeWidth={2} />
          </button>
        ) : null}
        <button type="button" className="dk-btn" onClick={onDone}>
          Done
        </button>
        <button type="button" className="dk-btn" onClick={onRemove} title={`${skipLabel(item)} (N)`}>
          {skipLabel(item)}
        </button>
      </div>
      <div className="dk-later" role="group" aria-label="Move to later">
        <span>Later</span>
        {laterChoices(now).map((c) => (
          <button type="button" key={c.label} className="dk-chip-btn" onClick={() => onLater(c.until, c.label)}>
            {c.label}
          </button>
        ))}
      </div>

      {b.mode === 'agent' ? (
        <section className="dk-hand">
          <div className="dk-hand-head">
            <p>Hand off to a helper</p>
            {helperModel ? (
              <span className="dk-model" title={`Runs on ${helperModel}`}>
                {helperModel.replace(/\s*\(.*\)$/, '')}
              </span>
            ) : null}
          </div>
          <p className="dk-hand-line">{b.headline}. It starts only when you click Start.</p>
          <ul>
            {b.will.map((w) => (
              <li key={w} className="is-will">{w}</li>
            ))}
            {b.wont.map((w) => (
              <li key={w} className="is-wont">Won't {w.charAt(0).toLowerCase() + w.slice(1)}</li>
            ))}
          </ul>
          {b.stopsAt ? <p className="dk-hand-stop">Stops at: {b.stopsAt}</p> : null}
          {helping ? (
            <p className="dk-hand-state"><Shine active={!!item.live?.busy} text={item.live?.busy ? item.live.step || 'Working on it' : item.live?.result ? `Done: ${item.live.result}` : 'Done. Waiting for you to check it.'} /></p>
          ) : waiting ? (
            <div className="dk-hand-wait">
              <span className="dk-queued-status">Queued because you clicked Start{item.handoff?.readyInMin ? `, about ${item.handoff.readyInMin} min` : ''}</span>
              <button type="button" className="dk-quiet" onClick={onCancel}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="dk-btn is-primary is-full" onClick={onHelp} disabled={busy === 'help'}>
              {busy === 'help' ? <Spinner size={14} /> : null}
              Start helper
            </button>
          )}
        </section>
      ) : null}

      {b.research ? (
        <section className="dk-hand">
          <div className="dk-hand-head">
            <p>Look into this</p>
          </div>
          <p className="dk-hand-line">
            {b.research.kind === 'web'
              ? 'Searches the web and brings back a short answer with sources. It cannot see your files or use your logins.'
              : `Reads the page on ${b.research.host ?? 'that site'} and sums up what you need. It cannot click, type, or submit.`}
          </p>
          {item.research && item.research.state !== 'dismissed' ? (
            <p className="dk-hand-state">{item.research.state === 'ready' ? `Answer ready${item.research.verdictLabel ? `: ${item.research.verdictLabel}` : ''}. See Research.` : item.research.state === 'failed' ? 'It stopped before it had an answer.' : 'Looking into it'}</p>
          ) : (
            <button type="button" className="dk-btn is-full" onClick={onResearch} disabled={busy === 'research'}>
              {busy === 'research' ? <Spinner size={14} /> : null}
              Look into this
            </button>
          )}
        </section>
      ) : null}

      {b.mode === 'none' && b.note && !item.flag ? <p className="dk-insp-note">{b.note}</p> : null}
      {onMove ? (
        <div className="dk-insp-foot">
          <button type="button" className="dk-quiet" onClick={onMove}>
            <SpaceGlyph space={item.space === 'school' ? 'personal' : 'school'} size={7} />
            {moveLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

