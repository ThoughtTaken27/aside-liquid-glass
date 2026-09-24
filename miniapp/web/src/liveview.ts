/**
 * Live view of the tab this chat's agent is working in.
 *
 * A dedicated socket, separate from the transcript socket, so video can
 * never delay or break message sync. It opens only while a chat is on
 * screen and closes when the app is backgrounded.
 *
 * Wire format (see server/src/liveview.ts):
 *   -> {type:"auth"} then {type:"live", sessionId, stream, quality}
 *   <- {type:"live_tab", state, tab}   which tab, or none
 *   <- binary                          one JPEG frame; only changed frames arrive
 */
import { currentAuthToken, handleUnauthorized } from './api';

export type LiveState = 'live' | 'ready' | 'no_tab' | 'unavailable';

export interface LiveTab {
  targetId: string;
  url: string;
  title: string;
  faviconUrl: string;
  owner: 'session' | 'subagent';
}

export interface LiveMeta {
  state: LiveState;
  tab: LiveTab | null;
}

export type LiveQuality = 'card' | 'full';

/** Follow a chat's agent to whatever tab it uses, or watch one tab. */
export type LiveTarget = { sessionId: string } | { targetId: string };

/** The key the server tags this stream's meta with. */
export function liveKey(target: LiveTarget): string {
  return 'targetId' in target ? `tab:${target.targetId}` : target.sessionId;
}

export interface LiveHandlers {
  onMeta(meta: LiveMeta): void;
  onFrame(frame: Blob): void;
  onConnection(connected: boolean): void;
}

const MAX_BACKOFF_MS = 8_000;

export class LiveSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private timer: number | null = null;
  private stream = false;
  private quality: LiveQuality = 'card';
  private readonly onVisibility = () => {
    if (this.closed) return;
    if (document.visibilityState === 'hidden') {
      // Nobody is looking: let the Mac stop capturing.
      this.drop();
    } else if (!this.ws) {
      this.retry = 0;
      this.connect();
    }
  };

  private readonly key: string;

  constructor(
    private readonly target: LiveTarget,
    private readonly handlers: LiveHandlers,
  ) {
    this.key = liveKey(target);
  }

  start(): void {
    document.addEventListener('visibilitychange', this.onVisibility);
    if (document.visibilityState !== 'hidden') this.connect();
  }

  /** Ask for frames (or stop them). Cheap to call on every render. */
  setStream(stream: boolean, quality: LiveQuality = 'card'): void {
    if (stream === this.stream && quality === this.quality) return;
    this.stream = stream;
    this.quality = quality;
    this.announce();
  }

  close(): void {
    this.closed = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.drop();
  }

  private announce(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'live',
        ...this.target,
        stream: this.stream,
        quality: this.quality,
      }),
    );
  }

  private connect(): void {
    if (this.closed || this.ws) return;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${scheme}://${location.host}/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'blob';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retry = 0;
      const token = currentAuthToken();
      if (token) ws.send(JSON.stringify({ type: 'auth', token }));
      this.announce();
      this.handlers.onConnection(true);
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      if (typeof event.data !== 'string') {
        if (this.stream) this.handlers.onFrame(event.data as Blob);
        return;
      }
      let msg: { type?: string; reason?: string; state?: LiveState; tab?: LiveTab | null; sessionId?: string };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'error' && msg.reason === 'unauthorized') {
        handleUnauthorized();
        this.close();
        return;
      }
      if (msg.type === 'live_tab' && msg.sessionId === this.key && msg.state) {
        this.handlers.onMeta({ state: msg.state, tab: msg.tab ?? null });
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handlers.onConnection(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      if (this.ws === ws) ws.close();
    };
  }

  private drop(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      // already closing
    }
    this.handlers.onConnection(false);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer !== null) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.retry);
    this.retry += 1;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}

/** "news.ycombinator.com" from a URL, or the raw string when it is not one. */
export function hostOf(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}
