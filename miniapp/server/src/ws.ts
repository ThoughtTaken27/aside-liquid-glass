/**
 * WebSocket transport for a live thread.
 *
 * Client -> server
 *   {type:"auth", token}                  (first frame; cookie also accepted)
 *   {type:"subscribe", sessionId}
 *   {type:"ping"}
 *
 * Server -> client
 *   {type:"ready"}
 *   {type:"subscribed", sessionId, busy, queued}
 *   {type:"thread_delta", sessionId, fromIndex, items, length}
 *   {type:"thread_meta", sessionId, stats, sources, todos}
 *   {type:"subagent_delta", sessionId, childId, steps, total}
 *   {type:"stream_delta", sessionId, text}
 *   {type:"turn_started", ...} / {type:"turn_finished", ...}
 *   {type:"permission_changed", sessionId, permission, ...}
 *   {type:"error", reason}
 *
 * What changed in round 3, and why:
 *
 * Round 2 pushed raw transcript entries and the client answered each one by
 * refetching the whole structured thread through the CLI facade, throttled
 * to 1.2s. That is what made a reply appear in one lump -- nothing could be
 * drawn until a ~139MB binary had been spawned and had returned the entire
 * turn. Here the server builds the thread itself (a file read, no spawn)
 * and sends only the tail that changed, so a tool call shows up as it
 * happens rather than when the turn ends.
 *
 * Two levels of liveness ride on this socket:
 *
 *  - `thread_delta` is authoritative and comes from the transcript. Every
 *    completed part -- a text block, a tool call, a tool result -- lands
 *    within one watcher tick of being written.
 *  - `stream_delta` is provisional and comes from the running child's
 *    stdout, which mirrors the answer token by token well before the
 *    transcript line for that message is written. It is always superseded
 *    by the `thread_delta` that carries the real text.
 *
 * The per-connection baseline is reset on `turn_finished`, which forces one
 * full resync per turn. That closes the only gap in the diff scheme: a line
 * written between the client's REST load and this socket's first build
 * would otherwise never produce a delta, because the server's baseline
 * already contained it.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import type { MiniappConfig } from './config.js';
import { bearerFrom, cookieFrom, verifyToken } from './auth.js';
import { isValidSessionId, sessionMsgFile } from './sessions.js';
import type { LiveActivity } from './activity.js';
import { transcriptIsLive } from './transcript.js';
import type {
  TurnRunner,
  InFlightTurn,
  TurnFinished,
  StreamDelta,
} from './exec.js';
import type { WatcherRegistry } from './watcher.js';
import {
  buildParentView,
  diffThread,
  type ParentView,
  type ThreadStore,
} from './threadstore.js';
import type { ChildSession, ThreadItem } from './thread.js';
import type { SubagentIndex } from './subagents.js';
import type { ActiveViewers } from './viewers.js';

const HEARTBEAT_MS = 30_000;

/**
 * Floor on how often one connection is handed a rebuilt thread.
 *
 * Low enough that a step appears as it happens, high enough that a burst of
 * transcript writes does not turn into a burst of frames over a phone
 * connection.
 */
// 80ms stays inside one perceptual beat while still coalescing the burst of
// call/result writes emitted for a tool transition.
const PUSH_THROTTLE_MS = 80;
// Desktop-started quiet work has no local runner event, so this is the
// cross-device truth source. 300ms cuts its visible lag without becoming a
// hot poll; reads are a tiny local SQLite query and serialized below.
const SESSION_STATE_POLL_MS = 300;

/**
 * How long a subscribe will wait for a brand new session's transcript.
 *
 * `TurnRunner.createSession` allows 60s to spot the new directory, so the
 * file follows well inside this window; past it, the session genuinely is
 * not there.
 */
const NEW_SESSION_WAIT_MS = 30_000;
const NEW_SESSION_POLL_MS = 250;

/**
 * How long a socket may stay connected without proving who it is.
 *
 * The upgrade handler is a raw `server.on('upgrade')` listener, so it sits
 * outside Fastify's routing and outside @fastify/rate-limit entirely.
 * Before this, a client that connected and then simply
 * said nothing was accepted and held open forever -- 200 of them in a
 * second, each registering four listeners on the runner's event emitters.
 * Verified against this server. A socket now proves itself or is dropped.
 */
const AUTH_DEADLINE_MS = 5_000;

/**
 * Ceiling on concurrent sockets.
 *
 * The real client holds exactly one. This is a backstop against a flood
 * from the public tunnel, not a limit anyone should ever meet.
 */
const MAX_CLIENTS = 32;

interface Deps {
  app: FastifyInstance;
  config: MiniappConfig;
  runner: TurnRunner;
  watchers: WatcherRegistry;
  threads: ThreadStore;
  subagents: SubagentIndex;
  jwtSecret: string;
  /**
   * Optional: fed a reference count of who is actively subscribed to each
   * session, so `notify.ts` can suppress a push for a thread that is
   * already open on screen. Absent in tests that don't care.
   */
  viewers?: ActiveViewers;
  /** Fresh daemon-owned metadata for cross-device synchronization. */
  readSessionState?: (sessionId: string) => Promise<Record<string, unknown>>;
}

export function attachWebSocket(deps: Deps): WebSocketServer {
  const { app, config, runner, watchers, threads, subagents, jwtSecret, viewers } = deps;
  const wss = new WebSocketServer({
    noServer: true,
    /**
     * Compress frames over ~1KB.
     *
     * A reconnect now re-sends the whole thread (see the `full` flag on
     * subscribe), and a long thread is tens to hundreds of kilobytes of
     * highly repetitive JSON. Over a phone link that is the difference
     * between a resume that feels instant and one that visibly loads. The
     * memory-level and window settings are deliberately modest: `ws` warns
     * that the default zlib windows are expensive per connection, and this
     * server tops out at MAX_CLIENTS sockets that are almost always one.
     */
    perMessageDeflate: {
      zlibDeflateOptions: { level: 6, memLevel: 7, windowBits: 13 },
      zlibInflateOptions: { windowBits: 13 },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      concurrencyLimit: 4,
      threshold: 1024,
    },
  });

  // Each connection registers four listeners across these two emitters, so
  // the default ceiling of 10 trips a spurious "possible memory leak"
  // warning well before MAX_CLIENTS. The real bound is MAX_CLIENTS itself.
  runner.setMaxListeners(MAX_CLIENTS + 10);
  subagents.setMaxListeners(MAX_CLIENTS + 10);

  app.server.on('upgrade', (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url || '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    // Refuse rather than accept-then-drop: a socket that never completes
    // the handshake costs nothing, and this is the only gate in front of an
    // endpoint the tunnel exposes publicly.
    if (wss.clients.size >= MAX_CLIENTS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    // No credential is read here: auth happens on the first `auth` frame
    // or via the session cookie below, so the token never appears in a URL.
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket, req) => {
    // The browser sends the HttpOnly session cookie on the upgrade
    // automatically; a native client without cookie support sends one
    // `auth` frame instead. Either path calls the same authenticate.
    const cookieToken = cookieFrom(
      (req as unknown as { headers?: { cookie?: string } }).headers?.cookie,
    );
    const headerToken = bearerFrom(
      (req as unknown as { headers?: Record<string, string | string[] | undefined> }).headers?.[
        'sec-websocket-protocol'
      ] as string | undefined,
    );
    let authed = false;
    let sessionId: string | null = null;
    let msgFile: string | null = null;
    /** What this client is believed to have. The diff is against this. */
    let baseline: ThreadItem[] = [];
    /** Last `thread_meta` sent, so unchanged token counts stay off the wire. */
    let metaSent = '';
    let detach: (() => void) | null = null;
    let pushTimer: NodeJS.Timeout | null = null;
    let awaitTimer: NodeJS.Timeout | null = null;
    let stateTimer: NodeJS.Timeout | null = null;
    let stateReading = false;
    let stateSent = '';
    let daemonBusy: boolean | null = null;
    let daemonSuspended = false;
    let lastPush = 0;
    /** Subagents whose timeline needs re-sending on the next push. */
    const dirtyChildren = new Set<string>();
    /** Live watchers on running subagents, keyed by child session id. */
    const childDetach = new Map<string, () => void>();

    const send = (payload: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };

    const pushSessionState = async () => {
      if (!deps.readSessionState || !sessionId || stateReading) return;
      stateReading = true;
      const requestedId = sessionId;
      try {
        const state = await deps.readSessionState(requestedId);
        if (sessionId !== requestedId) return;
        daemonBusy = typeof state.busy === 'boolean' ? state.busy : null;
        daemonSuspended = state.suspended === true;
        // Refresh children even while the parent is silent during thinking.
        subagents.snapshot(requestedId, Boolean(daemonBusy));
        const payload = { type: 'session_state', sessionId: requestedId, ...state };
        const encoded = JSON.stringify(payload);
        if (encoded !== stateSent) {
          stateSent = encoded;
          send(payload);
          schedulePush();
        }
      } catch {
        // A transient SQLite read failure should recover on the next tick.
      } finally {
        stateReading = false;
      }
    };

    const startSessionState = () => {
      if (!deps.readSessionState || stateTimer) return;
      void pushSessionState();
      stateTimer = setInterval(() => void pushSessionState(), SESSION_STATE_POLL_MS);
      stateTimer.unref?.();
    };

    /** Dropped the moment the socket authenticates -- see AUTH_DEADLINE_MS. */
    let authTimer: NodeJS.Timeout | null = setTimeout(() => {
      authTimer = null;
      if (authed) return;
      send({ type: 'error', reason: 'unauthorized' });
      ws.close(4401, 'unauthorized');
      // close() waits for the peer; a silent client must not get to wait.
      setTimeout(() => ws.terminate(), 250).unref?.();
    }, AUTH_DEADLINE_MS);
    authTimer.unref?.();

    const clearAuthTimer = () => {
      if (authTimer) clearTimeout(authTimer);
      authTimer = null;
    };

    const authenticate = (token: string | null | undefined): boolean => {
      try {
        verifyToken(token || undefined, jwtSecret, config.allowedUserId);
        authed = true;
        clearAuthTimer();
        send({ type: 'ready' });
        return true;
      } catch {
        clearAuthTimer();
        send({ type: 'error', reason: 'unauthorized' });
        ws.close(4401, 'unauthorized');
        return false;
      }
    };

    if (cookieToken && authenticate(cookieToken)) {
      // Cookie-authenticated: the auth timer is already cleared.
    } else if (headerToken && !authenticate(headerToken)) {
      return;
    }

    /**
     * Follow the subagents that are still running.
     *
     * A child writes its own messages.jsonl, so its live tool rows come from
     * tailing that file exactly as the parent's do. Watchers are held only
     * while a child runs; a child that has just finished is marked dirty one
     * last time so its card settles on its final state before we let go.
     */
    const followChildren = (children: ChildSession[]) => {
      const running = new Set(children.filter((c) => c.running).map((c) => c.id));
      for (const [childId, release] of childDetach) {
        if (running.has(childId)) continue;
        release();
        childDetach.delete(childId);
        dirtyChildren.add(childId);
      }
      for (const child of children) {
        if (!child.running || childDetach.has(child.id)) continue;
        const file = sessionMsgFile(config.sessionsDir, child.id);
        if (!file || !fs.existsSync(file)) continue;
        const watcher = watchers.acquire(child.id, file);
        const onEntries = () => {
          dirtyChildren.add(child.id);
          schedulePush();
        };
        watcher.on('entries', onEntries);
        childDetach.set(child.id, () => {
          watcher.off('entries', onEntries);
          watchers.release(child.id);
        });
        dirtyChildren.add(child.id);
      }
    };

    /** Rebuild from the transcript and push whatever moved. */
    const pushNow = () => {
      if (!sessionId || !msgFile) return;
      lastPush = Date.now();
      /**
       * Same liveness gap as the REST thread route: `runner.isBusy` only
       * knows this server's own turns, so a Mac-started turn pushed over
       * this socket rendered as finished the instant it opened -- correct
       * items, wrong fold state, and it never flipped back because
       * nothing here ever re-checked. `transcriptIsLive` reads the
       * transcript's own tail instead of trusting either process to say
       * so.
       */
      const busy = daemonSuspended ? false :
        (daemonBusy === true || runner.isBusy(sessionId) || transcriptIsLive(msgFile));
      const children = subagents.snapshot(sessionId, busy);
      let next: ParentView;
      try {
        next = buildParentView(
          threads,
          config.sessionsDir,
          sessionId,
          msgFile,
          busy,
          children,
        );
      } catch {
        return; // transcript vanished mid-read; the next tick recovers
      }

      followChildren(children.children);
      for (const steps of next.children) {
        if (!dirtyChildren.has(steps.childId)) continue;
        send({ type: 'subagent_delta', sessionId, ...steps });
      }
      dirtyChildren.clear();

      // Token counters, the citation catalog and the task list ride their
      // own event: they move independently of the item list, and a fold
      // gaining a step must not force all of that back over the wire.
      const meta = JSON.stringify({
        stats: next.stats,
        sources: next.sources,
        todos: next.todos,
        subagents: next.subagents,
      });
      if (meta !== metaSent) {
        metaSent = meta;
        send({
          type: 'thread_meta',
          sessionId,
          stats: next.stats,
          sources: next.sources,
          todos: next.todos,
          subagents: next.subagents,
        });
      }

      const delta = diffThread(baseline, next.items);
      if (!delta) return;
      baseline = next.items;
      send({ type: 'thread_delta', sessionId, ...delta });
    };

    const schedulePush = () => {
      if (pushTimer) return;
      const wait = Math.max(0, PUSH_THROTTLE_MS - (Date.now() - lastPush));
      pushTimer = setTimeout(() => {
        pushTimer = null;
        pushNow();
      }, wait);
      pushTimer.unref?.();
    };

    const onTurnStarted = (turn: InFlightTurn) => {
      if (turn.sessionId && turn.sessionId === sessionId) {
        send({ type: 'turn_started', ...turn });
        void pushSessionState();
        schedulePush();
      }
    };
    const onTurnFinished = (turn: TurnFinished) => {
      if (turn.sessionId !== sessionId) return;
      send({ type: 'turn_finished', ...turn });
      void pushSessionState();
      // One guaranteed full resync per turn -- see the header note. The
      // child list is re-read rather than waited out, so a subagent that
      // finished with the turn settles immediately.
      baseline = [];
      metaSent = '';
      void subagents.refresh(turn.sessionId).then(schedulePush, () => {});
      schedulePush();
    };
    /** A spawn or a status change is a thread change, with no file write. */
    const onSubagents = (parentId: string) => {
      if (parentId === sessionId) schedulePush();
    };
    const onStreamDelta = (delta: StreamDelta) => {
      if (delta.sessionId !== sessionId) return;
      send({ type: 'stream_delta', sessionId, text: delta.text });
    };

    const onActivity = (event: { sessionId: string; activity: LiveActivity }) => {
      if (event.sessionId === sessionId) send({ type: 'activity', ...event });
    };
    runner.on('activity', onActivity);
    runner.on('turn_started', onTurnStarted);
    runner.on('turn_finished', onTurnFinished);
    runner.on('stream_delta', onStreamDelta);
    subagents.on('updated', onSubagents);

    const unsubscribe = () => {
      detach?.();
      detach = null;
      for (const release of childDetach.values()) release();
      childDetach.clear();
      dirtyChildren.clear();
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = null;
      if (awaitTimer) clearTimeout(awaitTimer);
      awaitTimer = null;
      if (stateTimer) clearInterval(stateTimer);
      stateTimer = null;
      stateSent = '';
      daemonBusy = null;
      daemonSuspended = false;
      if (sessionId && msgFile) watchers.release(sessionId);
      if (sessionId) viewers?.leave(sessionId);
      sessionId = null;
      msgFile = null;
      baseline = [];
      metaSent = '';
    };

    /**
     * Attach the watcher once the transcript exists.
     *
     * A session created from the home composer has an id before it has a
     * file: `aside exec` is handed back as soon as its directory appears,
     * and messages.jsonl lands a moment later. Failing the subscribe
     * outright (which is what the first cut did) left a brand new chat with
     * no live updates at all until the user backed out and reopened it --
     * caught on a live run, where the socket answered `session_not_found`
     * 900ms after the session id was issued.
     *
     * So a missing file is a WAIT, not an error, for as long as the CLI
     * could plausibly still be creating it.
     */
    const attach = (id: string, file: string, full: boolean) => {
      msgFile = file;
      viewers?.enter(id);
      /** Same liveness fill-in as `pushNow` -- see its comment. */
      const live = runner.isBusy(id) || transcriptIsLive(file);
      try {
        /**
         * On a FIRST subscribe the client has just loaded the thread over
         * REST, so the baseline starts at what is on disk now rather than
         * empty -- otherwise every thread open would re-send the history
         * it already has.
         *
         * On a RESUBSCRIBE (`full`) that assumption is exactly wrong and
         * was the bug behind "I have to close the app and reopen the chat":
         * a client whose socket dropped mid-turn came back, the server took
         * the now-newer file as the baseline of what that client already
         * had, and every line written during the gap sat on both sides of a
         * diff that could never report it. An empty baseline makes the
         * first push after a reconnect carry the whole thread, which is the
         * only thing that is true when the gap length is unknown.
         */
        baseline = full
          ? []
          : threads.build(id, file, live, subagents.snapshot(id)).items;
      } catch {
        baseline = [];
      }

      const watcher = watchers.acquire(id, file);
      const onEntries = () => schedulePush();
      watcher.on('entries', onEntries);
      // 'activity' fires on every mtime change even with no complete line
      // yet -- see watcher.ts. Without this a long single tool call (no
      // new JSONL line landing for its whole duration) never re-pushed,
      // so `transcriptIsLive`'s freshly bumped mtime never reached the
      // client and the spinner could still time out mid-turn.
      const onActivity = () => schedulePush();
      watcher.on('activity', onActivity);
      detach = () => {
        watcher.off('entries', onEntries);
        watcher.off('activity', onActivity);
      };

      send({
        type: 'subscribed',
        sessionId: id,
        busy: live,
        queued: runner.queuedCount(id),
        length: baseline.length,
      });
      const activity = runner.status().inFlight.find(turn => turn.sessionId === id)?.activity;
      if (activity) send({ type: 'activity', sessionId: id, activity });
      startSessionState();
      // A resubscribe must not wait for the next transcript write to hand
      // the client the thread it just declared itself ignorant of.
      if (full) schedulePush();
    };

    const subscribe = (nextId: string, full: boolean) => {
      if (!isValidSessionId(nextId)) {
        send({ type: 'error', reason: 'bad_session_id' });
        return;
      }
      unsubscribe();
      sessionId = nextId;

      const file = sessionMsgFile(config.sessionsDir, nextId);
      if (file && fs.existsSync(file)) {
        attach(nextId, file, full);
        return;
      }

      // Nothing on disk. Waiting is only justified when this server is
      // itself mid-turn on that id -- which is exactly the just-created
      // case, since `createSession` marks the queue running before it hands
      // the id back. For any other unknown id the answer is immediate, so a
      // typo or a stale link does not hang the client for half a minute.
      if (!runner.isBusy(nextId)) {
        send({ type: 'error', reason: 'session_not_found' });
        sessionId = null;
        return;
      }

      const deadline = Date.now() + NEW_SESSION_WAIT_MS;
      const poll = () => {
        if (sessionId !== nextId || ws.readyState !== ws.OPEN) return;
        const found = sessionMsgFile(config.sessionsDir, nextId);
        if (found && fs.existsSync(found)) {
          attach(nextId, found, full);
          return;
        }
        // The turn ending without a transcript means it failed outright.
        if (Date.now() > deadline || !runner.isBusy(nextId)) {
          send({ type: 'error', reason: 'session_not_found' });
          sessionId = null;
          return;
        }
        awaitTimer = setTimeout(poll, NEW_SESSION_POLL_MS);
        awaitTimer.unref?.();
      };
      poll();
    };

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        send({ type: 'error', reason: 'bad_json' });
        return;
      }
      if (msg?.type === 'auth') {
        if (!authed) authenticate(msg.token);
        return;
      }
      if (!authed) {
        send({ type: 'error', reason: 'unauthorized' });
        ws.close(4401, 'unauthorized');
        return;
      }
      if (msg?.type === 'ping') {
        send({ type: 'pong' });
        return;
      }
      if (msg?.type === 'subscribe') {
        // `full` is how a reconnecting client says "assume I have nothing".
        // Absent (an older client, or a first subscribe) keeps the cheap
        // disk-baseline behavior.
        subscribe(String(msg.sessionId || ''), msg.full === true);
        return;
      }
      if (msg?.type === 'unsubscribe') {
        unsubscribe();
        return;
      }
      // A client that has fallen behind (a tab restored from the
      // background, typically) can ask for the whole thread again.
      if (msg?.type === 'resync') {
        baseline = [];
        schedulePush();
        return;
      }
      send({ type: 'error', reason: 'unknown_message' });
    });

    ws.on('close', () => {
      clearAuthTimer();
      unsubscribe();
      runner.off('activity', onActivity);
      runner.off('turn_started', onTurnStarted);
      runner.off('turn_finished', onTurnFinished);
      runner.off('stream_delta', onStreamDelta);
      subagents.off('updated', onSubagents);
    });

    ws.on('error', () => ws.terminate());
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if ((client as any).__alive === false) {
        client.terminate();
        continue;
      }
      (client as any).__alive = false;
      client.ping();
      client.once('pong', () => {
        (client as any).__alive = true;
      });
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    for (const client of wss.clients) client.terminate();
    wss.close();
  });

  return wss;
}
