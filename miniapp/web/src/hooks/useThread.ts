/**
 * A live thread.
 *
 * Round 2 treated the socket as a doorbell: "something changed" arrived,
 * and the client answered by refetching the entire structured thread
 * through the CLI facade, throttled to 1.2s. That is why a reply appeared
 * all at once -- nothing could be drawn until a process spawn had returned
 * the whole turn.
 *
 * Now the server sends the thread itself, as tail deltas, and this hook
 * only applies them. Three layers stack, from most to least authoritative:
 *
 *  1. `thread_delta` -- built from the transcript. Truth.
 *  2. `stream_delta` -- the answer as the CLI writes it to stdout, shown as
 *     a live paragraph. Dropped the instant a delta covers it, because the
 *     transcript's version is the real one.
 *  3. the optimistic echo -- the message the user just sent, appended
 *     locally so the bubble appears on tap instead of when the first reply
 *     lands. Retired as soon as the same text shows up in the thread.
 */
import { hasPendingNativeQuestion } from '../utils/sessionState';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TranscriptSocket, api } from '../api';
import { threadErrorText } from '../utils/format';
import { haptic } from '../telegram';
import {
  applySessionState,
  type SessionStateEvent,
} from '../utils/sessionState';
import type {
  Attachment,
  ChildSession,
  ChildSteps,
  CitationSource,
  ErrorAlert,
  ThreadItem,
  ThreadModel,
  ThreadResponse,
  ThreadStats,
  Todo,
  UserItem,
} from '../types';

/** Give up on an un-echoed optimistic bubble after this long. */
const PENDING_TTL_MS = 120_000;

export interface PendingMessage {
  text: string;
  attachments: Attachment[];
  at: number;
}

export interface ThreadState {
  items: ThreadItem[];
  title: string;
  busy: boolean;
  stoppable: boolean;
  queued: number;
  /** Null means "not known" -- the caller must hide, not guess. */
  permission: string | null;
  permissionMode: string | null;
  finalConfirm: boolean | null;
  /** True when the confirm toggle means the soft protocol, not the daemon's. */
  softConfirm: boolean;
  model: ThreadModel | null;
  /** Token counters for the context ring and the streaming footer. */
  stats: ThreadStats;
  /** Ring denominator, in tokens. */
  contextWindow: number;
  /** Web sources any citation in this thread can resolve against. */
  sources: Record<string, CitationSource>;
  /** Every subagent of this session, for the panel. */
  subagents: ChildSession[];
  /** Each subagent's own timeline, keyed by child session id. */
  subagentSteps: Record<string, ChildSteps>;
  /** Set when this session is itself a subagent. */
  parentId: string | null;
  /** The agent's task list, replayed from its `write_todos` calls. */
  todos: Todo[];
  /**
   * Blocked on a native question tool only the desktop app can answer.
   *
   * The composer disables itself on this: sending would queue an `aside
   * exec` that hangs forever against a suspended session.
   */
  suspended: boolean;
  /**
   * Whether `suspended` has an actual question behind it "Continue in a
   * new session" can seed from. See `ThreadResponse.hasRecoverableQuestion`.
   */
  hasRecoverableQuestion: boolean;
  /** Characters streamed so far this turn, for the footer's estimate. */
  streamingChars: number;
  activity: {
    phase: 'thinking' | 'writing' | null;
    tools: string[];
    summary?: string | null;
  } | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  /**
   * Turn-level failures, as cards.
   *
   * These come off `turn_finished` rather than the transcript -- a CLI that
   * exits non-zero without ever writing an assistant record has nothing in
   * the transcript to render, and this is the only place that failure
   * exists.
   */
  alerts: ErrorAlert[];
  /** Stop the running turn. Safe to call when nothing is running. */
  stop: () => Promise<void>;
  /** True between tapping Stop and the turn actually ending. */
  stopping: boolean;
  refresh: () => void;
  /** Clear any error cards raised by `turn_finished`. */
  dismissAlerts: () => void;
  /** Show a just-sent message immediately, before the transcript has it. */
  addPending: (message: PendingMessage) => void;
  clearPending: () => void;
  /** Reflect a permission change without waiting for a refetch. */
  applyPermission: (next: {
    permission: string | null;
    permissionMode: string | null;
    finalConfirm: boolean | null;
  }) => void;
  /** Current mute state for push notifications. */
  muted: boolean;
  /** Reflect a mute/unmute without waiting for a refetch. */
  setMuted: (next: boolean) => void;
}

/** Apply a tail delta: keep the prefix, replace everything from `fromIndex`. */
export function applyDelta(
  prev: ThreadItem[],
  delta: { fromIndex: number; items: ThreadItem[]; length: number },
): ThreadItem[] {
  const head = prev.slice(0, Math.max(0, delta.fromIndex));
  const next = [...head, ...delta.items];
  // `length` is authoritative, so a thread that shrank truncates rather
  // than keeping orphaned items from the previous build.
  return next.length > delta.length ? next.slice(0, delta.length) : next;
}

/**
 * True when a delta cannot be applied to what the client actually holds.
 *
 * `applyDelta` splices at `fromIndex`, which is only meaningful if the
 * client's list is at least that long. When it is shorter there is a hole
 * between the end of what is on screen and the start of what arrived, and
 * splicing anyway silently welds the two together -- the visible result is
 * a step appearing twice, or in the wrong place, or a card from the middle
 * of the turn stacked on top of the newest one. That is the class of UI
 * glitch that showed up after a dropped connection, and it is unfixable
 * from the delta alone: the missing items simply are not in it. The only
 * correct response is to ask for the thread again.
 */
export function deltaHasGap(
  prev: ThreadItem[],
  delta: { fromIndex: number },
): boolean {
  return delta.fromIndex > prev.length;
}

/** True once the transcript carries the message the echo was standing in for. */
export function pendingIsEchoed(
  items: ThreadItem[],
  pending: PendingMessage,
): boolean {
  const needle = pending.text.trim();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== 'user') continue;
    const text = item.text.trim();
    // The server prepends an attachment header to the prompt, so the
    // transcript's copy CONTAINS the typed text rather than equalling it.
    if (text === needle || (needle && text.endsWith(needle))) return true;
    // Only the newest user bubble can be the echo; anything older is a
    // previous turn, and scanning past it would match a repeated message.
    return false;
  }
  return false;
}

const NO_STATS: ThreadStats = {
  totalTokens: 0,
  turnTokens: 0,
  turnStartedAt: null,
};

/** Index a subagent-steps list by child id, for O(1) lookup while rendering. */
function byChildId(list: ChildSteps[]): Record<string, ChildSteps> {
  return Object.fromEntries(list.map((entry) => [entry.childId, entry]));
}

export function useThread(sessionId: string): ThreadState {
  const [meta, setMeta] = useState<ThreadResponse | null>(null);
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [stats, setStats] = useState<ThreadStats>(NO_STATS);
  const [sources, setSources] = useState<Record<string, CitationSource>>({});
  const [subagentSteps, setSubagentSteps] = useState<Record<string, ChildSteps>>(
    {},
  );
  const [streamText, setStreamText] = useState('');
  const [activity, setActivity] = useState<ThreadState['activity']>(null);
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [alerts, setAlerts] = useState<ErrorAlert[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [stopping, setStopping] = useState(false);
  /**
   * Busy, as the socket reports it.
   *
   * The REST payload's `busy` is a snapshot from load time, so relying on
   * it alone leaves the bottom bar's spinner stuck on whatever the state
   * was when the thread opened. `null` means "the socket has not said",
   * and the REST value stands.
   */
  const [liveBusy, setLiveBusy] = useState<boolean | null>(null);
  const [liveStoppable, setLiveStoppable] = useState<boolean | null>(null);

  const alive = useRef(true);
  const socket = useRef<TranscriptSocket | null>(null);
  const latestSessionState = useRef<SessionStateEvent | null>(null);
  /**
   * A mirror of `items` that is readable synchronously.
   *
   * Needed because deciding whether a delta is applicable is a side effect
   * (it may ask for a resync), and side effects do not belong inside a
   * state updater.
   */
  const itemsRef = useRef<ThreadItem[]>([]);
  const transcriptRevision = useRef(0);
  const loadSequence = useRef(0);
  /** Rate limit on gap-triggered resyncs, so a bad delta cannot loop. */
  const lastResync = useRef(0);
  /**
   * False until the socket has been open once for this session.
   *
   * Distinguishes the opening connection (whose REST load has just run)
   * from a reconnect (which must refetch the metadata it may have missed).
   */
  const connectedOnce = useRef(false);

  const putItems = useCallback((next: ThreadItem[]) => {
    transcriptRevision.current += 1;
    itemsRef.current = next;
    setItems(next);
  }, []);

  const load = useCallback(async () => {
    const revision = transcriptRevision.current;
    const sequence = ++loadSequence.current;
    try {
      const next = await api.thread(sessionId);
      if (!alive.current || sequence !== loadSequence.current) return;
      setMeta(
        latestSessionState.current
          ? applySessionState(next, latestSessionState.current)
          : next,
      );
      if (revision === transcriptRevision.current) {
        itemsRef.current = next.items;
        setItems(next.items);
      }
      setStats(next.stats);
      setSources(next.sources);
      setSubagentSteps(byChildId(next.subagentSteps));
      setTodos(next.todos ?? []);
      setError(null);
    } catch (err) {
      if (!alive.current) return;
      setError(threadErrorText(err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    setAlerts([]);
    itemsRef.current = [];
    lastResync.current = 0;
    connectedOnce.current = false;
    setItems([]);
    setStats(NO_STATS);
    setSources({});
    setSubagentSteps({});
    setTodos([]);
    setStreamText('');
    setActivity(null);
    setPending(null);
    setLiveBusy(null);
    setLiveStoppable(null);
    latestSessionState.current = null;
    setStopping(false);
    void load();

    const ws = new TranscriptSocket(
      sessionId,
      (event) => {
        if (event.type === 'thread_delta') {
          if (deltaHasGap(itemsRef.current, event)) {
            // Do not paint a thread that is known to be wrong. Ask for the
            // whole thing instead; at worst this costs one extra frame.
            const now = Date.now();
            if (now - lastResync.current > 2_000) {
              lastResync.current = now;
              socket.current?.resync();
            }
            return;
          }
          putItems(applyDelta(itemsRef.current, event));
          // The transcript now carries whatever was being streamed, so the
          // provisional buffer has served its purpose.
          setStreamText('');
          return;
        }
        if (event.type === 'thread_meta') {
          setStats(event.stats);
          setSources(event.sources);
          if (event.todos) setTodos(event.todos);
          if (event.subagents) setMeta(prev => prev ? { ...prev, subagents: event.subagents! } : prev);
          return;
        }
        if (event.type === 'subagent_delta') {
          const { childId, steps, total } = event;
          setSubagentSteps((prev) => ({
            ...prev,
            [childId]: { childId, steps, total },
          }));
          return;
        }
        if (event.type === 'activity') {
          setActivity(event.activity);
          return;
        }
        if (event.type === 'stream_delta') {
          setStreamText((prev) => prev + event.text);
          return;
        }
        if (event.type === 'subscribed') {
          setLiveBusy(event.busy);
          return;
        }
        if (event.type === 'session_state') {
          latestSessionState.current = event;
          setLiveBusy(event.busy);
          if (!event.busy || event.suspended) setActivity(null);
          setLiveStoppable(event.stoppable);
          setMeta((prev) => (prev ? applySessionState(prev, event) : prev));
          return;
        }
        if (event.type === 'turn_started') {
          setActivity(null);
          setLiveBusy(true);
          setStreamText('');
          setStopping(false);
          // A new turn's failures are its own; last turn's card would
          // otherwise sit above a run that is going fine.
          setAlerts([]);
          return;
        }
        if (event.type === 'turn_finished') {
          setActivity(null);
          // A stopped or suspended turn is not a failure. Reporting a
          // SIGTERM exit as an error would put a red card on the user's own
          // deliberate tap, and a suspended session already has its
          // question card.
          if (event.alert && !event.stopped && !event.suspended) {
            setAlerts((prev) => [...prev, event.alert!]);
            haptic('error');
          } else if (!event.stopped) {
            haptic('success');
          }
          setLiveBusy(false);
          setStreamText('');
          setStopping(false);
          // Metadata the socket does not carry (title, permission, model,
          // and the suspended flag the composer keys off).
          void load();
        }
      },
      (isConnected) => {
        setConnected(isConnected);
        if (!isConnected) setActivity(null);
        // The socket's own `subscribe` now carries `full` on every
        // reconnect, so the thread itself resyncs without being asked.
        // What it does NOT carry is the metadata that only the REST payload
        // has -- title, permission, model, the suspended flag the composer
        // keys off -- so that is refetched here instead. Skipped on the
        // first connect, where the REST load has just run anyway.
        if (isConnected && connectedOnce.current) void load();
        if (isConnected) connectedOnce.current = true;
      },
    );
    socket.current = ws;
    ws.connect();

    return () => {
      alive.current = false;
      ws.close();
      socket.current = null;
    };
  }, [sessionId, load]);

  // Retire the optimistic bubble once the real one arrives -- or after a
  // couple of minutes, so a failed send does not leave a ghost forever.
  useEffect(() => {
    if (!pending) return undefined;
    if (pendingIsEchoed(items, pending)) {
      setPending(null);
      return undefined;
    }
    const timer = window.setTimeout(
      () => setPending(null),
      Math.max(0, pending.at + PENDING_TTL_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [items, pending]);

  const visible = useMemo(() => {
    const out = [...items];
    if (pending) {
      const echo: UserItem = {
        kind: 'user',
        id: `pending-${pending.at}`,
        text: pending.text,
        ts: pending.at,
        pending: true,
      };
      if (pending.attachments.length) echo.attachments = pending.attachments;
      out.push(echo);
    }
    const streaming = streamText.trim();
    if (streaming) {
      out.push({ kind: 'streaming', id: 'streaming', text: streaming });
    }
    return out;
  }, [items, pending, streamText]);

  return {
    items: visible,
    title: meta?.title ?? '',
    busy: liveBusy ?? meta?.busy ?? false,
    stoppable: liveStoppable ?? meta?.stoppable ?? false,
    queued: meta?.queued ?? 0,
    permission: meta?.permission ?? null,
    permissionMode: meta?.permissionMode ?? null,
    finalConfirm: meta?.finalConfirm ?? null,
    softConfirm: meta?.softConfirm ?? false,
    model: meta?.model ?? null,
    stats,
    contextWindow: meta?.contextWindow ?? 0,
    sources,
    subagents: meta?.subagents ?? [],
    subagentSteps,
    parentId: meta?.parentId ?? null,
    todos,
    suspended: meta?.suspended ?? false,
    hasRecoverableQuestion: hasPendingNativeQuestion(items),
    streamingChars: streamText.length,
    activity,
    loading,
    error,
    connected,
    alerts,
    stopping,
    stop: async () => {
      setStopping(true);
      try {
        await api.stop(sessionId);
        // Desktop-owned turns do not emit this server's `turn_finished`, so
        // clear the control immediately after the CLI acknowledges abort.
        setLiveBusy(false);
        setLiveStoppable(false);
      } catch {
        // A 409 means the turn had already ended, which is still the state
        // the tap requested. A later socket state can re-enable it if work
        // genuinely continues.
      } finally {
        setStopping(false);
      }
    },
    refresh: load,
    dismissAlerts: () => setAlerts([]),
    addPending: (message) => setPending(message),
    clearPending: () => setPending(null),
    applyPermission: (next) =>
      setMeta((prev) => (prev ? { ...prev, ...next } : prev)),
    muted: meta?.muted ?? false,
    setMuted: (next) =>
      setMeta((prev) => (prev ? { ...prev, muted: next } : prev)),
  };
}
