/**
 * The agent-tab live view card.
 *
 * The socket is faked; frames are delivered as Blobs the way the browser
 * hands binary WebSocket messages over. Image decoding is stubbed because
 * jsdom does not decode images.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { setAuthToken } from '../src/api';
import { LiveBrowserCard } from '../src/components/LiveBrowser';
import { hostOf } from '../src/liveview';

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = 'blob';
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(payload: unknown) {
    this.onmessage?.({ data: typeof payload === 'string' || payload instanceof Blob ? payload : JSON.stringify(payload) });
  }
}

const tab = {
  targetId: 'T1',
  url: 'https://www.example.com/checkout',
  title: 'Checkout · Example',
  faviconUrl: '',
  owner: 'session' as const,
};

beforeEach(() => {
  FakeSocket.instances = [];
  setAuthToken('test-token');
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:frame', revokeObjectURL: () => {} }));
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: () => Promise.resolve(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

function lastLive(socket: FakeSocket) {
  return [...socket.sent].reverse().find((m) => m.type === 'live');
}

describe('LiveBrowserCard', () => {
  it('stays hidden until the agent has a real tab', () => {
    const { container } = render(<LiveBrowserCard sessionId="chat-1" busy />);
    const socket = FakeSocket.instances[0];
    act(() => socket.open());
    expect(container.querySelector('.live-view')).toBeNull();
    act(() => socket.deliver({ type: 'live_tab', sessionId: 'chat-1', state: 'no_tab', tab: null }));
    expect(container.querySelector('.live-view')).toBeNull();
  });

  it('authenticates, then asks for this chat', () => {
    render(<LiveBrowserCard sessionId="chat-1" busy={false} />);
    const socket = FakeSocket.instances[0];
    act(() => socket.open());
    expect(socket.sent[0]).toEqual({ type: 'auth', token: 'test-token' });
    expect(socket.sent[1]).toMatchObject({ type: 'live', sessionId: 'chat-1', stream: false });
  });

  it('shows the agent tab and streams while a turn runs', async () => {
    const { container } = render(<LiveBrowserCard sessionId="chat-1" busy />);
    const socket = FakeSocket.instances[0];
    act(() => socket.open());
    act(() => socket.deliver({ type: 'live_tab', sessionId: 'chat-1', state: 'ready', tab }));
    expect(screen.getByText('Checkout · Example')).toBeTruthy();
    expect(screen.getByText(/Agent tab · example\.com/)).toBeTruthy();
    expect(lastLive(socket)).toMatchObject({ stream: true, quality: 'card' });
    expect(container.querySelector('.live-view-wait')).not.toBeNull();

    await act(async () => {
      socket.deliver(new Blob(['jpeg'], { type: 'image/jpeg' }));
      await Promise.resolve();
    });
    const img = container.querySelector('.live-view-frame') as HTMLImageElement;
    expect(img?.getAttribute('src')).toBe('blob:frame');
    expect(screen.getByRole('status').textContent).toMatch(/live/i);
  });

  it('ignores another chat’s tab', () => {
    const { container } = render(<LiveBrowserCard sessionId="chat-1" busy />);
    const socket = FakeSocket.instances[0];
    act(() => socket.open());
    act(() => socket.deliver({ type: 'live_tab', sessionId: 'chat-2', state: 'ready', tab }));
    expect(container.querySelector('.live-view')).toBeNull();
  });

  it('is a slim bar when idle and stops frames when collapsed', () => {
    const { container } = render(<LiveBrowserCard sessionId="chat-1" busy={false} />);
    const socket = FakeSocket.instances[0];
    act(() => socket.open());
    act(() => socket.deliver({ type: 'live_tab', sessionId: 'chat-1', state: 'ready', tab }));
    expect(container.querySelector('.live-view.is-collapsed')).not.toBeNull();
    expect(container.querySelector('.live-view-stage')).toBeNull();
    expect(lastLive(socket)).toMatchObject({ stream: false });

    fireEvent.click(container.querySelector('.live-view-head')!);
    expect(container.querySelector('.live-view-stage')).not.toBeNull();
    expect(lastLive(socket)).toMatchObject({ stream: true });

    fireEvent.click(container.querySelector('.live-view-head')!);
    expect(lastLive(socket)).toMatchObject({ stream: false });
  });

  it('opens full screen at higher quality and closes with Escape', () => {
    const { container } = render(<LiveBrowserCard sessionId="chat-1" busy />);
    const socket = FakeSocket.instances[0];
    act(() => socket.open());
    act(() => socket.deliver({ type: 'live_tab', sessionId: 'chat-1', state: 'live', tab }));
    fireEvent.click(container.querySelector('.live-view-stage')!);
    expect(document.querySelector('.live-full')).not.toBeNull();
    expect(lastLive(socket)).toMatchObject({ stream: true, quality: 'full' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('.live-full')).toBeNull();
    expect(lastLive(socket)).toMatchObject({ quality: 'card' });
  });

  it('closes its socket when the chat closes', () => {
    const { unmount } = render(<LiveBrowserCard sessionId="chat-1" busy />);
    const socket = FakeSocket.instances[0];
    act(() => socket.open());
    unmount();
    expect(socket.readyState).toBe(3);
  });
});

describe('hostOf', () => {
  it('trims www and falls back to the raw string', () => {
    expect(hostOf('https://www.example.com/a')).toBe('example.com');
    expect(hostOf('not a url')).toBe('not a url');
  });
});
