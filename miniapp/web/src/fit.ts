/**
 * Pick the look before the first render.
 *
 * This lives in the bundle, not as an inline script in index.html, because
 * the live server's CSP (`script-src 'self'`) blocks inline scripts: an
 * inline picker ran on the dev server and silently never ran on the phone.
 *
 * Default is `clay`, which follows light/dark (Paper by day, Midnight by
 * night). `?fit=paper|midnight` pins one, `?fit=clay` follows again and
 * `?fit=none` brings back the old look. The choice is remembered.
 */
import { isStandaloneEntry } from './standalone';

const FIT_PAGE: Record<string, string> = { paper: '#fafafa', midnight: '#1e1c1b' };

export function applyFit(): void {
  if (!(isStandaloneEntry() || location.pathname === '/dev.html')) return;
  const root = document.documentElement;
  let fit = new URLSearchParams(location.search).get('fit');
  try {
    if (fit === 'none' || fit === 'clay' || (fit && FIT_PAGE[fit])) localStorage.setItem('aside.fit', fit);
    else fit = localStorage.getItem('aside.fit');
  } catch {
    // Private mode: fall through to the default.
  }
  if (!fit) fit = 'clay';
  if (fit === 'none') return;

  if (fit === 'clay') {
    let pref: string | null = null;
    try {
      pref = localStorage.getItem('aside.theme');
    } catch {
      // ignore
    }
    const dark =
      pref === 'dark' || (pref !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.fitPair = 'clay';
    root.dataset.fit = dark ? 'midnight' : 'paper';
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
      const media = m.getAttribute('media') || '';
      m.setAttribute(
        'content',
        media.includes('dark') ? FIT_PAGE.midnight : media.includes('light') ? FIT_PAGE.paper : FIT_PAGE[dark ? 'midnight' : 'paper'],
      );
    }
  } else if (FIT_PAGE[fit]) {
    root.dataset.fit = fit;
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', FIT_PAGE[fit]);
  }
}

applyFit();
