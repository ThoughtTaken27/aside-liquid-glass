/** Dev-only fixtures using the actual production primitives and status row. */
import './fit';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import './theme/tokens.css';
import './theme/base.css';
import './theme/components.css';
import './theme/next3.css';
import './theme/fits.css';
import './theme/turn.css';
import './theme/affect.css';
import './theme/system.css';
import { RollText, Shine, TextReveal } from './components/Affect';
import { StreamFooter } from './components/StreamFooter';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.client = 'standalone';
document.documentElement.dataset.fit = params.has('dark') ? 'midnight' : 'paper';
document.documentElement.classList.toggle('dark', params.has('dark'));

function Lab() {
  const [label, setLabel] = useState('Reading the release checklist');
  const [active, setActive] = useState(true);
  const [count, setCount] = useState(0);
  return <main style={{ padding: '32px 24px', color: 'var(--foreground)', font: '14px/1.5 var(--font-sans)', minHeight: '100vh', background: 'var(--background)' }}>
    <header><h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 8 }}><TextReveal text="A quieter way to work" play /></h1><p style={{ color: 'var(--muted-foreground)', marginBottom: 32 }}>Motion marks real progress. The words stay readable.</p></header>
    <section aria-label="Phone live status" style={{ marginBottom: 32 }}><StreamFooter phase={active ? 'working' : 'stopping'} label="Checking the interface" detail="Checking the interface" seed="fixture" /></section>
    <section aria-label="Changing status" style={{ marginBottom: 32 }}>
      <p style={{ color: 'var(--muted-foreground)', marginBottom: 8 }}>Current step</p>
      <div role="status" aria-live="polite" style={{ width: '100%', height: 24, color: 'var(--brand-text)' }}><RollText text={label} shine={active} /></div>
      <p data-stability-anchor style={{ marginTop: 8, color: 'var(--muted-foreground)' }}>This line must not move when the label changes.</p>
    </section>
    <section className="n3" aria-label="Next helper" style={{ marginBottom: 32 }}>
      <p style={{ marginBottom: 8 }}>Next helper</p><div className="n3-row-meta"><Shine text="Reading sources, 3 so far" active={active} /></div>
      <p className="n3-row-meta" style={{ marginTop: 12 }}>Queued. Waiting for a helper.</p>
    </section>
    <section aria-label="Completed work" style={{ marginBottom: 32 }}><Shine text="Ready for you to check" active={false} /></section>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button className="n3-btn is-secondary" onClick={() => { const n = count + 1; setCount(n); setLabel(n % 2 ? 'Checking' : 'Reading the release checklist'); }}>Change step</button>
      <button className="n3-btn is-secondary" onClick={() => setActive(on => !on)}>{active ? 'Stop highlight' : 'Start highlight'}</button>
      <button className="n3-btn is-secondary" onClick={() => { setLabel('Reading'); window.setTimeout(() => setLabel('Comparing the latest changes'), 50); window.setTimeout(() => setLabel('Done'), 100); }}>Rapid updates</button>
    </div>
    <div style={{ height: 900 }} aria-hidden="true" />
    <Shine text="Offscreen work label" active={active} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Lab /></StrictMode>);
