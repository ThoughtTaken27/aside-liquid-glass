/**
 * Next: your plan, on your phone.
 *
 * Four areas behind a floating tab bar (Apple's tab bar guidance and
 * Linear's glass bar: icon and label always, one detached + for the main
 * action). Nothing in here starts work on its own. Every helper begins
 * from a button you tap, and says first what it will and won't do.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FolderOpen, Search as SearchIcon, ShieldCheck, SunMedium, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useBackStack } from '../utils/backStack';
import { navigate } from '../utils/navTransition';
import { haptic } from '../telegram';
import { ChevronLeft, Plus, Spinner } from './Icons';
import { ToastHost, toast } from './Toasts';
import { DraftSheet } from './NextParts';
import { TodayView } from './NextToday';
import { ItemSheet, laterChoices } from './NextItemSheet';
import { ResearchView, ReportSheet } from './NextResearch';
import { ProjectDetail, ProjectsList, NewProjectSheet } from './NextProjects';
import { ActivityTab } from './NextActivity';
import { FocusMode, QuickAddSheet } from './NextFocus';
import { openUrl } from '../utils/openUrl';
import { scopePlan, spaceSummary, useSpace } from '../utils/nextSpace';
import { SpaceSwitch } from './NextSpace';
import { NextBoundary } from './NextBoundary';
import { useLivePlan } from '../hooks/useLivePlan';
import type { NextAction, NextItem, NextProject, NextSpace, ResearchBrief, SessionRow } from '../types';

type Tab = 'today' | 'projects' | 'research' | 'activity';
const TABS: Array<{ id: Tab; label: string; Icon: typeof SunMedium }> = [
  { id: 'today', label: 'Today', Icon: SunMedium },
  { id: 'projects', label: 'Projects', Icon: FolderOpen },
  { id: 'research', label: 'Research', Icon: SearchIcon },
  { id: 'activity', label: 'Activity', Icon: ShieldCheck },
];

function errText(e: unknown, fallback: string): string {
  const m = String((e as Error)?.message ?? '');
  if (m.includes('423') || m.includes('paused')) return 'Next is paused. Turn it back on in Activity.';
  if (m.includes('429')) return 'That is a lot of starts this hour. Try again later.';
  if (m.includes('409')) return 'That is already going.';
  return fallback;
}

export function NextScreen({
  onClose,
  onOpenThread,
  onSessionsChanged,
}: {
  sessions: SessionRow[];
  onClose: () => void;
  onOpenThread: (sessionId: string) => void;
  onSessionsChanged: () => void;
}) {
  const { plan, setPlan, load, state: liveState, savedAt, error } = useLivePlan();
  const [tab, setTab] = useState<Tab>('today');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<NextProject[] | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [report, setReport] = useState<ResearchBrief | null>(null);
  const [quickAdd, setQuickAdd] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [researchKey, setResearchKey] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [space, setSpaceRaw] = useSpace();
  const [switched, setSwitched] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const lastY = useRef(0);
  const scrollPositions = useRef(new Map<string, number>());
  const scrollKey = tab + ':' + (projectId ?? '') + ':' + space;
  const currentScrollKey = useRef(scrollKey);
  useLayoutEffect(() => {
    currentScrollKey.current = scrollKey;
    const y = scrollPositions.current.get(scrollKey) ?? 0;
    if (scroller.current) scroller.current.scrollTop = y;
    lastY.current = y;
    setScrolled(y > 44);
  }, [scrollKey]);
  useBackStack([
    ...(tab !== 'today' ? [{ key: 'next-tab', back: () => { setTab('today'); setProjectId(null); setScrolled(false); } }] : []),
    ...(projectId ? [{ key: 'next-project', back: () => navigate('pop', () => { setProjectId(null); setScrolled(false); }) }] : []),
  ], 20);

  useEffect(() => {
    if (plan) setPaused(Boolean(plan.control?.paused));
  }, [plan]);

  const loadProjects = useCallback(async () => {
    try {
      setProjects((await api.nextProjects()).projects);
    } catch {
      setProjects((p) => p ?? []);
    }
  }, []);

  useEffect(() => {
    if (tab === 'projects' && !projectId) void loadProjects();
  }, [tab, projectId, loadProjects]);

  // The tab bar tucks away while scrolling down and comes back on the way
  // up (iOS 26 tab bar minimize behaviour).
  const onScroll = () => {
    const y = scroller.current?.scrollTop ?? 0;
    scrollPositions.current.set(currentScrollKey.current, y);
    // Past the big title, its name moves into the top bar (iOS large title).
    setScrolled(y > 44);
    lastY.current = y;
  };

  const all: NextItem[] = plan ? ([plan.now, ...plan.next, ...plan.later, ...plan.unsure, ...plan.withAside, ...(plan.review ?? [])].filter(Boolean) as NextItem[]) : [];
  const scoped = plan ? scopePlan(plan, space) : null;
  const summary = plan ? { school: spaceSummary(plan, 'school'), personal: spaceSummary(plan, 'personal') } : undefined;
  const setSpace = (s: NextSpace) => {
    haptic('light');
    setSwitched(true);
    setSpaceRaw(s);
    setScrolled(false);
    scroller.current?.scrollTo({ top: 0 });
  };
  const moveTask = async (it: NextItem, to: NextSpace) => {
    try {
      setPlan(await api.nextMoveTask(it.id.replace(/^manual:/, ''), to));
      setItemId(null);
      toast(`Moved to ${to === 'school' ? 'School' : 'Personal'}`, { action: { label: 'Show', onClick: () => setSpace(to) } });
    } catch {
      toast('Could not move it. Try again.', { tone: 'error' });
    }
  };
  const spaced = tab === 'today' || (tab === 'projects' && !projectId);
  const item = itemId ? all.find((it) => it.id === itemId) ?? null : null;
  const draftItem = draftId ? all.find((it) => it.id === draftId) ?? null : null;
  const focusItem = focusId ? all.find((it) => it.id === focusId) ?? null : null;

  const act = async (it: NextItem, action: NextAction, message?: string, undo?: boolean) => {
    try {
      setPlan(await api.nextAction(it.id, action));
      if (message) toast(message, undo ? { action: { label: 'Undo', onClick: () => void act(it, { type: 'reopen' }) } } : {});
    } catch {
      toast('That did not save. Try again.', { tone: 'error' });
    }
  };

  const dismiss = (it: NextItem) => {
    haptic('light');
    setItemId(null);
    void act(it, { type: 'dismiss' }, it.source === 'manual' ? 'Task removed' : it.source === 'project' ? 'Step skipped' : 'Removed from your list', true);
  };

  const done = (it: NextItem) => {
    haptic('success');
    setItemId(null);
    void act(it, { type: 'done' }, `Done: ${it.title}`, true);
  };

  const later = (it: NextItem, until?: Date, label = 'tomorrow') => {
    const d = until ?? laterChoices(new Date()).find((c) => c.label === 'Tomorrow')!.until;
    haptic('light');
    setItemId(null);
    void act(it, { type: 'snooze', until: d.toISOString() }, `Back ${label.toLowerCase()}`, true);
  };

  /** He tapped for help. Next works on it now or as soon as one is ready. */
  const help = async (it: NextItem) => {
    setBusy('help');
    try {
      const res = await api.nextStartWhenReady(it.id);
      setPlan(res.plan);
      onSessionsChanged();
      if (res.sessionId) {
        haptic('success');
        setItemId(null);
        toast('Next is working on it. It stops before submitting anything.', {
          action: { label: 'Watch', onClick: () => onOpenThread(res.sessionId!) },
        });
      } else {
        toast(`Noted. Next is getting ready${res.readyInMin ? `, about ${res.readyInMin} min` : ''}. You can cancel until it starts.`);
      }
    } catch (e) {
      toast(errText(e, 'Could not start it. Try again.'), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const cancelHelp = async (it: NextItem) => {
    try {
      setPlan(await api.nextCancelStart(it.id));
      toast('Cancelled. Nothing started.');
    } catch {
      toast('Could not cancel. Try again.', { tone: 'error' });
    }
  };

  const research = async (it: NextItem) => {
    setBusy('research');
    try {
      await api.researchStart({ itemId: it.id });
      await load();
      setResearchKey((k) => k + 1);
      toast('Next will look into it. The answer shows up in Research.');
    } catch (e) {
      toast(errText(e, 'Could not start that. Try again.'), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const openResearch = async (id: string) => {
    try {
      setItemId(null);
      setReport(await api.researchGet(id));
    } catch {
      toast('Could not open that answer.', { tone: 'error' });
    }
  };

  const checkMail = async () => {
    setChecking(true);
    const what = space === 'school' ? 'school email' : 'Gmail';
    try {
      const res = space === 'school' ? await api.nextRefresh() : await api.nextPersonalRefresh();
      setPlan(res.plan);
      toast(res.result.ok ? `${what.charAt(0).toUpperCase() + what.slice(1)} checked.` : `Could not read ${what} right now.`, res.result.ok ? {} : { tone: 'error' });
    } catch (e) {
      toast(errText(e, `Could not check ${what}.`), { tone: 'error' });
    } finally {
      setChecking(false);
    }
  };

  const goTab = (t: Tab) => {
    if (t === tab && !projectId) {
      scroller.current?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    haptic('light');
    setTab(t);
    setProjectId(null);
    setScrolled(false);
    if (t === 'today') void load();
  };

  const openProject = (id: string) => {
    haptic('light');
    setTab('projects');
    navigate('push', () => setProjectId(id));
    setScrolled(false);
  };

  const plus = () => {
    haptic('light');
    if (tab === 'today') setQuickAdd(true);
    else if (tab === 'projects') setNewProject(true);
    else if (tab === 'research') document.getElementById('n3-ask-input')?.focus();
  };

  const mailSource = scoped?.sources.find((s) => s.id === 'school-mail' || s.id === 'personal-mail') ?? null;

  return (
    <div className="app next-screen n3" data-destination="next">
      <header className={`n3-top${scrolled ? ' is-scrolled' : ''}${spaced ? ' has-switch' : ''}`}>
        <button
          type="button"
          className="n3-back"
          onClick={() => (projectId ? navigate('pop', () => { setProjectId(null); setScrolled(false); void loadProjects(); }) : onClose())}
          aria-label={projectId ? 'Back to projects' : 'Back to Aside'}
        >
          <ChevronLeft size={22} strokeWidth={1.75} />
          <span>{projectId ? 'Projects' : 'Aside'}</span>
        </button>
        {spaced ? (
          <SpaceSwitch space={space} onChange={setSpace} summary={summary} />
        ) : (
          <span className="n3-top-title" aria-hidden={!scrolled || !!projectId}>
            {projectId ? '' : TABS.find((t) => t.id === tab)?.label}
          </span>
        )}
        {paused ? (
          <button type="button" className="n3-paused-chip" onClick={() => goTab('activity')}>
            <span aria-hidden />
            Paused
          </button>
        ) : (
          <button type="button" className={`n3-refresh${refreshing ? ' is-refreshing' : ''}`} aria-label={refreshing ? 'Refreshing your plan' : 'Refresh your plan'} onClick={async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } }} disabled={refreshing}><RefreshCw size={19} aria-hidden /></button>
        )}
      </header>
      <ToastHost />

      <main className="n3-scroll has-wash" ref={scroller} onScroll={onScroll}>
        {spaced ? <div className="sp-wash" data-space={space} aria-hidden /> : null}
        {liveState === 'offline' && plan ? (
          <button type="button" className="n3-offline" onClick={() => void load()}>
            <span className="n3-offline-dot" aria-hidden />
            <span>
              Can't reach your Mac. Showing your list from {savedAt ? new Date(savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'earlier'}. Retrying.
            </span>
          </button>
        ) : null}
        <NextBoundary resetKey={`${tab}:${space}:${projectId ?? ''}`} label={tab === 'today' ? 'Today' : tab === 'projects' ? 'Projects' : tab === 'research' ? 'Research' : 'Activity'}>
        {tab === 'today' ? (
          scoped ? (
            <div key={space} className={switched ? `sp-enter-${space}` : undefined}>
            <TodayView
              space={space}
              plan={scoped}
              onOpenItem={(it) => setItemId(it.id)}
              onAdd={plus}
              onDone={done}
              onLater={(it) => later(it)}
              onFocus={(it) => setFocusId(it.id)}
              onOpenUrl={(u) => void openUrl(u)}
              onOpenProject={openProject}
              onOpenThread={onOpenThread}
              onClearNotice={(n) => void api.nextAction(n.id, { type: 'dismiss' }).then(setPlan)}
              onKeep={(it) => void act(it, { type: 'keep' }, 'Kept on your list')}
              onSkip={dismiss}
              onCheckMail={mailSource && !paused ? () => void checkMail() : null}
              checking={checking}
            />
            </div>
          ) : (
            <div className="n3-loading">{error ?? <Spinner size={16} />}</div>
          )
        ) : tab === 'projects' ? (
          projectId ? (
            <ProjectDetail
              id={projectId}
              onGone={() => {
                setProjectId(null);
                void loadProjects();
              }}
            />
          ) : (
            <div key={space} className={switched ? `sp-enter-${space}` : undefined}>
              <ProjectsList projects={projects} space={space} onOpen={openProject} onNew={() => setNewProject(true)} />
            </div>
          )
        ) : tab === 'research' ? (
          <ResearchView
            onOpen={(b) => setReport(b)}
            refreshKey={researchKey}
            suggestions={all
              .filter((it) => it.brief.research && !it.research && !it.flag)
              .map((it) => (it.kind === 'opportunity' ? `Is "${it.title}" worth it, and am I eligible?` : `What do I need to know for "${it.title}"?`))}
          />
        ) : (
          <ActivityTab onPausedChange={setPaused} space={space} />
        )}
        </NextBoundary>
      </main>

      <nav className="n3-tabbar" aria-label="Next">
        <div className="n3-tabs" role="tablist">
          <span className="n3-tabs-pill" aria-hidden style={{ transform: `translateX(${Math.max(0, TABS.findIndex((t) => t.id === tab)) * 100}%)` }} />
          {TABS.map(({ id, label, Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => goTab(id)}>
              <span className="n3-tab-icon">
                <Icon size={21} strokeWidth={tab === id ? 2 : 1.6} aria-hidden />
                {id === 'activity' && paused ? <span className="n3-tab-dot" aria-label="paused" /> : null}
              </span>
              <span className="n3-tab-label">{label}</span>
            </button>
          ))}
        </div>
        {tab !== 'activity' && !projectId ? (
          <button type="button" className="n3-plus" onClick={plus} aria-label={tab === 'today' ? 'Add a task' : tab === 'projects' ? 'New project' : 'Ask a question'}>
            <Plus size={21} strokeWidth={2} /><span className="n3-add-label">{tab === 'projects' ? 'New' : tab === 'research' ? 'Ask' : 'Add'}</span>
          </button>
        ) : null}
      </nav>

      {item ? (
        <ItemSheet
          item={item}
          busy={busy}
          onClose={() => setItemId(null)}
          onOpenUrl={(u) => void openUrl(u)}
          onDone={() => done(item)}
          onLater={(until, label) => later(item, until, label)}
          onDismiss={() => dismiss(item)}
          onHelp={() => void help(item)}
          onCancelHelp={() => void cancelHelp(item)}
          onMove={(to) => void moveTask(item, to)}
          onResearch={() => void research(item)}
          onOpenResearch={(id) => void openResearch(id)}
          onDraft={() => {
            setItemId(null);
            setDraftId(item.id);
          }}
          onFocus={() => {
            setItemId(null);
            setFocusId(item.id);
          }}
        />
      ) : null}
      {draftItem ? (
        <DraftSheet
          item={draftItem}
          onClose={() => setDraftId(null)}
          onCopied={() => {
            setDraftId(null);
            haptic('success');
            toast('Reply copied. Tap Reply in Gmail and paste.');
          }}
        />
      ) : null}
      {report ? (
        <ReportSheet
          brief={report}
          onClose={() => setReport(null)}
          onDismissed={() => {
            setReport(null);
            setResearchKey((k) => k + 1);
            void load();
          }}
          onOpenUrl={(u) => void openUrl(u)}
        />
      ) : null}
      {quickAdd ? (
        <QuickAddSheet
          space={space}
          onClose={() => setQuickAdd(false)}
          onAdd={async (t) => {
            try {
              setPlan(await api.nextAddTask(t));
              setQuickAdd(false);
              haptic('success');
              if (t.space !== space) setSpace(t.space);
              toast(`Added to ${t.space === 'school' ? 'School' : 'Personal'}: ${t.title}`);
            } catch {
              toast('Could not add it. Try again.', { tone: 'error' });
            }
          }}
        />
      ) : null}
      {newProject ? (
        <NewProjectSheet
          space={space}
          onClose={() => setNewProject(false)}
          onCreated={(p) => {
            setNewProject(false);
            if (p.space && p.space !== space) setSpaceRaw(p.space);
            openProject(p.id);
          }}
        />
      ) : null}
      {focusItem ? (
        <FocusMode
          item={focusItem}
          onExit={() => setFocusId(null)}
          onDone={() => {
            setFocusId(null);
            done(focusItem);
          }}
        />
      ) : null}
    </div>
  );
}
