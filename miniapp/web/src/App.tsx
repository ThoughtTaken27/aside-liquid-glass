/**
 * The app shell: a sidepanel home screen and a thread screen.
 *
 * Home is the composer card over the session list -- sending from it
 * starts a new session, which is why there is no separate new-chat
 * control. The thread screen carries the reply composer and the bottom
 * bar. Model, effort and permission controls appear on both and drive the
 * same state.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SessionList } from './components/SessionList';
import { Thread, liveWorkBlock, tailIsAnswering } from './components/Thread';
import { LiveWorkTail } from './components/WorkFold';
import { Composer } from './components/Composer';
import type { ComposerMode } from './components/Composer';
import { RestCue, RestHero } from './components/Rest';

/*
 * Everything the first screen does not need.
 *
 * The app had no code splitting at all -- no `lazy`, no `Suspense`, one
 * 536KB chunk that every launch paid for in full before it could paint a
 * greeting and a composer. These five are the clean cuts: each already sits
 * behind a `condition ? <X/> : null`, so its chunk is fetched exactly when
 * that condition first goes true and never on a launch that does not open
 * it. Settings, the model picker, the tab deck, the session panel and the
 * citation sheet are all places you travel TO.
 *
 * `fallback={null}` on purpose. These are overlays, and over a local
 * network the chunk lands well inside the time the press animation is
 * still running, so a spinner would be a flash of anxiety for something
 * that has already arrived. A sheet 40ms late is invisible; a spinner
 * blinking on and off is not.
 */
const ModelSheet = lazy(() =>
  import('./components/ModelSheet').then((m) => ({ default: m.ModelSheet })),
);
const CitationSheet = lazy(() =>
  import('./components/Citations').then((m) => ({ default: m.CitationSheet })),
);
const SessionPanel = lazy(() =>
  import('./components/SessionPanel').then((m) => ({
    default: m.SessionPanel,
  })),
);
const SettingsScreen = lazy(() =>
  import('./components/SettingsScreen').then((m) => ({
    default: m.SettingsScreen,
  })),
);
const TabDeck = lazy(() =>
  import('./components/TabDeck').then((m) => ({ default: m.TabDeck })),
);
import { OmniboxResults } from './components/OmniboxResults';
import { ModeSwitch } from './components/ModeSwitch';
import { useOmnibox } from './hooks/useOmnibox';
import { StreamFooter } from './components/StreamFooter';
import { activityPhase } from './utils/activityPhase';
import { TodoSection } from './components/TodoSection';
import { ErrorCard } from './components/ErrorCard';
import { AsideSymbol, ChevronDown, ChevronLeft, Globe, MoreVertical, Spinner } from './components/Icons';
import { LiveBrowserCard } from './components/LiveBrowser';
import type { CitationMark } from './utils/citations';
import { api, setAuthToken, setUnauthorizedHandler } from './api';
import {
  PHONE_OFFLINE_MESSAGE,
  clearStoredToken,
  isStandaloneEntry,
  pairUnreachableMessage,
  readStoredToken,
  resolveStandaloneAuth,
} from './standalone';
import { PairPrompt } from './components/PairPrompt';
import { useActivityElapsed } from './components/ActivityMeta';
import { workedFor } from './utils/time';
import { ToastHost, toast } from './components/Toasts';
import { ActivityIsland } from './components/ActivityIsland';
import { PullToRefresh } from './components/PullToRefresh';
import { playSound } from './utils/sounds';
import { InstallHint } from './components/InstallHint';
import { RelayBanner } from './components/RelayBanner';
import { setRefreshedRelays } from './relays';
import { useThread } from './hooks/useThread';
import { useAttachments } from './hooks/useAttachments';
import { useDockHeight } from './hooks/useDockHeight';
import { resolvePills } from './utils/pills';
import { startVisiblePolling } from './utils/polling';
import { resolveThreadModel } from './utils/sessionState';
import { readLocal, writeLocal } from './utils/storage';
import {
  applyTheme,
  authenticateIfEnabled,
  backButton,
  cloudStorage,
  disableClosingConfirmation,
  enableClosingConfirmation,
  haptic,
  initTelegram,
  onThemeChanged,
  readInitData,
  readStartParam,
  stashDevInitData,
} from './telegram';
import type { CatalogProvider, SessionRow, StatusResponse } from './types';

/**
 * A thread on the navigation stack.
 *
 * `parentTitle` is set when this thread was opened from a subagent card, so
 * the header can say whose subagent it is. It comes from the caller rather
 * than from another lookup: whoever navigated here already had the title on
 * screen.
 */
interface ThreadScreenState {
  id: string;
  parentTitle?: string;
}
type AuthState =
  | { phase: 'pending' }
  | { phase: 'ready'; name?: string }
  | { phase: 'failed'; reason: string }
  /** The bearer token is minted; a biometric check the owner turned on failed or was cancelled. Recoverable -- see `retryUnlock`, never a dead end. */
  | { phase: 'locked'; name?: string };

/**
 * How long the boot has been working, under the skeleton rows.
 *
 * beautifului's loading state ("Churning 0.3s") is the reference: a wait
 * with a clock reads as attended, a wait without one reads as stuck. The
 * two-second delay keeps fast boots from flashing a number that nobody
 * had time to worry about.
 */
function BootElapsed() {
  const elapsed = useActivityElapsed(null, true);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setShow(true), 2000);
    return () => window.clearTimeout(t);
  }, []);
  if (!show) return null;
  return (
    // role="timer", not status: a ticking clock must not turn a screen
    // reader into a metronome, and a timer carries live="off" by default.
    <p className="boot-elapsed" role="timer">
      Connecting… {workedFor(elapsed)}
    </p>
  );
}

/** A trimmed session, cached for the skeleton boot render. Never anything sensitive -- title and status only. */
interface SkeletonSession {
  id: string;
  title: string;
  status: string;
  unread: boolean;
}

/** Equal for rendering purposes: everything but the ever-ticking uptime. */
function sameStatus(a: StatusResponse, b: StatusResponse): boolean {
  return (
    JSON.stringify({ ...a, uptimeMs: 0 }) === JSON.stringify({ ...b, uptimeMs: 0 })
  );
}

const SKELETON_KEY = 'sessionSkeleton';
const BIOMETRICS_KEY = 'biometricsEnabled';

type PickerState =
  | { kind: 'none' }
  | { kind: 'model'; anchor: HTMLElement };

const PROVIDER_KEY = 'miniapp.provider';
const MODEL_KEY = 'miniapp.model';
const EFFORT_KEY = 'miniapp.effort';

/**
 * The permission menu, if /status has not answered yet.
 *
 * Hard-coded rather than left empty because these three are the daemon's
 * whole enum -- it validates against exactly this list -- so there is
 * nothing to discover and no risk of showing a mode that does not exist.
 */
/** Horizontal travel before a swipe across the home screen is read as intent. */
const SWIPE_CLAIM_PX = 14;
/** How much horizontal must beat vertical to count as a sideways gesture. */
const SWIPE_DOMINANCE = 1.4;

const FALLBACK_PERMISSION_MENU = [
  { id: 'read-only', label: 'Read only' },
  { id: 'guard', label: 'Guard' },
  { id: 'full-access', label: 'Full access' },
];

/**
 * Which home composition the shell shows, derived from the existing home
 * scroll handler (never a second scroller or a duplicate composer).
 *
 * `hero` is the resting panel: greeting, centred composer, cue. The first
 * deliberate movement into Recents flips to `history`, so the composer
 * docks immediately instead of travelling through the middle of the list
 * while the page scrolls. Pure so the threshold is unit-testable without
 * mounting the app.
 */
export function homePhaseFor(scrollTop: number, _clientHeight: number): 'hero' | 'history' {
  return scrollTop <= 2 ? 'hero' : 'history';
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ phase: 'pending' });
  /** Mirrors `data-home-phase` on the home shell; written by `updateHomeScrim`. */
  const [homePhase, setHomePhase] = useState<'hero' | 'history'>('hero');
  /**
   * The open threads, innermost last. Home is the empty stack.
   *
   * A stack rather than a single screen because a subagent card opens the
   * child's own thread, and backing out of it has to land on the parent
   * rather than on the session list.
   */
  const [stack, setStack] = useState<ThreadScreenState[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  // Current list for the poll's no-change check (includes optimistic edits).
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [picker, setPicker] = useState<PickerState>({ kind: 'none' });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /** The Settings screen, opened from the model picker's Settings row. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * The tab deck, opened from the home topbar.
   *
   * Separate state from `ThreadScreen`'s own copy on purpose: the two
   * screens never coexist, and threading one flag down through props would
   * couple them for no benefit.
   */
  const [homeTabsOpen, setHomeTabsOpen] = useState(false);

  /** Sessions waiting on the user, surfaced as a badge near the topbar. */
  const waitingCount = sessions.filter((s) => s.waiting).length;

  const attachments = useAttachments();

  /**
   * The home scroller and the history block inside it.
   *
   * Home is one tall scroll: a full-viewport resting panel, then the
   * session list below it. Both refs exist so the Recents cue can drive
   * the same movement the swipe does, and so backing out of a thread
   * returns to the resting panel rather than wherever the list was left.
   */
  const homeScroll = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  /*
   * The home screen's second page. Declared up here with the other hooks
   * because the screens below return early, and a hook behind a branch is
   * a hook that changes order between renders.
   */
  /*
   * Chat or search, and deliberately not persisted.
   *
   * A sticky mode is the classic source of "why did it do that": you come
   * back tomorrow, type a message to your agent, and it gets Googled. Every
   * cold launch starts in chat, so the default is always the one you can
   * guess without looking.
   */
  const [composerMode, setComposerMode] = useState<ComposerMode>('chat');

  /*
   * Swipe anywhere on the home screen to flip chat/web, on top of the
   * pill switch in the top bar. The pill is discovery, this is speed for
   * a thumb that already knows where it is going -- same idea as the old
   * side-page pager, but a screen-wide gesture instead of one scoped to
   * the composer, so it fires no matter where on the screen the swipe
   * starts.
   *
   * Right goes to web, left goes back to chat. Claim/dominance thresholds
   * match what the composer's own version and the old pager used, so a
   * vertical scroll (the home screen's Recents reveal) is never stolen:
   * the gesture is only read as horizontal once travel is unambiguous,
   * and a touch resolved vertical can never flip back.
   */
  const swipe = useRef({ x: 0, y: 0, resolved: '' as '' | 'x' | 'y' });

  const onHomeTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    swipe.current = { x: t.clientX, y: t.clientY, resolved: '' };
  }, []);

  const onHomeTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (swipe.current.resolved) return;
      const t = e.touches[0];
      const dx = t.clientX - swipe.current.x;
      const dy = t.clientY - swipe.current.y;
      if (Math.abs(dy) > SWIPE_CLAIM_PX && Math.abs(dy) > Math.abs(dx)) {
        swipe.current.resolved = 'y';
        return;
      }
      if (
        Math.abs(dx) > SWIPE_CLAIM_PX &&
        Math.abs(dx) > Math.abs(dy) * SWIPE_DOMINANCE
      ) {
        swipe.current.resolved = 'x';
        const next: ComposerMode = dx > 0 ? 'search' : 'chat';
        setComposerMode((prev) => {
          if (prev === next) return prev;
          haptic(next === 'search' ? 'light' : 'soft');
          return next;
        });
      }
    },
    [],
  );

  const onHomeTouchEnd = useCallback(() => {
    swipe.current.resolved = '';
  }, []);

  const omnibox = useOmnibox(
    draft,
    composerMode === 'search',
    useCallback(() => setDraft(''), []),
  );

  /*
   * Leaving search takes the suggestion list with it. Without this the
   * rows are still mounted behind the thread for as long as the draft is
   * unchanged, and flipping back shows a list built from a prefix that is
   * no longer in the box.
   */
  useEffect(() => {
    if (composerMode !== 'search') omnibox.clear();
  }, [composerMode, omnibox.clear]);
  // The two elements the dock-height measurement needs: the shell it
  // writes the variable onto, and the dock it measures.
  const homeShell = useRef<HTMLDivElement>(null);
  const homeDock = useRef<HTMLElement>(null);
  const homeVisible = auth.phase === 'ready' && stack.length === 0 && !settingsOpen;
  useDockHeight(homeShell, homeDock, homeVisible);

  /**
   * Same scrim rule as the thread: no haze when there is nothing under the
   * dock. The recents list is long enough to scroll, so the home screen
   * had the identical "permanent frosted bar" problem at its end.
   */
  /**
   * One handler, two jobs: the dock scrim and the home phase.
   *
   * The phase flip lives here (rather than in its own scroll listener)
   * so there is exactly one reader of `homeScroll.scrollTop`: at rest the
   * shell reads `hero` and the dock centres, 10% of a viewport down it
   * reads `history` and the dock is back at the bottom. The shell dataset
   * is written imperatively for the same frame the attribute commits in.
   */
  const updateHomeScrim = useCallback(() => {
    const el = homeScroll.current;
    const dock = homeDock.current;
    if (!el || !dock) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    dock.dataset.atEnd = remaining <= 2 ? 'true' : 'false';
    const phase = homePhaseFor(el.scrollTop, el.clientHeight);
    if (homeShell.current) homeShell.current.dataset.homePhase = phase;
    setHomePhase((prev) => (prev === phase ? prev : phase));
  }, []);

  useEffect(() => {
    updateHomeScrim();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updateHomeScrim);
    if (homeScroll.current) observer.observe(homeScroll.current);
    if (homeDock.current) observer.observe(homeDock.current);
    return () => observer.disconnect();
  }, [updateHomeScrim, sessions]);

  useEffect(() => {
    if (!homeVisible) return undefined;
    setHomePhase('hero');
    const frame = requestAnimationFrame(updateHomeScrim);
    return () => cancelAnimationFrame(frame);
  }, [homeVisible, updateHomeScrim]);

  const scrollToHistory = useCallback(() => {
    haptic('light');
    const reduceMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    historyRef.current?.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'start',
    });
  }, []);

  // The blank history's way home: back to the hero, where the composer
  // (always docked) is the obvious next move.
  const scrollToTop = useCallback(() => {
    const reduceMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    homeScroll.current?.scrollTo({
      top: 0,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, []);

  // A chosen model/effort sticks across launches; until one is chosen the
  // pills mirror whatever the daemon's own default is.
  const [provider, setProvider] = useState(
    () => readLocal(PROVIDER_KEY) || '',
  );
  const [modelId, setModelId] = useState(
    () => readLocal(MODEL_KEY) || '',
  );
  const [effort, setEffort] = useState(
    () => readLocal(EFFORT_KEY) || '',
  );

  /**
   * The permission a NEW session should get.
   *
   * There is no session to write to on the home screen, so the choice is
   * held here and applied right after the CLI hands back an id -- the same
   * create-then-update shape the Python bridge uses. `null` means "leave
   * the daemon's default alone", which is the honest default.
   */
  const [newMode, setNewMode] = useState<string | null>(null);
  const [newFinalConfirm, setNewFinalConfirm] = useState<boolean | null>(null);

  /**
   * Cached titles for the FIRST frame, before auth has even resolved.
   * Read once at mount -- this is a cosmetic skeleton, not live data, so it
   * does not need to react to anything. Written in `loadSessions` below.
   */
  const [skeleton, setSkeleton] = useState<SkeletonSession[]>([]);
  useEffect(() => {
    cloudStorage.getItem(SKELETON_KEY).then((raw) => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setSkeleton(parsed);
      } catch {
        // stale/corrupt cache -- the real load a moment later replaces it
      }
    });
  }, []);

  /**
   * Run (or re-run) the biometric gate a successful `/api/auth` sits
   * behind, when the owner has opted in via Settings. See
   * `authenticateIfEnabled` in telegram.ts for the fail-open contract:
   * this only ever resolves `false` on an explicit, granted, failed
   * attempt -- never because the feature is unsupported or unset.
   */
  const runBiometricGate = useCallback(async (name?: string) => {
    const enabled = (await cloudStorage.getItem(BIOMETRICS_KEY)) === '1';
    const ok = await authenticateIfEnabled(enabled, 'Unlock Aside');
    setAuth(ok ? { phase: 'ready', name } : { phase: 'locked', name });
  }, []);

  // --- auth ---------------------------------------------------------------
  useEffect(() => {
    initTelegram();
    applyTheme();
    const off = onThemeChanged(applyTheme);
    stashDevInitData(location.hash);

    const raw = readInitData();
    if (raw) {
      api.auth(raw).then(
        (res) => {
          setAuthToken(res.token);
          void runBiometricGate(res.user.firstName);
        },
        (err) => setAuth({ phase: 'failed', reason: (err as Error).message }),
      );
      return off;
    }

    /*
     * A 401 anywhere means this device's credential is dead, whenever that
     * happens. The commonest cause is the documented revocation path:
     * deleting the signing secret on the Mac leaves every issued token
     * unexpired but unverifiable, and the boot path trusts `exp` without
     * checking a signature. Without this the phone renders the whole UI,
     * fails every call, and shows nothing at all -- the send button just
     * stops working. Drop the dead token and ask to be paired again.
     */
    setUnauthorizedHandler(() => {
      /*
       * Two different situations produce the same 401 and they need
       * different words. A device that HAD a token has been revoked, and
       * saying so is the only way the owner knows re-pairing is the fix. A
       * device that never had one is simply new, and telling it the Mac "no
       * longer recognises" it describes a relationship that never existed.
       */
      const wasPaired = Boolean(readStoredToken());
      clearStoredToken();
      setAuth({
        phase: 'failed',
        reason: wasPaired
          ? 'Your Mac no longer recognises this device. Paste a fresh pairing link from your Mac below.'
          : 'Not paired yet. Paste the pairing link from your Mac below.',
      });
    });

    // No initData: this is the installed app, opened from the home screen
    // rather than launched by Telegram. Same JWT spine, different front door.
    resolveStandaloneAuth().then((result) => {
      if (result.ok) {
        setAuthToken(result.token);
        void runBiometricGate(result.name);
        return;
      }
      setAuth({
        phase: 'failed',
        reason:
          result.reason === 'pair_rejected'
            ? 'That pairing link is no longer valid. Generate a new one on your Mac and paste it below.'
            : result.reason === 'offline'
              ? PHONE_OFFLINE_MESSAGE
              : result.reason === 'unreachable'
                ? pairUnreachableMessage()
                : 'Not paired yet. Paste the pairing link from your Mac below.',
      });
    });
    return () => {
      off();
      setUnauthorizedHandler(null);
    };
  }, [runBiometricGate]);

  // --- data ---------------------------------------------------------------
  const loadSessions = useCallback(async () => {
    try {
      const res = await api.sessions();
      /*
       * The home list polls every 8s and the answer is usually identical.
       * Handing React a fresh-but-equal array re-rendered the whole glass
       * home screen on every tick, which read as a periodic stutter. Keep
       * the current array when nothing changed; comparing against current
       * state (not the last server copy) keeps optimistic deletes honest.
       */
      if (JSON.stringify(sessionsRef.current) === JSON.stringify(res.sessions)) return;
      setSessions(res.sessions);
      // Cosmetic only -- trimmed to what the skeleton actually draws, and
      // small enough to stay well under CloudStorage's 4096-char value cap.
      const cache: SkeletonSession[] = res.sessions.slice(0, 12).map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        unread: s.unread,
      }));
      void cloudStorage.setItem(SKELETON_KEY, JSON.stringify(cache));
    } catch {
      // The list keeps its previous contents rather than blanking out.
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  /**
   * Delete a chat from history.
   *
   * Optimistic: the row goes the instant the request is sent, because a
   * spinner on a row the user has already decided about is just latency
   * they have to watch. `loadSessions()` reconciles either way -- on
   * success it confirms, on failure it puts the row back -- so the list
   * ends up agreeing with the server rather than with this handler.
   */
  const deleteSession = useCallback(
    async (id: string) => {
      setSessions((prev) => prev.filter((session) => session.id !== id));
      try {
        await api.deleteSession(id);
        toast('Chat deleted');
      } catch {
        // Nothing to say here; the reload below is the authority on what
        // actually still exists.
      }
      void loadSessions();
    },
    [loadSessions],
  );

  useEffect(() => {
    if (auth.phase !== 'ready') return;
    void loadSessions();
    api.status().then(setStatus, () => {});
    // Refresh the failover list the shell was served with. Relays verify
    // asynchronously after the server boots, so the meta tag baked into
    // the HTML can lag behind reality on the first load after a restart.
    api.relays().then(
      (res) => setRefreshedRelays(res.relays.map((entry) => entry.url)),
      () => {},
    );
  }, [auth.phase, loadSessions]);

  // The desktop catalog can change while the installed app stays alive.
  // Refresh it on a short visible-only loop, and immediately when the phone
  // returns from the background, instead of freezing the boot-time copy.
  useEffect(() => {
    if (auth.phase !== 'ready') return undefined;
    return startVisiblePolling(async () => {
      const next = await api.status();
      // `uptimeMs` ticks on every call and nothing renders it; ignoring it
      // lets an unchanged catalog skip a full re-render every 8 seconds.
      setStatus((prev) =>
        prev && sameStatus(prev, next) ? prev : next,
      );
    }, 8_000);
  }, [auth.phase]);

  // --- navigation ---------------------------------------------------------
  const screen = stack[stack.length - 1] as ThreadScreenState | undefined;

  /*
   * The standalone artwork is present before React mounts so auth can never
   * produce a white-then-image flash. Hand ownership to the real home shell
   * in a layout effect, before the browser paints the ready screen; threads
   * and Settings drop the temporary boot artwork in the same phase.
   */
  useLayoutEffect(() => {
    if (!isStandaloneEntry()) return;
    document.documentElement.dataset.surface =
      auth.phase !== 'ready'
        ? 'boot'
        : !screen && !settingsOpen
          ? 'home'
          : 'plain';
  }, [auth.phase, screen, settingsOpen]);

  // Keep the home list fresh so unread dots and running spinners track the
  // browser without a manual pull.
  useEffect(() => {
    if (auth.phase !== 'ready' || screen) return;
    return startVisiblePolling(loadSessions, 8_000);
  }, [auth.phase, screen, loadSessions]);

  const openThread = useCallback(
    (next: ThreadScreenState, replace = true) => {
      setStack((prev) => (replace ? [next] : [...prev, next]));
      setDraft('');
      attachments.clear();
      // Only the root thread counts as "where you left off" -- a subagent
      // push (replace=false) is a detour, not the place cold boot should
      // land back on.
      if (replace) void cloudStorage.setItem('lastSessionId', next.id);
    },
    [attachments],
  );

  /** Back: out of a subagent to its parent, or out of the last thread home. */
  const goBack = useCallback(() => {
    setStack((prev) => prev.slice(0, -1));
    setDraft('');
    attachments.clear();
    if (stack.length <= 1) {
      void loadSessions();
      void cloudStorage.removeItem('lastSessionId');
    }
  }, [loadSessions, attachments, stack.length]);

  // Deep-link continuity: land on the specific thread a push notification
  // pointed at, else whatever thread was open last. The deep link wins
  // because a fresh notification tap is a more specific intent than "wherever
  // I left off". The ref guard prevents a double-open when both fire.
  const restoredThread = useRef(false);
  useEffect(() => {
    if (auth.phase !== 'ready' || restoredThread.current) return;
    restoredThread.current = true;
    const startParam = readStartParam();
    if (startParam && startParam.startsWith('session_')) {
      const id = startParam.slice('session_'.length);
      if (id) {
        openThread({ id });
        return;
      }
    }
    void cloudStorage.getItem('lastSessionId').then((id) => {
      if (id) openThread({ id });
    });
  }, [auth.phase, openThread]);

  useEffect(() => {
    if (!screen) return undefined;
    // show() hands back its own teardown, which both unbinds and hides.
    return backButton.show(goBack);
  }, [screen, goBack]);

  // --- pills --------------------------------------------------------------
  /**
   * An explicit local pick wins; otherwise the pills mirror the daemon's
   * own account default, so someone who has never chosen sees what the
   * browser would use. The precedence lives in `resolvePills`, which is
   * tested directly.
   */
  const pills = useMemo(
    () => resolvePills(status, { provider, modelId, effort }),
    [status, provider, modelId, effort],
  );

  // A stored pick the live catalog cannot honor stays stored but stops
  // running -- resolvePills falls back to the daemon default, and the pick
  // resumes on its own if the Mac offers it again. This effect only
  // narrates those transitions, once each: a toast when the fallback
  // engages, another when the pick comes back. It stays silent for the
  // user's own picks, which need no explanation.
  const healNote = useRef<{
    pick: string;
    degraded: 'removed' | 'disconnected' | null;
    effortDegraded: boolean;
  } | null>(null);
  useEffect(() => {
    if (!status) return;
    const pickKey = `${provider}/${modelId}|${effort}`;
    const prev = healNote.current;
    healNote.current = {
      pick: pickKey,
      degraded: pills.modelDegraded,
      effortDegraded: pills.effortDegraded,
    };
    // The stored pick itself changed: the user's own action, already
    // visible in the pills. Only catalog-side transitions get a toast.
    if (prev && prev.pick !== pickKey) return;
    if (pills.modelDegraded && pills.modelDegraded !== prev?.degraded) {
      if (pills.modelDegraded === 'disconnected') {
        const name =
          status.catalog.find((entry) => entry.id === provider)?.label ||
          provider ||
          'That provider';
        toast(`${name} disconnected — using ${pills.modelLabel} until it returns`);
      } else {
        toast(
          `${modelId || 'That model'} is no longer on your Mac — using ${pills.modelLabel}`,
        );
      }
    } else if (!pills.modelDegraded && prev?.degraded && provider && modelId) {
      toast(`${pills.modelLabel} is available again — pick resumed`);
    }
    if (pills.effortDegraded && !prev?.effortDegraded && effort) {
      toast(
        `Reasoning “${effort}” is no longer offered — using ${pills.effortLabel}`,
      );
    }
  }, [status, pills, provider, modelId, effort]);

  const permissionMenu = status?.permissionMenu?.length
    ? status.permissionMenu
    : FALLBACK_PERMISSION_MENU;

  const pickModel = (nextProvider: string, nextModel: string) => {
    setProvider(nextProvider);
    setModelId(nextModel);
    writeLocal(PROVIDER_KEY, nextProvider);
    writeLocal(MODEL_KEY, nextModel);
    haptic('select');
  };

  const pickEffort = (next: string) => {
    setEffort(next);
    writeLocal(EFFORT_KEY, next);
    haptic('select');
  };

  /** The CLI takes `provider/modelId`; a bare id means "daemon default". */
  const wireModel = () =>
    pills.provider && pills.modelId
      ? `${pills.provider}/${pills.modelId}`
      : undefined;

  // --- sending ------------------------------------------------------------
  const startSession = async () => {
    const text = draft.trim();
    const files = attachments.readyPaths();
    if ((!text && !files.length) || sending) return;
    setSending(true);
    try {
      const res = await api.newSession({
        text,
        model: wireModel(),
        effort: pills.effortId,
        attachments: files,
        permissionMode: newMode ?? undefined,
        finalConfirm: newFinalConfirm ?? undefined,
      });
      setDraft('');
      attachments.clear();
      await loadSessions();
      openThread({ id: res.sessionId });
    } catch {
      // Surfaced as an error card once the turn reports back.
    } finally {
      setSending(false);
    }
  };

  if (auth.phase === 'pending') {
    // A skeleton from LAST session's cached titles beats a bare spinner --
    // the plan's own "never a spinner on empty" rule (9.3). Falls back to
    // the spinner on a true cold start, before anything has ever cached.
    if (skeleton.length) {
      return (
        <div className="boot boot-skeleton">
          {skeleton.map((row) => (
            <div className="boot-skeleton-row" key={row.id}>
              <span className={`boot-skeleton-dot ${row.unread ? 'is-unread' : ''}`} />
              <span className="boot-skeleton-title">{row.title}</span>
            </div>
          ))}
          <BootElapsed />
        </div>
      );
    }
    return (
      <div className="boot">
        <Spinner size={18} />
        <BootElapsed />
      </div>
    );
  }
  if (auth.phase === 'failed') {
    return (
      <div className="boot">
        <span className="boot-failure-mark" aria-hidden="true">
          <AsideSymbol size={24} />
        </span>
        <p className="boot-title">Can’t sign in</p>
        <p className="boot-reason">{auth.reason}</p>
        {/*
          Offered on every failure, not only the unpaired one. A rejected
          key and an unreachable Mac both leave the owner holding a link
          that might work, and the alternative on a phone is no way
          forward at all.
        */}
        <PairPrompt
          onPaired={(token, name) => {
            setAuthToken(token);
            void runBiometricGate(name);
          }}
        />
      </div>
    );
  }
  if (auth.phase === 'locked') {
    return (
      <div className="boot">
        <p className="boot-title">Locked</p>
        <p className="boot-reason">Face ID / Touch ID didn’t confirm it was you.</p>
        <button
          type="button"
          className="boot-retry"
          onClick={() => {
            haptic('light');
            void runBiometricGate(auth.name);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  const openModel = (anchor: HTMLElement) => setPicker({ kind: 'model', anchor });
  const closePicker = () => setPicker({ kind: 'none' });

  /**
   * The open picker, with its checkmark on whatever the *caller* is
   * currently running -- the account default on home, the session's own
   * settings inside a thread.
   */
  const renderPicker = (current: {
    provider: string;
    modelId: string;
    effortId: string;
    permissionMode: string | null;
    finalConfirm: boolean | null;
    softConfirm?: boolean;
    onPickMode: (id: string) => void;
    onToggleConfirm: (next: boolean) => void;
    onPickModel: (provider: string, modelId: string) => void;
    onPickEffort: (id: string) => void;
  }) =>
    picker.kind === 'model' && status ? (
      <Suspense fallback={null}>
        <ModelSheet
        catalog={status.catalog}
        currentProvider={current.provider}
        currentModel={current.modelId}
        effortOptions={status.effortMenu}
        currentEffort={current.effortId}
        permissionOptions={permissionMenu}
        permissionMode={current.permissionMode}
        finalConfirm={current.finalConfirm}
        softConfirm={current.softConfirm}
        onPickMode={current.onPickMode}
        onToggleConfirm={current.onToggleConfirm}
        onPickModel={current.onPickModel}
        onPickEffort={current.onPickEffort}
        onClose={closePicker}
          onOpenSettings={() => {
            closePicker();
            setSettingsOpen(true);
          }}
        />
      </Suspense>
    ) : null;

  // Settings is a full screen rather than a sheet: it is a destination with
  // its own back affordance, which is how Aside treats it too.
  if (settingsOpen) {
    return (
      <Suspense fallback={null}>
        <SettingsScreen status={status} onClose={() => setSettingsOpen(false)} />
      </Suspense>
    );
  }

  if (!screen) {
    return (
      <div
        className={`app app-home${sessions.length ? ' has-history' : ''}${composerMode === 'search' ? ' mode-web' : ''}`}
        data-home-phase={homePhase}
        ref={homeShell}
        onTouchStart={onHomeTouchStart}
        onTouchMove={onHomeTouchMove}
        onTouchEnd={onHomeTouchEnd}
        onTouchCancel={onHomeTouchEnd}
      >
        {/*
          Home screen only. It refers to Safari's Share button, so it
          belongs on the screen the app opens to rather than inside a
          conversation the owner has deliberately navigated into.
        */}
        <InstallHint />
        <RelayBanner />
        {/*
          One scroller holding two full panels. The composer is NOT in it:
          it is docked below, so the software keyboard cannot push it out
          of reach and the history genuinely scrolls up from underneath it,
          which is the whole point of the layout.
        */}
        <main className="home-scroll" ref={homeScroll} onScroll={updateHomeScrim}>
          <section className="home-rest">
            {/*
              Browser, not Settings.
              
              Settings used to live here AND as a row at the bottom of the
              model sheet, which is two routes to a screen visited about
              once a month -- the model sheet keeps it, since that is where
              you already are when you want it.

              The tab deck earns the slot instead. It was reachable only
              from a globe icon inside a thread header, which means it was
              invisible unless you had already opened a conversation, and
              seeing what is open on the Mac is a reason to pick the phone
              up rather than something you go looking for mid-thread.
            */}
            <div className="home-topbar">
              {/*
                Centred on the SCREEN, not on the space left over by its
                neighbours: it is positioned absolutely so the waiting badge
                appearing or disappearing cannot shunt it sideways.

                The magnifier that used to sit here is gone rather than
                moved. Its only job was travelling to the search page, and
                search is a mode now, so there is nowhere for it to go.
              */}
              <ModeSwitch mode={composerMode} onChange={setComposerMode} />
              {waitingCount > 0 ? (
                <span className="waiting-badge" aria-label={`${waitingCount} waiting`}>{waitingCount}</span>
              ) : null}
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  haptic('light');
                  setHomeTabsOpen(true);
                }}
                aria-label="Browser tabs"
              >
                <Globe size={19} strokeWidth={1.75} />
              </button>
            </div>
            <PullToRefresh
              scroller={homeScroll}
              onRefresh={loadSessions}
              disabled={loadingSessions}
            >
              <RestHero name={auth.phase === 'ready' ? auth.name : undefined} />
              <RestCue count={sessions.length} onOpen={scrollToHistory} />
            </PullToRefresh>
          </section>
          <section className="home-history" ref={historyRef}>
            <h2 className="home-history-head">Recent work</h2>
            <SessionList
              sessions={sessions}
              onOpen={(id) => openThread({ id })}
              loading={loadingSessions}
              onDelete={deleteSession}
              onNewChat={() => {
                setDraft('');
                scrollToTop();
              }}
              onOpenTabs={() => setHomeTabsOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </section>
        </main>

        <footer className="home-dock" ref={homeDock}>
          <Composer
            variant="home"
            value={draft}
            onChange={setDraft}
            onSubmit={
              composerMode === 'search' ? () => omnibox.runQuery(draft) : startSession
            }
            pills={pills}
            onOpenModel={openModel}
            attachments={attachments.items}
            onAddFiles={(files) => attachments.add(files)}
            onRemoveAttachment={attachments.remove}
            busy={sending}
            disabled={sending}
            mode={composerMode}
            above={
              composerMode === 'search' ? (
                <OmniboxResults
                  items={omnibox.items}
                  query={draft}
                  onPick={omnibox.pick}
                />
              ) : undefined
            }
          />
        </footer>
        {renderPicker({
          ...pills,
          permissionMode: newMode,
          finalConfirm: newFinalConfirm,
          // A session started here is a mobile session by definition.
          softConfirm: true,
          onPickMode: (id) => {
            setNewMode(id);
            haptic('light');
          },
          onToggleConfirm: (next) => {
            setNewFinalConfirm(next);
            haptic('light');
            playSound('toggle');
          },
          onPickModel: pickModel,
          onPickEffort: pickEffort,
        })}
        {homeTabsOpen ? (
          <Suspense fallback={null}>
            <TabDeck onClose={() => setHomeTabsOpen(false)} />
          </Suspense>
        ) : null}
        <ToastHost />
      </div>
    );
  }

  return (
    <ThreadScreen
      key={screen.id}
      sessionId={screen.id}
      parentTitle={screen.parentTitle}
      onBack={goBack}
      onInspectSubagent={(id, parentTitle) =>
        openThread({ id, parentTitle }, false)
      }
      onOpenRecovered={(id) => {
        void loadSessions();
        openThread({ id });
      }}
      pills={pills}
      catalog={status?.catalog}
      draft={draft}
      setDraft={setDraft}
      attachments={attachments}
      openModel={openModel}
      renderPicker={renderPicker}
    />
  );
}

function ThreadScreen({
  sessionId,
  parentTitle,
  onBack,
  onInspectSubagent,
  onOpenRecovered,
  pills,
  catalog,
  draft,
  setDraft,
  attachments,
  openModel,
  renderPicker,
}: {
  sessionId: string;
  /** Set when this thread was opened from a subagent card. */
  parentTitle?: string;
  onBack: () => void;
  /** Push a child thread; the second argument is THIS thread's title. */
  onInspectSubagent: (childId: string, parentTitle: string) => void;
  /** Replace this thread with the session that continues from it. */
  onOpenRecovered: (sessionId: string) => void;
  pills: {
    provider: string;
    modelId: string;
    modelLabel: string;
    effortLabel: string;
    effortId: string;
  };
  /** The live catalog, so a stale session model falls back instead of running. */
  catalog: CatalogProvider[] | undefined;
  draft: string;
  setDraft: (value: string) => void;
  attachments: ReturnType<typeof useAttachments>;
  openModel: (anchor: HTMLElement) => void;
  renderPicker: (current: {
    provider: string;
    modelId: string;
    effortId: string;
    permissionMode: string | null;
    finalConfirm: boolean | null;
    softConfirm?: boolean;
    onPickMode: (id: string) => void;
    onToggleConfirm: (next: boolean) => void;
    onPickModel: (provider: string, modelId: string) => void;
    onPickEffort: (id: string) => void;
  }) => React.ReactNode;
}) {
  const thread = useThread(sessionId);
  const scroller = useRef<HTMLDivElement>(null);
  const threadShell = useRef<HTMLDivElement>(null);
  const threadDock = useRef<HTMLElement>(null);
  useDockHeight(threadShell, threadDock);
  const [sending, setSending] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [tabDeckOpen, setTabDeckOpen] = useState(false);
  const [citation, setCitation] = useState<CitationMark | null>(null);
  const [recovering, setRecovering] = useState(false);
  const recoveryFlight = useRef<Promise<void> | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const activeTurn = thread.busy && !thread.suspended;
  const activity = activityPhase(thread.items, thread.connected, thread.stopping, thread.activity);
  /*
   * One live control per turn, always after the transcript. If a work run
   * exists, its final run is detached so the same expandable control can
   * sit at the bottom while output grows above it. Before the first tool,
   * the standalone footer uses the identical two-line treatment.
   */
  const liveWork = activeTurn ? liveWorkBlock(thread.items) : null;
  /*
   * The answer has started streaming while the turn still runs. The tail
   * settles into its collapsed form early rather than keeping the live
   * thinking treatment underneath an answer that has begun -- and when
   * there is no run to fold, the footer stands down entirely, leaving
   * the island above the composer as the remaining stop control.
   */
  const answering = activeTurn && tailIsAnswering(thread.items);
  const liveActivity = activeTurn
    ? {
        label: activity.label,
        work: activity.work,
        detail: activity.detail,
        startedAt: thread.stats.turnStartedAt,
        tokens: thread.stats.turnTokens,
        /* Stable for the turn; elapsed slots advance through its word list. */
        seed: `${sessionId}:${thread.stats.turnStartedAt ?? ''}`,
      }
    : null;
  const [optimisticModel, setOptimisticModel] = useState(thread.model);

  useEffect(() => {
    setOptimisticModel(thread.model);
  }, [thread.model]);

  // A stray swipe-to-close should not be able to drop a running turn.
  // Cleared unconditionally on unmount so leaving the thread never leaves
  // the confirmation dangling on some other screen.
  useEffect(() => {
    if (activeTurn) enableClosingConfirmation();
    else disableClosingConfirmation();
    return () => disableClosingConfirmation();
  }, [activeTurn]);

  /*
   * The recovery beat for a dropped socket. The footer says
   * "Reconnecting…" while down (via activityPhase); this says it came
   * back. Keyed on the timestamp so repeated drops each announce once,
   * and the ref keeps StrictMode's double-effect from toasting twice.
   */
  const lastToastedReconnect = useRef(0);
  useEffect(() => {
    if (thread.reconnectedAt > lastToastedReconnect.current) {
      lastToastedReconnect.current = thread.reconnectedAt;
      toast('Reconnected — catching up');
    }
  }, [thread.reconnectedAt]);

  const effective = resolveThreadModel(optimisticModel, pills, catalog);

  const updateSessionModel = async (next: {
    provider: string;
    modelId: string;
    effort: string;
    label?: string;
  }) => {
    const previous = optimisticModel;
    setOptimisticModel({
      provider: next.provider,
      modelId: next.modelId,
      label: next.label || next.modelId,
      effort: next.effort,
      effortLabel: next.effort,
    });
    try {
      const result = await api.sessionModel(sessionId, next);
      setOptimisticModel(result.model);
    } catch (err) {
      setOptimisticModel(previous);
      throw err;
    }
  };

  /**
   * Tell the composer's scrim whether anything is still below the fold.
   *
   * The haze exists to dissolve text sliding under the composer. At the
   * very end of a thread there is no such text -- it is blurring blank
   * page, which is what made it read as a permanent frosted bar rather
   * than an effect. So the scrim is switched off there and fades back in
   * the moment there is something under it again.
   *
   * Written as a DOM attribute rather than React state on purpose: this
   * runs on every scroll event, and a re-render of the whole thread per
   * frame is exactly the kind of thing that makes scrolling feel cheap.
   */
  const updateScrim = useCallback(() => {
    const el = scroller.current;
    const dock = threadDock.current;
    if (!el || !dock) return;
    // 2px, not 0: fractional scroll heights are normal once the content has
    // images and safe-area padding in it, and a half-pixel of slack must
    // not count as "there is more to read".
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    dock.dataset.atEnd = remaining <= 2 ? 'true' : 'false';
    if (threadShell.current) threadShell.current.dataset.atStart = el.scrollTop <= 2 ? 'true' : 'false';
  }, []);

  // Stay pinned to the newest content while a turn streams, but never yank
  // the view away from someone who has scrolled up to read.
  const pinned = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
    // After the scroll, not before: the answer that just arrived may be the
    // reason there is now something below the fold, or the reason there
    // isn't.
    updateScrim();
  }, [thread.items, updateScrim]);

  const updateLiveTailLayout = useCallback(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
    updateScrim();
  }, [updateScrim]);

  /*
   * The dock's own height changes as the draft grows and as the task list
   * appears, and either can turn "at the end" into "not at the end" without
   * a scroll event ever firing.
   */
  useEffect(() => {
    updateScrim();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updateScrim);
    if (scroller.current) observer.observe(scroller.current);
    if (threadDock.current) observer.observe(threadDock.current);
    return () => observer.disconnect();
  }, [updateScrim]);

  /*
   * Landing: opening a session starts at the newest message.
   *
   * `pinned` starts true and the effect above does set `scrollTop` once
   * the items arrive, so this looked solved. It was not, because the
   * height it scrolls to is not the final height. Markdown bodies are
   * rendered deferred (see MarkdownAsync), code blocks highlight after
   * that, the prose webfont swaps in, and every one of those lands after
   * the first paint and makes the transcript taller. Scrolling to the
   * bottom of a transcript that is still growing leaves you some way
   * above the real bottom -- the more there is to render, the further up
   * you end.
   *
   * So the landing is held open until the height stops changing, rather
   * than fired once and hoped over: re-pin every frame, and end when
   * three consecutive frames agree on `scrollHeight`. Three, because the
   * async chunks land one after another and a single matching pair
   * happens in the gap between two of them.
   *
   * `behavior: instant` is explicit -- the scroller sets `scroll-behavior:
   * smooth` for in-page jumps, and inheriting it here would animate a
   * multi-thousand-pixel scroll on open, which is the visible "flying to
   * the bottom" this is meant to avoid.
   *
   * The 1200ms stop is a floor, not the mechanism: a transcript that never
   * settles must not trap the scroll position forever.
   */
  const landing = useRef(true);
  const landingTimer = useRef<number | null>(null);

  /*
   * Arm the guard: "the scroll position is ours for the moment".
   *
   * Both the session open and the jump button need the same thing --
   * hold the view at the end while the document is still growing under
   * it -- so they share one flag rather than each inventing a window.
   * Re-armable, because a jump can happen long after the open.
   */
  const armLanding = useCallback(() => {
    landing.current = true;
    if (landingTimer.current !== null) window.clearTimeout(landingTimer.current);
    landingTimer.current = window.setTimeout(() => {
      landing.current = false;
      landingTimer.current = null;
    }, 4000);
  }, []);

  useEffect(() => {
    armLanding();
    pinned.current = true;
  }, [sessionId, armLanding]);

  /*
   * Stick to the bottom whenever the content grows under us.
   *
   * The first attempt at this was a rAF loop that gave up after 1200ms.
   * It was not enough, and the reason is worth keeping: the transcript
   * that most needs to land at the bottom is the long one, and the long
   * one is exactly the one whose deferred markdown, highlighting and font
   * swap take longest to finish. Measured on a real session here, the
   * scroller settled 6802px above the true bottom -- the timer expired
   * with two thirds of the document still to lay out.
   *
   * A clock was the wrong instrument. This watches the thing that
   * actually matters: the height of the content. Any growth while we are
   * pinned re-pins, for as long as it keeps growing, whether that is two
   * frames or ten seconds. It covers the open, the stream and the late
   * async chunk with one mechanism, and it costs nothing when idle.
   *
   * The children are observed rather than the scroller, because a
   * scroll container's own box does not change when its content does.
   * The MutationObserver re-subscribes when React swaps that child list.
   */
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const stick = () => {
      if (!pinned.current && !landing.current) return;
      el.scrollTo({ top: el.scrollHeight, behavior: 'instant' as ScrollBehavior });
      updateScrim();
    };
    const ro = new ResizeObserver(stick);
    const watch = () => {
      ro.disconnect();
      for (const child of Array.from(el.children)) ro.observe(child);
    };
    watch();
    const mo = new MutationObserver(() => {
      watch();
      stick();
    });
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [updateScrim]);

  useEffect(
    () => () => {
      if (landingTimer.current !== null) window.clearTimeout(landingTimer.current);
    },
    [],
  );

  /* A real gesture outranks the landing: if you reach for the transcript
     while it is still settling, it is yours. */
  const releaseLanding = useCallback(() => {
    landing.current = false;
    if (landingTimer.current !== null) {
      window.clearTimeout(landingTimer.current);
      landingTimer.current = null;
    }
  }, []);

  /*
   * Jump to latest.
   *
   * The counterpart to the landing fix: once you HAVE scrolled up to read
   * something, there was no way back to the live end except dragging the
   * whole way. Every chat client has this control and this one was
   * missing it.
   *
   * Smooth only over short distances, and the reason is a bug this hit
   * on the first build. `scrollTo` animates toward the height read at
   * the moment of the call, and a transcript that is still rendering is
   * taller by the time the animation ends -- so the smooth jump stopped
   * 1167px short of the bottom and stayed there, because nothing was
   * growing any more to trigger a correction.
   *
   * Under 1200px the animation is short enough that the target does not
   * drift, and the motion reads as a response to the tap. Over it, a
   * long smooth scroll through thousands of pixels of prose is slow and
   * unpleasant anyway, so it goes instantly.
   *
   * Either way `pinned` is set first, which hands the position to the
   * ResizeObserver above: if the answer is still streaming, arriving at
   * the end means staying at the end.
   */
  const jumpToLatest = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    /* Arm, not release: measured on a 31k transcript, an instant jump
       lands 464px short because the tail is still rendering. Holding the
       guard lets the observer above finish the job. */
    armLanding();
    pinned.current = true;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: (distance > 1200 ? 'instant' : 'smooth') as ScrollBehavior,
    });
    updateScrim();
  }, [updateScrim, armLanding]);

  /*
   * The header condenses while scrolling deep and expands the moment
   * the scroll turns upward (TypeUI hide-on-scroll bars, restrained:
   * this bar is in-flow, so hiding it would yank the transcript --
   * instead the subtitle collapses and the padding tightens). The
   * refs keep per-frame scroll events from becoming per-frame renders;
   * state flips only on a direction change past the threshold.
   */
  const [condensed, setCondensed] = useState(false);
  const lastScrollTop = useRef(0);
  const condensedRef = useRef(false);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollTop;
    const down = top > lastScrollTop.current + 4;
    const up = top < lastScrollTop.current - 4;
    lastScrollTop.current = top;
    const next = top > 90 && (down || (!up && condensedRef.current));
    if (next !== condensedRef.current) {
      condensedRef.current = next;
      setCondensed(next);
    }
    /*
     * While landing, scroll events are our own doing. Letting them set
     * `pinned` is how a slow-rendering transcript un-pins itself: the
     * programmatic scroll fires the handler, the content grows on the
     * next frame, and the gap is briefly over the threshold.
     */
    if (!landing.current) {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    }
    updateScrim();
  };

  const send = async () => {
    const text = draft.trim();
    const files = attachments.ready();
    if ((!text && !files.length) || sending) return;
    setSending(true);

    // The bubble goes up before the request does. This is the fix for
    // "the message I send isn't viewable right away": nothing about the
    // send needs to have succeeded for the user to see what they typed.
    thread.addPending({
      text,
      attachments: files.map((f) => ({ name: f.name, mimeType: f.mimeType })),
      at: Date.now(),
    });
    setDraft('');
    attachments.clear();
    pinned.current = true;

    try {
      // Send what the bar says. Passing the session's own model explicitly
      // keeps a continuation on the model it was already using instead of
      // silently switching it to the account default.
      await api.send(sessionId, {
        text,
        model:
          effective.provider && effective.modelId
            ? `${effective.provider}/${effective.modelId}`
            : undefined,
        effort: effective.effortId,
        attachments: files.map((f) => f.path!).filter(Boolean),
      });
    } finally {
      setSending(false);
    }
  };

  /**
   * Answer a question card by sending the chosen option as a message.
   *
   * Only soft-marker questions ever reach this: a native pending tool is
   * rendered read-only, because there is no request that can answer one.
   * The echo goes up first for the same reason `send` does it -- the tap
   * should be visible immediately.
   *
   * The echo text must match `answerMessage` in server/src/questions.ts
   * exactly: `pendingIsEchoed` retires the optimistic bubble by comparing
   * it against what the transcript ends up holding, so a format that
   * drifts from the server's leaves a ghost bubble on screen for the full
   * two-minute TTL. No leading dash -- see that function for why.
   */
  const answer = async (header: string, label: string) => {
    const text = header ? `${header}: ${label}` : label;
    thread.addPending({ text, attachments: [], at: Date.now() });
    pinned.current = true;
    try {
    await api.answer(sessionId, {
      header,
      label,
      model:
        effective.provider && effective.modelId
          ? `${effective.provider}/${effective.modelId}`
          : undefined,
      effort: effective.effortId,
    });
    } catch (err) {
      thread.clearPending();
      throw err;
    }
  };

  /**
   * Carry on from a question only the desktop could answer.
   *
   * The stuck session stays stuck -- nothing can change that -- so this
   * starts a NEW one, seeded by the server from the pending question, the
   * option just tapped, and the stuck session's own opening message. The
   * new thread replaces this one on screen, because it is where the
   * conversation actually continues.
   */
  const recover = (label: string, questionId?: string): Promise<void> => {
    if (recoveryFlight.current) return recoveryFlight.current;
    setRecovering(true);
    setRecoveryError(null);
    const request = api.recover(sessionId, {
      answer: label,
      questionId,
      model: effective.provider && effective.modelId
        ? `${effective.provider}/${effective.modelId}` : undefined,
      effort: effective.effortId,
    }).then(res => { onOpenRecovered(res.sessionId); }).finally(() => {
      recoveryFlight.current = null;
      setRecovering(false);
    });
    recoveryFlight.current = request;
    return request;
  };

  /**
   * The composer's own way out.
   *
   * `QuestionCard`'s "Continue in a new session" button only exists when
   * the transcript parsed a proper native-question item. A session can be
   * suspended in the daemon's own status column without one -- the driver
   * gets reaped mid tool-call and the write that would have produced a
   * clean question item never lands -- and that left the blocked banner
   * telling the user to tap a button that was not anywhere on screen. This
   * is that button, always present whenever the composer is blocked.
   */
  const recoverFromComposer = async () => {
    if (recovering) return;
    setRecovering(true);
    setRecoveryError(null);
    try {
      await recover('');
    } catch {
      setRecoveryError("Could not start the continuation. Your original chat is safe. Please try again.");
      thread.refresh();
    } finally {
      setRecovering(false);
    }
  };

  const setPermission = async (patch: {
    mode?: string;
    finalConfirm?: boolean;
  }) => {
    haptic('light');
    // Optimistic, then corrected by what the daemon reports back.
    thread.applyPermission({
      permission: thread.permission,
      permissionMode: patch.mode ?? thread.permissionMode,
      finalConfirm: patch.finalConfirm ?? thread.finalConfirm,
    });
    try {
      const res = await api.permission(sessionId, patch);
      thread.applyPermission({
        permission: res.permission,
        permissionMode: res.permissionMode,
        finalConfirm: res.finalConfirm,
      });
      // Modes announce; the confirm toggle just clicks (see its sound).
      // The label mapping mirrors the header subtitle below exactly.
      if (patch.mode) {
        const label =
          res.permissionMode === 'full-access'
            ? 'Full access'
            : res.permissionMode === 'read-only'
              ? 'Read only'
              : 'Default';
        toast(`Permission: ${label}`);
      }
    } catch {
      // Put the truth back: re-read rather than leaving a claim we cannot
      // stand behind on screen.
      thread.refresh();
    }
  };

  return (
    <div className="app" ref={threadShell}>
      <RelayBanner />
      <header className="thread-header" data-condensed={condensed ? 'true' : 'false'}>
        <div className="thread-header-left">
          <button type="button" className="icon-button" onClick={onBack} aria-label="Back">
            <ChevronLeft size={20} strokeWidth={1.75} />
          </button>
        </div>
        <span className="thread-titles">
          <span className="thread-title">{thread.title || 'Conversation'}</span>
          <span className="thread-subtitle">
            {thread.parentId
              ? (parentTitle ? `Subagent of ${parentTitle}` : 'Subagent')
              : `${effective.modelLabel || 'Aside'} · ${
                  thread.permissionMode === 'full-access'
                    ? 'Full access'
                    : thread.permissionMode === 'read-only'
                      ? 'Read only'
                      : 'Default'
                }`}
          </span>
        </span>
        <div className="thread-header-right">
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              haptic('light');
              setTabDeckOpen(true);
            }}
            aria-label="Browser tabs"
          >
            <Globe size={18} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              haptic('light');
              setPanelOpen(true);
            }}
            aria-label="Session panel"
          >
            <MoreVertical size={19} strokeWidth={1.75} />
          </button>
        </div>
      </header>

      <div
        className="thread-scroll"
        ref={scroller}
        onScroll={onScroll}
        onTouchStart={releaseLanding}
        onWheel={releaseLanding}
      >
        <LiveBrowserCard sessionId={sessionId} busy={activeTurn} />
        {thread.loading && thread.items.length === 0 ? (
          <div className="thread-skeleton" role="status" aria-label="Loading conversation">
            <span className="thread-skeleton-user" aria-hidden="true" />
            <span className="thread-skeleton-line" aria-hidden="true" />
            <span className="thread-skeleton-line short" aria-hidden="true" />
            <span className="thread-skeleton-line" aria-hidden="true" />
          </div>
        ) : null}
        {thread.error && thread.items.length === 0 ? (
          <div className="thread-error" role="alert">
            <span className="thread-error-mark" aria-hidden="true">
              <AsideSymbol size={24} />
            </span>
            <p className="thread-error-title">Couldn&apos;t load this chat</p>
            <p className="thread-error-reason">{thread.error}</p>
            <button
              type="button"
              className="thread-error-retry"
              onClick={() => {
                haptic('light');
                thread.refresh();
              }}
            >
              Try again
            </button>
          </div>
        ) : null}

        <Thread
          items={thread.items}
          sessionId={sessionId}
          sources={thread.sources}
          subagentSteps={thread.subagentSteps}
          onInspectSubagent={(childId) =>
            onInspectSubagent(childId, thread.title)
          }
          onOpenCitation={setCitation}
          onAnswer={answer}
          onRecover={recover}
          busy={sending || activeTurn}
          detachedLiveWorkId={liveWork?.id}
          scrollElementRef={scroller}
        />

        {thread.alerts.map((alert, index) => (
          <ErrorCard key={index} alert={alert} />
        ))}

        {/* The current control is always the last thing in the scrollable
            transcript. Only its active run moves; prior work and prose
            remain in chronological order inside `Thread`. */}
        {activeTurn && liveActivity ? (
          liveWork ? (
            <LiveWorkTail
              block={liveWork}
              activity={liveActivity}
              answering={answering}
              subagentSteps={thread.subagentSteps}
              onInspectSubagent={(childId) =>
                onInspectSubagent(childId, thread.title)
              }
              onLayoutChange={updateLiveTailLayout}
            />
          ) : answering ? null : (
            <StreamFooter phase={activity.phase} {...liveActivity} />
          )
        ) : null}
      </div>

      <footer className="thread-footer" ref={threadDock}>
        {/* Visibility is driven entirely by the `data-at-end` attribute the
            scroll handler already writes on this footer, so returning to
            the end of a long transcript costs no React state and no
            re-render per scroll frame. */}
        <button
          type="button"
          className="jump-latest"
          onClick={jumpToLatest}
          aria-label="Jump to latest"
          tabIndex={-1}
        >
          <ChevronDown size={17} strokeWidth={2.25} />
        </button>
        {activeTurn && liveActivity ? (
          <ActivityIsland
            activity={liveActivity}
            stoppable={thread.stoppable}
            stopping={thread.stopping}
            onStop={() => void thread.stop()}
          />
        ) : null}
        <Composer
          variant="reply"
          value={draft}
          onChange={setDraft}
          onSubmit={send}
          pills={effective}
          onOpenModel={openModel}
          attachments={attachments.items}
          onAddFiles={(files) => attachments.add(files, sessionId)}
          onRemoveAttachment={attachments.remove}
          busy={sending}
          disabled={sending}
          streaming={activeTurn}
          onStop={thread.stoppable ? () => void thread.stop() : undefined}
          stopping={thread.stopping}
          stopBlocked={'This turn is no longer running.'}
          // A suspended session accepts a send and then hangs on it
          // forever, so the composer refuses rather than jamming.
          blockedReason={
            thread.suspended
              ? thread.hasRecoverableQuestion
                ? 'Waiting for your answer. Respond on your computer, or continue in a new session here.'
                : 'This session is paused on your computer. Open it in Aside there to respond; your chat history is still saved.'
              : null
          }
          onRecover={
            thread.suspended
              ? thread.hasRecoverableQuestion
                ? recoverFromComposer
                : onBack
              : undefined
          }
          recoverLabel={
            thread.hasRecoverableQuestion
              ? 'Continue in a new session'
              : 'Back to chats'
          }
          recovering={recovering}
          above={<>
            <TodoSection todos={thread.todos} paused={thread.suspended} />
            {recoveryError ? <p role="alert" className="question-error">{recoveryError}</p> : null}
          </>}
        />
      </footer>

      {panelOpen ? (
        <Suspense fallback={null}>
          <SessionPanel
          sessionId={sessionId}
          subagents={thread.subagents}
          todos={thread.todos}
          muted={thread.muted}
          onToggleMute={(next) => thread.setMuted(next)}
          onInspectSubagent={(childId) => {
            setPanelOpen(false);
            onInspectSubagent(childId, thread.title);
          }}
            onClose={() => setPanelOpen(false)}
          />
        </Suspense>
      ) : null}

      {citation ? (
        <Suspense fallback={null}>
          <CitationSheet
            mark={citation}
            sources={thread.sources}
            onClose={() => setCitation(null)}
          />
        </Suspense>
      ) : null}

      {tabDeckOpen ? (
        <Suspense fallback={null}>
          <TabDeck onClose={() => setTabDeckOpen(false)} />
        </Suspense>
      ) : null}

      {renderPicker({
        ...effective,
        permissionMode: thread.permissionMode,
        finalConfirm: thread.finalConfirm,
        softConfirm: thread.softConfirm,
        onPickMode: (id) => void setPermission({ mode: id }),
        onToggleConfirm: (next) => {
          playSound('toggle');
          void setPermission({ finalConfirm: next });
        },
        onPickModel: (provider, modelId) =>
          void updateSessionModel({
            provider,
            modelId,
            effort: effective.effortId,
          }),
        onPickEffort: (effort) =>
          void updateSessionModel({
            provider: effective.provider,
            modelId: effective.modelId,
            effort,
            label: effective.modelLabel,
          }),
      })}
      <ToastHost />
    </div>
  );
}
