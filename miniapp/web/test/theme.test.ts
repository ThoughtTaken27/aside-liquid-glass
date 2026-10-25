import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme } from '../src/telegram';

afterEach(() => {
  document.documentElement.classList.remove('dark');
  delete document.documentElement.dataset.theme;
  localStorage.removeItem('aside.theme');
  document.documentElement.style.removeProperty('--page');
  document.documentElement.style.removeProperty('--system-bar');
  delete document.documentElement.dataset.client;
  delete document.documentElement.dataset.fit;
  delete document.documentElement.dataset.fitPair;
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
  delete (window as Window & { AsideTheme?: unknown }).AsideTheme;
  // @ts-expect-error -- test-only Telegram bridge stub
  delete window.Telegram;
});

describe('mobile theme bridge', () => {
  it('keeps the runtime attribute and the CSS dark-mode class in sync', () => {
    // @ts-expect-error -- only colorScheme is needed by applyTheme here
    window.Telegram = { WebApp: { colorScheme: 'dark' } };

    expect(applyTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    // Telegram can change theme without reloading the app.
    window.Telegram!.WebApp!.colorScheme = 'light';

    expect(applyTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

 describe('system bar theme', () => {
  it.each(['light', 'dark'] as const)('uses one exact colour for manual %s even against OS preference', scheme => {
    document.head.insertAdjacentHTML('beforeend', '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#old"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#old">');
    const setSystemBars = vi.fn();
    (window as Window & { AsideTheme?: unknown }).AsideTheme = { setSystemBars };
    localStorage.setItem('aside.theme', scheme);
    const color = scheme === 'dark' ? '#131211' : '#f7f5f0';
    document.documentElement.style.setProperty('--page', color);
    applyTheme();
    const tags = document.querySelectorAll('meta[name="theme-color"]');
    expect(tags).toHaveLength(1);
    expect(tags[0].getAttribute('media')).toBeNull();
    expect(tags[0].getAttribute('content')).toBe(color);
    expect(setSystemBars).toHaveBeenCalledWith(color, scheme === 'dark');
  });
  it('keeps the active tag synchronized when switching back to auto', () => {
    localStorage.setItem('aside.theme', 'dark');
    document.documentElement.style.setProperty('--page', '#131211');
    applyTheme();
    localStorage.setItem('aside.theme', 'auto');
    document.documentElement.style.setProperty('--page', '#f7f5f0');
    applyTheme();
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#f7f5f0');
  });
});

describe('fade endpoint system chrome', () => {
  it.each([
    ['light', '#f7f5f0', '#f8f6f1'],
    ['dark', '#131211', '#1e1c1b'],
  ])('uses the %s fade endpoint instead of its underlying page', (scheme, page, top) => {
    const root = document.documentElement;
    root.dataset.client = 'standalone';
    root.style.setProperty('--page', page);
    root.style.setProperty('--system-bar', top);
    localStorage.setItem('aside.theme', scheme);
    const setSystemBars = vi.fn();
    (window as Window & { AsideTheme?: unknown }).AsideTheme = { setSystemBars };
    applyTheme();
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(top);
    expect(setSystemBars).toHaveBeenCalledWith(top, scheme === 'dark');
  });
});
