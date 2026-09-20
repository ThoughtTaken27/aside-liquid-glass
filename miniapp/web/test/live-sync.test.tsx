/**
 * The three fixes behind "it never shows that it's actually working, and I
 * have to close the app and reopen the chat to see the latest progress".
 *
 * Each of these is a real bug that was reproduced against the live service,
 * and each one is invisible from a screenshot -- they only show up as a
 * thread that stopped moving. So they are pinned here rather than trusted.
 *
 *  1. A reconnect must tell the server to assume the client knows nothing.
 *     Without that flag the server rebuilds its baseline from the CURRENT
 *     file, so everything written during the outage sits on both sides of
 *     a diff and can never be sent. The thread stays frozen until the chat
 *     is closed and reopened, which is exactly what forces a REST reload.
 *
 *  2. A socket that is OPEN but silent must be replaced. Phones freeze a
 *     backgrounded socket without closing it, so `onclose` never fires and
 *     nothing ever reconnects.
 *
 *  3. A delta that starts past the end of what the client holds must not
 *     be applied. Splicing it on anyway welds two disjoint halves of the
 *     thread together, which is the duplicated / out-of-order card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TranscriptSocket, setAuthToken, setUnauthorizedHandler } from '../src/api';
import { applyDelta, deltaHasGap } from '../src/hooks/useThread';
import { Composer } from '../src/components/Composer';
import type { ComposerAttachment, ThreadItem } from '../src/types';

// --- 1 + 2: the socket ----------------------------------------------------

interface Sent {
  type: string;
  [key: string]: unknown;
}

/**
 * A WebSocket that does nothing until the test tells it to, so open,
 * message, silence and close are all separately controllable.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  sent: Sent[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Sent);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  /** Complete the handshake, as a real server would. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const realWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeSocket.instances = [];
  setAuthToken('test-token');
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
  globalThis.WebSocket = realWebSocket;
  cleanup();
});

describe('TranscriptSocket', () => {
  it('subscribes before it reports the connection as open', () => {
    // Ordering matters: the hook reacts to "connected" by refetching
    // metadata, and anything it sends must land on a server that already
    // has this session bound. The old code announced first and sent the
    // subscribe afterwards, which is why the resync it triggered was
    // discarded by a server with no session.
    const seenAtOpen: number[] = [];
    const socket = new TranscriptSocket(
      'abc123',
      () => {},
      () => seenAtOpen.push(FakeSocket.instances[0].sent.length),
    );
    socket.connect();
    FakeSocket.instances[0].open();

    expect(FakeSocket.instances[0].url).not.toContain('token');
    expect(FakeSocket.instances[0].sent[0]).toEqual({
      type: 'auth',
      token: 'test-token',
    });
    expect(FakeSocket.instances[0].sent[1]).toMatchObject({
      type: 'subscribe',
      sessionId: 'abc123',
    });
    expect(seenAtOpen).toEqual([2]);
    socket.close();
  });

  it('asks for a cheap baseline on the first connect and a full one after', () => {
    // Fake timers BEFORE connecting, so the reconnect backoff is one this
    // test owns rather than a real timeout that outlives it.
    vi.useFakeTimers();
    const socket = new TranscriptSocket('abc123', () => {});
    try {
      socket.connect();
      FakeSocket.instances[0].open();
      expect(FakeSocket.instances[0].sent[1].full).toBe(false);

      // The connection drops and comes back. Everything written in between
      // is unknown to this client, so it must not let the server assume the
      // file on disk is what it already has.
      FakeSocket.instances[0].close();
      vi.advanceTimersByTime(1_000);

      expect(FakeSocket.instances).toHaveLength(2);
      FakeSocket.instances[1].open();
      expect(FakeSocket.instances[1].sent[0]).toEqual({
        type: 'auth',
        token: 'test-token',
      });
      expect(FakeSocket.instances[1].sent[1]).toMatchObject({
        type: 'subscribe',
        sessionId: 'abc123',
        full: true,
      });
    } finally {
      socket.close();
    }
  });

  it('stops reconnecting and starts credential recovery after an auth rejection', () => {
    vi.useFakeTimers();
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    const socket = new TranscriptSocket('abc123', () => {});
    socket.connect();
    FakeSocket.instances[0].open();
    FakeSocket.instances[0].deliver({ type: 'error', reason: 'unauthorized' });
    expect(unauthorized).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    socket.close();
  });

  it('replaces a socket that is open but has gone silent', () => {
    vi.useFakeTimers();
    const socket = new TranscriptSocket('abc123', () => {});
    try {
      socket.connect();
      FakeSocket.instances[0].open();

      // One heartbeat with the connection healthy: a ping, no replacement.
      vi.advanceTimersByTime(15_000);
      expect(FakeSocket.instances[0].sent).toContainEqual({ type: 'ping' });
      expect(FakeSocket.instances).toHaveLength(1);

      // Now nothing comes back at all -- the frozen-after-background case.
      // `readyState` is still OPEN, so nothing else in the app would notice.
      vi.advanceTimersByTime(45_000);
      expect(FakeSocket.instances.length).toBeGreaterThan(1);
    } finally {
      socket.close();
    }
  });

  it('reconnects immediately when the app is looked at again', () => {
    vi.useFakeTimers();
    const socket = new TranscriptSocket('abc123', () => {});
    try {
      socket.connect();
      FakeSocket.instances[0].open();
      FakeSocket.instances[0].close();
      expect(FakeSocket.instances).toHaveLength(1);

      // Mid-backoff, the user returns to the app. Waiting out the timer
      // here is exactly the delay that read as "the app is stuck".
      window.dispatchEvent(new Event('focus'));
      expect(FakeSocket.instances).toHaveLength(2);
    } finally {
      socket.close();
    }
  });

  it('stops everything once closed', () => {
    vi.useFakeTimers();
    const socket = new TranscriptSocket('abc123', () => {});
    socket.connect();
    FakeSocket.instances[0].open();
    socket.close();

    const before = FakeSocket.instances.length;
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(before);
  });
});

// --- 3: the delta gap -----------------------------------------------------

const item = (id: string): ThreadItem => ({
  kind: 'answer',
  id,
  text: id,
  ts: null,
});

describe('deltaHasGap', () => {
  it('accepts a delta that starts inside what the client holds', () => {
    expect(deltaHasGap([item('a'), item('b')], { fromIndex: 1 })).toBe(false);
  });

  it('accepts a delta that appends exactly at the end', () => {
    expect(deltaHasGap([item('a'), item('b')], { fromIndex: 2 })).toBe(false);
  });

  it('rejects a delta that starts past the end', () => {
    // The client has two items and is being handed items 5 onward. Items
    // 2, 3 and 4 exist on the Mac and are in neither list, so applying
    // this would put item 5 immediately after item 1.
    expect(deltaHasGap([item('a'), item('b')], { fromIndex: 5 })).toBe(true);
  });

  it('is what stands between a gap and a mangled thread', () => {
    // Proof that applying it anyway really does corrupt the order, so the
    // guard is not defensive noise.
    const mangled = applyDelta([item('a'), item('b')], {
      fromIndex: 5,
      items: [item('f')],
      length: 6,
    });
    expect(mangled.map((i) => i.id)).toEqual(['a', 'b', 'f']);
    expect(mangled).toHaveLength(3);
    // ...while the server believes the thread is six items long.
  });
});

// --- the stop control -----------------------------------------------------

const composerProps = {
  variant: 'thread' as const,
  value: '',
  onChange: () => {},
  onSubmit: () => {},
  pills: {
    modelLabel: 'Opus 5',
    effortLabel: 'High',
    provider: 'claude-code',
  },
  onOpenModel: () => {},
  onOpenPermission: () => {},
  permissionMode: 'guard',
  attachments: [] as ComposerAttachment[],
  onAddFiles: () => {},
  onRemoveAttachment: () => {},
};

describe('the send button in its stop state', () => {
  it('replaces send rather than sitting beside it', () => {
    // The desktop composer has ONE control in this slot. The phone used to
    // show a second, smaller square to the left of a still-lit send arrow,
    // so the black stop circle never appeared and the composer looked
    // ready for another message mid-turn.
    render(<Composer {...composerProps} streaming onStop={() => {}} />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('fires on a single tap, with no confirmation in the way', () => {
    const onStop = vi.fn();
    render(<Composer {...composerProps} streaming onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('explains itself instead of doing nothing when the Mac owns the turn', () => {
    // A turn started in the desktop app runs inside the daemon, which this
    // server cannot signal. Showing a button that silently does nothing is
    // the failure worth designing against.
    render(
      <Composer
        {...composerProps}
        streaming
        stopBlocked="Only the Mac can stop this one."
      />,
    );
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(stop);
    expect(screen.getByText('Only the Mac can stop this one.')).toBeTruthy();
  });
});
