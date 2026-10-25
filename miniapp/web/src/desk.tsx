/**
 * Next on the Mac, for a pinned Aside tab.
 *
 * Sign-in: the loopback-only page on the Mac (127.0.0.1:<port+1>/desk)
 * sends here with a one-time code in the hash. It is spent once for a
 * 90-day session; after that the session cookie keeps the tab signed in.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './theme/tokens.css';
import './theme/base.css';
import './theme/components.css';
import './theme/next.css';
import './theme/next3.css';
import './theme/desk.css';
import './theme/next-polish.css';
import './theme/polish-next.css';
import './theme/desk-refine.css';
import './theme/desk-v4.css';
// The craft system layers last, as in the phone app.
import './theme/system.css';
import { api, setAuthToken } from './api';
import { NextDesk } from './components/NextDesk';

const KEY = 'aside.desk.token';
document.documentElement.dataset.client = 'standalone';
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyDark = () => document.documentElement.classList.toggle('dark', dark.matches);
applyDark();
dark.addEventListener('change', applyDark);

async function signIn(): Promise<boolean> {
  // Dev preview only: a token in the query, never in a built page.
  const dev = import.meta.env.DEV ? new URLSearchParams(location.search).get('token') : null;
  if (dev) {
    setAuthToken(dev);
    return true;
  }
  const code = /[#&]pair=([\w-]{8,200})/.exec(location.hash)?.[1];
  if (code) {
    history.replaceState(null, '', location.pathname);
    try {
      const r = await api.pair(code);
      setAuthToken(r.token);
      localStorage.setItem(KEY, r.token);
      return true;
    } catch {
      /* fall through */
    }
  }
  try {
    const r = await api.session();
    setAuthToken(r.token);
    localStorage.setItem(KEY, r.token);
    return true;
  } catch {
    /* fall through */
  }
  const stored = localStorage.getItem(KEY);
  if (stored) {
    setAuthToken(stored);
    try {
      await api.next();
      return true;
    } catch {
      localStorage.removeItem(KEY);
    }
  }
  return false;
}

function Boot() {
  const [state, setState] = useState<'wait' | 'ok' | 'out'>('wait');
  useEffect(() => {
    void signIn().then((ok) => setState(ok ? 'ok' : 'out'));
  }, []);
  if (state === 'ok') return <NextDesk />;
  if (state === 'wait') return <div className="dk-boot" />;
  const pair = `http://127.0.0.1:${Number(location.port || 80) + 1}/desk`;
  return (
    <div className="dk-boot">
      <div className="dk-boot-card">
        <p className="dk-boot-title">Sign in on this Mac</p>
        <p>Next's Mac page signs in from a page only this Mac can open.</p>
        <a className="dk-btn is-primary" href={pair}>
          Sign in
        </a>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
