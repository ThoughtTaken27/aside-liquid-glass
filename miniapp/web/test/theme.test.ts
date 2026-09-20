import { afterEach, describe, expect, it } from 'vitest';
import { applyTheme } from '../src/telegram';

afterEach(() => {
  document.documentElement.classList.remove('dark');
  delete document.documentElement.dataset.theme;
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
