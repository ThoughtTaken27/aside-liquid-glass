import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '../theme/tokens.css';
import '../theme/base.css';
import '../theme/components.css';
import '../theme/next.css';
import '../theme/next3.css';
import '../theme/desk.css';
import '../theme/next-polish.css';
import '../theme/polish-next.css';
import '../theme/desk-refine.css';
import '../theme/desk-v4.css';
import '../theme/context.css';
import { setAuthToken } from '../api';
import { NextScreen } from '../components/NextScreen';
import { NextDesk } from '../components/NextDesk';
/** Development entry only. Every API goes to the isolated fixture server. */
async function boot() {
  if (!import.meta.env.DEV) throw new Error('Synthetic preview is development-only');
  const q = new URLSearchParams(location.search);
  document.documentElement.dataset.client = 'standalone';
  document.documentElement.classList.toggle('dark', q.get('dark') === '1');
  const response = await fetch('/__context-fixture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario: q.get('state') || 'ready' }) });
  if (!response.ok) throw new Error('Synthetic fixture server unavailable');
  const body = await response.json();
  setAuthToken(`synthetic-preview:${body.id}`);
  createRoot(document.getElementById('root')!).render(q.get('device') === 'desktop' ? <NextDesk /> : <NextScreen sessions={[]} onClose={() => {}} onOpenThread={() => {}} onSessionsChanged={() => {}} />);
}
void boot().catch(() => { document.getElementById('root')!.textContent = 'Synthetic preview unavailable. Start its isolated fixture server; no live source is used as a fallback.'; });
