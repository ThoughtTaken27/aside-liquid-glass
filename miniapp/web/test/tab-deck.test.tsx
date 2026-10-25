/**
 * The Browser sheet: search vs open, agent section, live viewer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { api } from '../src/api';
import { TabDeck, destination } from '../src/components/TabDeck';
import type { BrowserTab } from '../src/types';

const tabs: BrowserTab[] = [
  { id: '1', targetId: 'A', windowId: 1, title: 'Inbox (3) - Gmail', url: 'https://mail.google.com/', active: true, faviconUrl: '/api/tabs/favicon?u=x' },
  { id: '2', targetId: 'B', windowId: 1, title: 'Leiden Shorts - Wikipedia', url: 'https://en.wikipedia.org/wiki/Leiden_Shorts', active: false, agent: { sessionId: 's1', title: 'Wiki walk', running: true } },
  { id: '3', targetId: 'C', windowId: 1, title: 'Home / X', url: 'https://x.com/home', active: false },
];

class QuietSocket {
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = 'blob';
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() {}
}

beforeEach(() => {
  vi.spyOn(api, 'tabs').mockResolvedValue({ tabs });
  vi.stubGlobal('WebSocket', QuietSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  cleanup();
});

async function renderDeck() {
  const view = render(<TabDeck onClose={() => {}} />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

describe('destination', () => {
  it('opens URLs and bare domains, searches everything else', () => {
    expect(destination('https://a.com/x')).toBe('https://a.com/x');
    expect(destination('espn.com')).toBe('https://espn.com');
    expect(destination('localhost:3000')).toBe('http://localhost:3000');
    expect(destination('gmail')).toBeNull();
    expect(destination('best pizza nyc')).toBeNull();
    expect(destination('   ')).toBeNull();
  });
});

describe('TabDeck', () => {
  it('lifts agent tabs into their own section with the chat name', async () => {
    const { container } = await renderDeck();
    const agent = container.querySelector('.tab-deck-agents');
    expect(agent?.textContent).toMatch(/Agent is using/);
    expect(agent?.textContent).toMatch(/Wiki walk/);
    expect(agent?.textContent).toMatch(/Working/);
    expect(screen.getByText('3 tabs open on your Mac')).toBeTruthy();
    expect(container.querySelectorAll('.tab-deck-row')).toHaveLength(3);
  });

  it('filters as you type and says what Return will do', async () => {
    const { container } = await renderDeck();
    fireEvent.change(screen.getByLabelText('Search tabs or enter a URL'), { target: { value: 'gmail' } });
    expect(container.querySelectorAll('.tab-deck-row')).toHaveLength(1);
    expect(screen.getByText(/1 matching tab/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search tabs or enter a URL'), { target: { value: 'espn.com' } });
    expect(screen.getByText(/Return opens espn\.com/)).toBeTruthy();
  });

  it('opens a tapped tab in the live viewer', async () => {
    await renderDeck();
    fireEvent.click(screen.getByText('Home / X'));
    expect(document.querySelector('.live-full')).not.toBeNull();
    expect(screen.getByText('Close tab')).toBeTruthy();
  });

  it('shows placeholders, not a spinner line, while loading', () => {
    vi.spyOn(api, 'tabs').mockReturnValue(new Promise(() => {}));
    const { container } = render(<TabDeck onClose={() => {}} />);
    expect(container.querySelectorAll('.tab-deck-skeleton-row').length).toBeGreaterThan(0);
  });
});
