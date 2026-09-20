/** REST + WebSocket client. Same origin as the SPA. */
import type {
  ArtifactGroup,
  ArtifactsResponse,
  AuthResponse,
  BrowserTab,
  ChildSteps,
  CitationSource,
  Entry,
  ErrorAlert,
  MessagesResponse,
  MemoryNode,
  MiniappSettings,
  RoutineRow,
  SearchHit,
  SessionRow,
  StatusResponse,
  TabCapture,
  ThreadItem,
  ThreadResponse,
  ThreadStats,
  ThreadModel,
  Todo,
  UploadedFile,
  BrowserHistoryResponse,
  OmniboxResponse,
  BrowseRecentResponse,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`${status}: ${reason}`);
    this.name = 'ApiError';
  }
}

let authToken = '';

export function setAuthToken(token: string): void {
  authToken = token;
}

/*
 * What to do when the server says our credential is no good.
 *
 * The boot path trusts a stored token on the strength of its own `exp`
 * claim, which is decoded locally and never checked against a signature.
 * That is fine for the case it was written for -- avoiding a spinner on
 * every launch -- and wrong for a token the server has stopped accepting.
 * Deleting the signing secret is the documented way to revoke a device, and
 * it leaves every issued token unexpired and unverifiable at the same time.
 * The phone would boot the full UI, get 401 on everything, swallow it, and
 * show a working-looking app where the send button silently did nothing.
 *
 * A 401 is the only authority on whether a credential is alive, so handle it
 * centrally and at any point in the session rather than only at boot.
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

function handleUnauthorized(): void {
  authToken = '';
  onUnauthorized?.();
}

/*
 * The two routes that mint a credential rather than spend one. A 401 from
 * these means "wrong key", which the caller already reports; treating it as
 * a dead session would wipe a good token when someone fat-fingers a paste.
 */
const CREDENTIAL_ROUTES = ['/api/pair', '/api/auth'];

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (authToken) headers.set('authorization', `Bearer ${authToken}`);

  // `same-origin` rather than the default: the server keeps a long-lived
  // HttpOnly session cookie that lets the installed app recover its token
  // after localStorage has been cleared, and the cookie only rides along if
  // credentials are asked for explicitly.
  const res = await fetch(path, { ...init, credentials: 'same-origin', headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    if (res.status === 401 && !CREDENTIAL_ROUTES.includes(path)) {
      handleUnauthorized();
    }
    throw new ApiError(res.status, body.reason || body.error || res.statusText);
  }
  return body as T;
}

export const api = {
  auth: (initDataRaw: string) =>
    request<AuthResponse>('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ initDataRaw }),
    }),

  /**
   * Standalone bootstrap for the installed app.
   *
   * Same JWT spine as `auth`, different front door: there is no Telegram to
   * hand us an initData blob when the app was opened from the home screen.
   */
  pair: (key: string) =>
    request<{ token: string; name?: string; expiresIn: number }>('/api/pair', {
      method: 'POST',
      body: JSON.stringify({ key }),
    }),

  /**
   * Trade the session cookie for a fresh token.
   *
   * Called at boot when the app has nothing usable in storage. A 401 here
   * is the genuine "never paired, or paired too long ago" case; anything
   * else means the token survived and the owner is not asked to re-pair.
   */
  session: () =>
    request<{ token: string; name?: string; expiresIn: number }>(
      '/api/session',
    ),

  /**
   * The Aside browser's own visit history, straight from the desktop
   * profile. Cheap enough (an indexed read of a local SQLite file) to call
   * whenever the panel opens.
   */
  browserHistory: (query = '', limit = 40, signal?: AbortSignal) =>
    request<BrowserHistoryResponse>(
      `/api/history/browser?q=${encodeURIComponent(query)}&limit=${limit}`,
      { signal },
    ),

  /**
   * Address-bar suggestions: Google's live suggestions blended with what
   * has been visited on either device.
   *
   * Called per keystroke, so the caller is expected to debounce and to
   * pass a signal. The server never fails this call for a slow upstream:
   * a suggest timeout degrades to a history-only list rather than an
   * error, because there is nothing useful a typeahead can say about a
   * network problem.
   */
  omnibox: (query: string, signal?: AbortSignal) =>
    request<OmniboxResponse>(`/api/omnibox?q=${encodeURIComponent(query)}`, {
      signal,
    }),

  /** Unified recent history across both devices. */
  browseRecent: (limit = 60, signal?: AbortSignal) =>
    request<BrowseRecentResponse>(`/api/browse/recent?limit=${limit}`, {
      signal,
    }),

  /**
   * Record a search or page open made on the phone.
   *
   * Fire-and-forget by design: this feeds the address bar's ranking, and
   * a failed write is not worth interrupting a navigation the owner has
   * already committed to.
   */
  recordVisit: (input: { kind: 'search' | 'page'; title: string; url: string }) =>
    request<{ visit: unknown }>('/api/browse/visit', {
      method: 'POST',
      body: JSON.stringify(input),
    }).catch(() => undefined),

  /**
   * Speech to text, decoded on the Mac.
   *
   * Deliberately not routed through `request`: this is multipart, not JSON,
   * and setting a content-type by hand would strip the boundary the server
   * needs to parse the body.
   */
  /**
   * Ask the Mac to load the speech model now, while the user is still
   * talking.
   *
   * Cold start is dominated by reading a 488MB model into memory; a
   * dictation takes seconds. Overlapping the two is what stops the first
   * take after a restart from being the slow one. Fire and forget by
   * design -- a failure here only means the decode is as fast as it used
   * to be.
   */
  warmTranscriber: (): void => {
    void request('/api/transcribe/warm', { method: 'POST' }).catch(() => {});
  },

  transcribe: async (audio: Blob, signal?: AbortSignal): Promise<string> => {
    const form = new FormData();
    // The extension is a hint for ffmpeg's sniffer, nothing more -- it probes
    // the real container regardless of what we claim here.
    form.append('audio', audio, 'recording.webm');
    const headers = new Headers();
    if (authToken) headers.set('authorization', `Bearer ${authToken}`);
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      body: form,
      headers,
      signal,
      credentials: 'same-origin',
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) {
      if (res.status === 401) handleUnauthorized();
      throw new ApiError(res.status, body.reason || body.error || res.statusText);
    }
    return String(body.text || '');
  },

  sessions: (limit = 100) =>
    request<{ sessions: SessionRow[]; source: string }>(
      `/api/sessions?limit=${limit}`,
    ),

  /** Primary thread read: structured, from the daemon's own transcript. */
  thread: (sessionId: string) =>
    request<ThreadResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/thread`,
    ),

  /**
   * Raw transcript entries.
   *
   * Kept because `/api/sessions/:id/messages` is still served, but note that
   * nothing in this app calls it: rounds 1-2 polled it, and round 3 replaced
   * that with server-built thread deltas over the socket. It is a debugging
   * affordance now, not a code path.
   */
  messages: (sessionId: string, afterLine = -1) =>
    request<MessagesResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?afterLine=${afterLine}`,
    ),

  send: (
    sessionId: string,
    payload: {
      text: string;
      model?: string;
      effort?: string;
      attachments?: string[];
    },
  ) =>
    request<{ accepted: boolean; queued: number; busy: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/send`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  newSession: (payload: {
    text: string;
    model?: string;
    effort?: string;
    attachments?: string[];
    permissionMode?: string;
    finalConfirm?: boolean;
  }) =>
    request<{ sessionId: string; accepted: boolean }>('/api/sessions/new', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /**
   * Change a session's permission mode / confirm-before-acting toggle.
   *
   * The response echoes what the server now has, read back from its own
   * state, so the UI checkmarks reality rather than the request.
   * `softConfirm` says which meaning the toggle took: on a session driven
   * from a phone it is the soft protocol, never the daemon's native flag.
   */
  permission: (
    sessionId: string,
    payload: { mode?: string; finalConfirm?: boolean },
  ) =>
    request<{
      ok: boolean;
      permission: string | null;
      permissionMode: string | null;
      finalConfirm: boolean | null;
      softConfirm?: boolean;
      appliesFrom: string;
    }>(`/api/sessions/${encodeURIComponent(sessionId)}/permission`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  sessionModel: (
    sessionId: string,
    payload: { provider: string; modelId: string; effort: string },
  ) =>
    request<{ ok: boolean; model: ThreadModel | null; appliesFrom: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/model`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  /**
   * Start a new session that carries on from one stuck on a native
   * question.
   *
   * Nothing can answer the stuck session's prompt from here -- the daemon
   * holds it for the desktop sidepanel. So the way forward is a fresh
   * session seeded with what was asked and what the user chose. The server
   * reads the question from the transcript itself; `answer` is the only
   * part the client supplies.
   */
  recover: (
    sessionId: string,
    payload: { answer: string; questionId?: string; model?: string; effort?: string },
  ) =>
    request<{ sessionId: string; accepted: boolean; from: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/recover`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  /**
   * Delete a chat.
   *
   * Server-side this archives rather than destroys -- the daemon has no
   * destructive session verb, and archived sessions are already excluded
   * from every list this app reads, so the phone-visible effect is total.
   * Named `deleteSession` because that is what the button says and what
   * the user means; the server comment carries the nuance.
   */
  deleteSession: (sessionId: string) =>
    request<{ ok: boolean; id: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    ),

  /**
   * Mute push notifications for a session. `hours` defaults to 24,
   * clamped server-side to 1..720.
   */
  mute: (sessionId: string, hours?: number) =>
    request<{ ok: boolean; mutedForHours: number }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/mute`,
      { method: 'POST', body: JSON.stringify(hours ? { hours } : {}) },
    ),

  /** Unmute push notifications for a session. */
  unmute: (sessionId: string) =>
    request<{ ok: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/unmute`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  /**
   * Upload files. `sessionId` is optional -- the home composer has no
   * session yet, and the paths are handed back either way.
   */
  upload: async (files: File[], sessionId?: string) => {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    const headers = new Headers();
    // NB: content-type is deliberately NOT set. The browser has to add the
    // multipart boundary itself, and setting it by hand breaks the parse.
    if (authToken) headers.set('authorization', `Bearer ${authToken}`);

    const path = sessionId
      ? `/api/sessions/${encodeURIComponent(sessionId)}/attachments`
      : '/api/attachments';
    const res = await fetch(path, {
      method: 'POST',
      body: form,
      headers,
      credentials: 'same-origin',
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) {
      if (res.status === 401) handleUnauthorized();
      throw new ApiError(res.status, body.reason || body.error || res.statusText);
    }
    return body as { files: UploadedFile[] };
  },

  /**
   * Stop the running turn.
   *
   * The server kills the driver child it owns, by PID. A 409 means there
   * was nothing running -- which is not an error worth surfacing, the
   * composer re-enables either way.
   */
  stop: (sessionId: string) =>
    request<{ ok: boolean; stopping: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/stop`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  /**
   * Answer a soft-protocol question by sending the choice as a message.
   *
   * Only ever used for `source: 'marker'` questions; a native pending tool
   * is answered from the desktop app and the card says so.
   */
  answer: (
    sessionId: string,
    payload: { header: string; label: string; model?: string; effort?: string },
  ) =>
    request<{ accepted: boolean; queued: number; busy: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/answer`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  /**
   * Full-text search across transcript bodies on disk. The session list
   * already has a client-side filter over titles and previews; this finds
   * matches inside sessions nobody has open, which is the incremental
   * value. Requires a non-empty query (the server ignores short ones).
   */
  search: (query: string) =>
    request<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(query)}`),

  status: () => request<StatusResponse>('/api/status'),

  settings: () => request<{ settings: MiniappSettings }>('/api/settings'),

  saveSettings: (patch: Partial<MiniappSettings>) =>
    request<{ settings: MiniappSettings }>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),

  /**
   * Extracted text of a PDF artifact (section 8.3).
   *
   * Same auth and same path containment as `artifactBlob`, but asks the
   * server to run `aside.pdf.read` and return plain text -- the phone
   * cannot render the binary, and a wall of raw bytes helps nobody.
   */
  pdfText: (sessionId: string, group: ArtifactGroup, path: string) =>
    request<{ text: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/pdf?group=${group}&path=${encodeURIComponent(path)}`,
    ),

  /** The session's own files, grouped into artifacts and attachments. */
  artifacts: (sessionId: string) =>
    request<ArtifactsResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/artifacts`,
    ),

  /**
   * One artifact's bytes.
   *
   * Fetched rather than linked so the bearer token stays in a header and
   * out of the DOM; downloads fetch these bytes and save via blob URL.
   */
  artifactBlob: async (
    sessionId: string,
    group: ArtifactGroup,
    path: string,
  ): Promise<Blob> => {
    const headers = new Headers();
    if (authToken) headers.set('authorization', `Bearer ${authToken}`);
    const res = await fetch(artifactPath(sessionId, group, path), {
      headers,
      credentials: 'same-origin',
    });
    if (!res.ok) {
      if (res.status === 401) handleUnauthorized();
      throw new ApiError(res.status, res.statusText);
    }
    return res.blob();
  },

  /**
   * A local image an answer points at, by absolute path.
   *
   * Fetched with credentials and exposed as a blob: URL for the same
   * reason: an `<img src>` cannot carry a header, so the bytes are fetched
   * first and the tag only ever sees an unguessable object URL.
   */
  localFileObjectUrl: async (
    sessionId: string,
    absPath: string,
  ): Promise<string> => {
    const headers = new Headers();
    if (authToken) headers.set('authorization', `Bearer ${authToken}`);
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(absPath)}`,
      { headers, credentials: 'same-origin' },
    );
    if (!res.ok) {
      if (res.status === 401) handleUnauthorized();
      throw new ApiError(res.status, res.statusText);
    }
    return URL.createObjectURL(await res.blob());
  },

  /**
   * This account's memory tree (plan 8.1). Read-only: the server has no
   * write route, by construction. Directories first, then files, both
   * alphabetical; only `.md`/`.markdown`/`.txt` appear.
   */
  memoryTree: () => request<{ tree: MemoryNode[] }>('/api/memory'),

  /** Raw markdown/text content of one memory page. */
  memoryFile: (relPath: string) =>
    request<{ content: string }>(
      `/api/memory/file?path=${encodeURIComponent(relPath)}`,
    ),

  /**
   * Scheduled routines (plan 8.2). Read-only at the daemon level:
   * `aside.routines` exposes `list`/`get` only, verified in the plan's
   * own section 1.4. The shape of each row is whatever the facade hands
   * back, so the caller must inspect at runtime.
   */
  routines: () => request<{ routines: RoutineRow[] }>('/api/routines'),

  // --- browser surfaces (Day 3) ---------------------------------------

  tabs: () => request<{ tabs: BrowserTab[] }>('/api/tabs'),

  openTab: (url: string) =>
    request<{ targetId: string | null; url: string }>('/api/tabs', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  closeTab: (targetId: string) =>
    request<{ closed: boolean }>(`/api/tabs/${encodeURIComponent(targetId)}`, {
      method: 'DELETE',
    }),

  /**
   * The server enforces a 2s-per-tab / 1-global-concurrent capture limit
   * and answers a violation with 429/409 (see `browser.ts`'s `CaptureGate`)
   * -- callers polling this (Watch Mode) must treat those as "skip this
   * tick", not as an error to surface.
   */
  captureTab: (targetId: string, quality = 55) =>
    request<TabCapture>(
      `/api/tabs/${encodeURIComponent(targetId)}/capture?q=${quality}`,
    ),

  snapshotTab: (targetId: string) =>
    request<{ tree: string; capturedAt: number }>(
      `/api/tabs/${encodeURIComponent(targetId)}/snapshot`,
    ),

  /**
   * One capture frame as a same-origin object URL.
   *
   * Fetched with credentials rather than linked with a token: the bytes
   * are small (one WebP frame) and the tag only sees an unguessable blob
   * URL. PagePeek offers save/refresh without exposing a remote URL.
   */
  captureObjectUrl: async (targetId: string, quality = 55): Promise<string> => {
    const headers = new Headers();
    if (authToken) headers.set('authorization', `Bearer ${authToken}`);
    const res = await fetch(
      `/api/tabs/${encodeURIComponent(targetId)}/capture.webp?q=${quality}`,
      { headers, credentials: 'same-origin' },
    );
    if (!res.ok) {
      if (res.status === 401) handleUnauthorized();
      throw new ApiError(res.status, res.statusText);
    }
    return URL.createObjectURL(await res.blob());
  },
};

function artifactPath(
  sessionId: string,
  group: ArtifactGroup,
  path: string,
): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/file?group=${group}&path=${encodeURIComponent(path)}`;
}

export type SocketEvent =
  | { type: 'ready' }
  | { type: 'subscribed'; sessionId: string; busy: boolean; queued: number; length: number }
  | {
      type: 'session_state';
      sessionId: string;
      title: string;
      status: string;
      busy: boolean;
      stoppable: boolean;
      queued: number;
      permission: string | null;
      permissionMode: string | null;
      finalConfirm: boolean | null;
      softConfirm: boolean;
      model: ThreadModel | null;
      contextWindow: number;
      suspended: boolean;
    }
  /** Replace items from `fromIndex` onward; `length` is the new total. */
  | { type: 'thread_delta'; sessionId: string; fromIndex: number; items: ThreadItem[]; length: number }
  /** Token counters and the citation catalog; moves independently of items. */
  | {
      type: 'thread_meta';
      sessionId: string;
      stats: ThreadStats;
      sources: Record<string, CitationSource>;
      todos: Todo[];
      subagents?: ThreadResponse['subagents'];
    }
  /** One subagent's own timeline, as it works. */
  | ({ type: 'subagent_delta'; sessionId: string } & ChildSteps)
  /** Provisional text off the running child's stdout. */
  | { type: 'activity'; sessionId: string; activity: { phase: 'thinking' | 'writing' | null; tools: string[]; summary?: string | null } }
  | { type: 'stream_delta'; sessionId: string; text: string }
  | { type: 'entries'; sessionId: string; entries: Entry[] }
  | { type: 'turn_started'; sessionId: string; model: string; effort: string; startedAt: number }
  | {
      type: 'turn_finished';
      sessionId: string;
      exitCode: number | null;
      durationMs: number;
      error?: string;
      /** The failure as a card; drawn by `ErrorCard`. */
      alert?: ErrorAlert;
      /** The user tapped Stop. Not a failure. */
      stopped?: boolean;
      /** The driver was reaped because the session suspended on a question. */
      suspended?: boolean;
    }
  | { type: 'error'; reason: string }
  | { type: 'pong' };

/**
 * How often the client proves the socket is still carrying traffic.
 *
 * The server pings at the protocol level every 30s, but a browser answers
 * those in the network layer and never tells the page, so a page cannot
 * tell a quiet connection from a dead one. On a phone that distinction is
 * the whole ball game: iOS and Android freeze a backgrounded tab's socket
 * without closing it, so `readyState` stays OPEN, `onclose` never fires,
 * no reconnect is ever scheduled, and the thread silently stops updating
 * until the app is force-quit and reopened. This is an APPLICATION-level
 * ping whose pong the page can actually see.
 */
const PING_INTERVAL_MS = 15_000;

/**
 * How long the socket may go without any inbound frame before it is
 * declared dead and replaced.
 *
 * Generous enough that a slow tailnet hop or a busy Mac does not cause
 * churn, tight enough that a resumed app recovers in one interval rather
 * than never.
 */
const SILENCE_LIMIT_MS = PING_INTERVAL_MS + 12_000;

/**
 * On resume, how stale the last inbound frame must be to justify tearing
 * the socket down rather than trusting it.
 *
 * A reconnect over loopback or a tailnet costs a few milliseconds and
 * guarantees a correct thread; guessing wrong in the other direction costs
 * a frozen screen. So the bias is deliberately toward reconnecting.
 */
const RESUME_STALE_MS = 5_000;

/** Events that mean "the user is looking at this again". */
const WAKE_EVENTS = ['visibilitychange', 'pageshow', 'focus', 'online'] as const;

/**
 * Live thread socket with reconnect, liveness detection, and resume.
 *
 * Three bugs lived in the previous version, all of which showed up as the
 * same symptom -- "I have to close the app and reopen the chat to see the
 * latest progress":
 *
 *  1. A RECONNECT NEVER RESYNCED. `onopen` announced the connection before
 *     it sent `subscribe`, so the hook's reaction to that announcement (a
 *     `resync` frame) reached the server while it still had no session
 *     bound and was discarded as a no-op. The `subscribe` that followed
 *     made the server take the CURRENT on-disk thread as the baseline of
 *     what the client already had. Everything written while the socket was
 *     down therefore existed on both sides of a diff that could never
 *     report it, and the thread stayed frozen at whatever was on screen
 *     when the connection dropped. Now the subscribe itself carries
 *     `full`, so a reconnect always re-sends the whole thread, and it is
 *     sent BEFORE the connection is announced so ordering cannot matter.
 *
 *  2. A FROZEN SOCKET WAS NEVER NOTICED. See `PING_INTERVAL_MS`.
 *
 *  3. RESUME WAITED OUT THE BACKOFF. Coming back to the app after a long
 *     drop could sit through up to ten seconds of exponential backoff
 *     before even trying. Any wake event now resets the backoff and
 *     reconnects immediately.
 */
export class TranscriptSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private timer: number | null = null;
  private beat: number | null = null;
  /** When a frame last arrived. The only honest evidence the socket lives. */
  private lastSeen = 0;
  /**
   * False only for the very first connection of this hook instance.
   *
   * That first one follows a REST load of the same thread, so the server's
   * on-disk baseline is genuinely what the client has and re-sending it
   * would be pure waste. Every later connection is a reconnect and must
   * assume it missed something.
   */
  private resumed = false;
  private detachWake: (() => void) | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly onEvent: (event: SocketEvent) => void,
    private readonly onOpenState?: (connected: boolean) => void,
  ) {}

  connect(): void {
    if (this.closed) return;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    // A half-open predecessor would otherwise keep firing handlers into a
    // socket this object no longer considers current.
    this.discard();
    this.listenForWake();

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    // The session cookie rides the upgrade automatically, so no token in
    // the URL. The first `auth` frame below carries the bearer for native
    // clients whose WebSocket stack skips cookies.
    const url = `${scheme}://${location.host}/ws`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      // Constructing a socket can throw outright (an origin the browser
      // will not upgrade). Treat it as a failed connection rather than an
      // unhandled rejection.
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retry = 0;
      this.lastSeen = Date.now();
      // Auth first, then subscribe. The cookie usually already authed the
      // socket server-side; the frame is a no-op there and the credential
      // for cookie-less clients. Either way it precedes `subscribe`, and
      // both precede the open announcement: see the class note.
      if (authToken) ws.send(JSON.stringify({ type: 'auth', token: authToken }));
      // Sent BEFORE the open is announced: see the class note. `full` asks
      // the server to treat this client as knowing nothing, which is the
      // only safe assumption after a gap of unknown length.
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          sessionId: this.sessionId,
          full: this.resumed,
        }),
      );
      this.resumed = true;
      this.startHeartbeat();
      this.onOpenState?.(true);
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      // Any frame at all is proof of life, including the pong this class
      // asked for and the ones the hook does not care about.
      this.lastSeen = Date.now();
      let parsed: SocketEvent;
      try {
        parsed = JSON.parse(event.data) as SocketEvent;
      } catch {
        return; // ignore unparsable frames
      }
      if (parsed.type === 'pong') return;
      if (parsed.type === 'error' && parsed.reason === 'unauthorized') {
        handleUnauthorized();
        this.closed = true;
        this.discard();
        this.onOpenState?.(false);
        return;
      }
      this.onEvent(parsed);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stopHeartbeat();
      this.ws = null;
      this.onOpenState?.(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      ws.close();
    };
  }

  /**
   * Detach and close whatever socket is current without letting its
   * handlers run. Used when replacing a connection deliberately, where the
   * `onclose` reconnect would race the one we are about to make.
   */
  private discard(): void {
    const ws = this.ws;
    this.ws = null;
    this.stopHeartbeat();
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // Closing an already-closing socket is not an error worth surfacing.
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.beat = window.setInterval(() => {
      if (this.closed) return;
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastSeen > SILENCE_LIMIT_MS) {
        // Nothing has come back for longer than two ping cycles. The socket
        // reads as OPEN but is not carrying traffic, which is precisely the
        // frozen-after-background case. Replace it.
        this.onOpenState?.(false);
        this.connect();
        return;
      }
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        this.onOpenState?.(false);
        this.connect();
      }
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.beat !== null) window.clearInterval(this.beat);
    this.beat = null;
  }

  /**
   * Reconnect the moment the app is looked at again.
   *
   * Registered once and kept for the life of the socket object, because
   * the interesting case is precisely the one where no socket is currently
   * open.
   */
  private listenForWake(): void {
    if (this.detachWake || typeof document === 'undefined') return;
    const onWake = () => {
      if (this.closed) return;
      if (document.visibilityState === 'hidden') return;
      // A resumed app has no reason to serve out a backoff computed from
      // failures that happened while nobody was watching.
      this.retry = 0;
      const ws = this.ws;
      const stale = Date.now() - this.lastSeen > RESUME_STALE_MS;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        this.connect();
        return;
      }
      if (stale) {
        // Cheap to redo, and the only way to be certain the thread on
        // screen matches the transcript on the Mac.
        this.onOpenState?.(false);
        this.connect();
      }
    };
    for (const name of WAKE_EVENTS) {
      window.addEventListener(name, onWake);
    }
    this.detachWake = () => {
      for (const name of WAKE_EVENTS) {
        window.removeEventListener(name, onWake);
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    // Capped at 5s rather than 10s: this is a link to a machine on the
    // owner's own tailnet, so a long backoff buys nothing and is felt.
    const delay = Math.min(500 * 2 ** this.retry, 5_000);
    this.retry += 1;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  /** Ask the server to re-send the whole thread. */
  resync(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'resync' }));
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.detachWake?.();
    this.detachWake = null;
    this.discard();
  }
}
