/**
 * Dev-only polish lab. Renders the real thread shell with the FULL live
 * stylesheet stack (unlike gallery.tsx, which predates the polish layers),
 * on generic fixture data, so cards, streaming and motion can be judged at
 * 393x852. Not an entry in the production build.
 *
 * ?state=cards   question card (live) + answered card + prose
 * ?state=stream  an answer streaming in word by word, live footer
 * ?state=home    not covered here; use the real app
 */
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './theme/tokens.css';
import './theme/base.css';
import './theme/components.css';
import './theme/next.css';
import './theme/next3.css';
import './theme/next-polish.css';
import './theme/polish.css';
import './theme/polish-next.css';
import './theme/refine.css';
import './theme/fits.css';
import './theme/craft.css';
import './theme/next-top.css';
import './theme/keyboard.css';
import './theme/queue.css';
import './theme/turn.css';
import './theme/materials.css';
import './theme/scroll-depth.css';
import './theme/affect.css';
import type { ThreadItem, WorkStep } from './types';
import { Thread } from './components/Thread';
import { Composer } from './components/Composer';
import { StreamFooter } from './components/StreamFooter';
import { ChevronLeft, MoreVertical } from './components/Icons';
import './theme/system.css';

document.documentElement.dataset.client = 'standalone';
document.documentElement.classList.toggle('dark', location.search.includes('dark'));

const state = new URLSearchParams(location.search).get('state') || 'cards';

function step(id: string, label: string, tool = 'bash'): WorkStep {
  return {
    kind: 'step', id, label, tool, icon: 'terminal', status: 'success',
    diffstat: null, detail: null, images: [],
  } as WorkStep;
}

const base: ThreadItem[] = [
  { kind: 'user', id: 'u1', text: 'Plan a slow Saturday. Coffee first, then a ride.', ts: 1 },
  {
    kind: 'work', id: 'w1', durationMs: 3200, running: false,
    items: [step('s1', 'Checked the forecast', 'web_search'), step('s2', 'Searched memory', 'memory_search')],
  },
  {
    kind: 'answer', id: 'a1', ts: 2,
    text: 'Saturday looks dry until about 2, then the wind picks up. If you ride, go out early and make coffee the turnaround.\n\nThe place you saved in August opens at 7 and has outdoor racks.',
  },
];

const question: ThreadItem = {
  kind: 'question', id: 'q1', variant: 'ask', source: 'tool', status: 'pending', answerable: true,
  questions: [{
    header: 'Reminder',
    question: 'Want a reminder to leave early?',
    options: [
      { label: 'Friday night', description: 'Pack the bag the night before' },
      { label: 'Saturday 6:30am', description: '' },
      { label: 'No reminder', description: '' },
    ],
  }],
};

const answered: ThreadItem = {
  kind: 'question', id: 'q0', variant: 'confirm', source: 'marker', status: 'answered', answerable: false,
  answer: 'Approve',
  questions: [{ header: 'Calendar', question: 'Add "Ride + coffee" to Saturday 7:00 AM?', options: [
    { label: 'Approve', description: '' }, { label: 'Cancel', description: '' },
  ] }],
};

const STREAM_TEXT =
  'Autumn reading is Read Next now and pinned, so the stack stays up top. Slow Saturday is archived, since the ride is done.\n\nI also moved the capture page to tomorrow morning, because tonight filled up.';

function Lab() {
  const scroller = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [streamed, setStreamed] = useState(0);
  const words = STREAM_TEXT.split(/(\s+)/);
  const [, setTick] = useState(0);
  // The virtualizer reads its scroll element on render; give it one pass
  // after the ref exists, as the real app does via its own later renders.
  useEffect(() => { setTick(1); }, []);

  useEffect(() => {
    if (state !== 'stream') return undefined;
    const timer = window.setInterval(() => {
      setStreamed((n) => (n >= words.length ? n : n + 6));
    }, 260);
    return () => window.clearInterval(timer);
  }, [words.length]);

  let items: ThreadItem[] = [...base];
  if (state === 'cards') items = [answered, ...base, question];
  if (state === 'stream') {
    items = [...base, { kind: 'user', id: 'u2', text: 'Tidy up my threads', ts: 3 },
      { kind: 'streaming', id: 'st', text: words.slice(0, streamed).join('') }];
  }

  return (
    <div className="app app-thread">
      <header className="thread-header" data-condensed="false">
        <div className="thread-header-left">
          <button type="button" className="icon-button" aria-label="Back"><ChevronLeft size={20} strokeWidth={1.75} /></button>
        </div>
        <span className="thread-titles">
          <span className="thread-title">Slow Saturday</span>
          <span className="thread-subtitle">Claude Opus 5.5 · Default</span>
        </span>
        <div className="thread-header-right">
          <button type="button" className="icon-button" aria-label="Session panel"><MoreVertical size={19} strokeWidth={1.75} /></button>
        </div>
      </header>
      <div className="thread-scroll" ref={scroller}>
        <Thread
          items={items}
          sessionId="lab"
          sources={{}}
          subagentSteps={{}}
          onInspectSubagent={() => {}}
          onOpenCitation={() => {}}
          onAnswer={() => new Promise((r) => setTimeout(r, 900))}
          busy={false}
          scrollElementRef={scroller}
        />
        {state === 'stream' ? (
          <StreamFooter phase="working" label="Writing" startedAt={Date.now() - 4000} />
        ) : null}
      </div>
      <footer className="thread-footer">
        <Composer
          variant="reply"
          value={draft}
          onChange={setDraft}
          onSubmit={() => setDraft('')}
          pills={{ modelLabel: 'Claude Opus 5.5', effortLabel: 'High', effortId: 'high', provider: 'claude-code' }}
          onOpenModel={() => {}}
          attachments={[]}
          onAddFiles={() => {}}
          onRemoveAttachment={() => {}}
          streaming={state === 'stream'}
        />
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Lab /></StrictMode>);
