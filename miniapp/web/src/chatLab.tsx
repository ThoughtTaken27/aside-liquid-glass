/** Dev-only harness for the thread tail: error card, live run, live view. */
import './fit';
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
import { QueuedMessages } from './components/QueuedMessages';
import { questionFixture } from './questionFixtures';
import { emulateTouch, installSlashLab } from './slashFixtures';
import { LAB_SENT, labAttachments } from './attachFixtures';
import { ImageLightbox } from './components/ImageLightbox';
import { useStreamSim } from './streamLab';
import { useEndFollow } from './hooks/useEndFollow';
import type { ComposerAttachment } from './types';
import { TodoSection } from './components/TodoSection';
import { HeaderActivity } from './components/ActivityIsland';
import type { QueuedMessage } from './types';
import type { ThreadItem, WorkStep } from './types';
import { Thread } from './components/Thread';
import { Composer } from './components/Composer';
import { ErrorCard } from './components/ErrorCard';
import { ToastHost, toast } from './components/Toasts';
import { LiveWorkTail } from './components/WorkFold';
import { LiveBadge } from './components/LiveBrowser';
import { ChevronLeft, Globe, MoreVertical } from './components/Icons';
import { withoutResolvedErrors } from './utils/resolvedErrors';
import { ChevronDown, Maximize2 } from 'lucide-react';
import './theme/system.css';

document.documentElement.dataset.client = 'standalone';
document.documentElement.dataset.fit = location.search.includes('dark') ? 'midnight' : 'paper';
document.documentElement.dataset.fitPair = 'clay';
document.documentElement.classList.toggle('dark', location.search.includes('dark'));
const state = new URLSearchParams(location.search).get('state') || 'error';
if (state === 'attach' && location.search.includes('touch')) emulateTouch();
if (state === 'slash') { try { localStorage.removeItem('aside.skills.v1'); } catch { /* lab only */ } installSlashLab(); if (location.search.includes('touch')) emulateTouch(); }

function step(id: string, label: string, status: WorkStep['status'] = 'success', tool = 'bash', diffstat: WorkStep['diffstat'] = null): WorkStep {
  return { kind: 'step', id, label, tool, icon: 'terminal', status, diffstat, detail: { command: label, output: 'ok' }, images: [] } as WorkStep;
}
function web(id: string, label: string, tool: string, command: string, output = ''): WorkStep {
  return { kind: 'step', id, label, tool, icon: 'globe', status: 'success', diffstat: null, detail: { command, output }, images: [] } as WorkStep;
}
const searchOut = 'Results:\nhttps://www.transitions.dev/skeleton\nhttps://github.com/example/ui-runtime\nhttps://developer.mozilla.org/en-US/docs/Web/CSS/animation\nhttps://web.dev/articles/animations-guide\nhttps://css-tricks.com/shimmer\nhttp://localhost:5173/dev';
const say = (id: string, text: string) => ({ kind: 'text' as const, id, text });

/* A finished turn shaped like a real one: skills, memory, web, commands,
   edits with a diffstat, and the agent's narration between them. */
const turnItems: ThreadItem[] = [
  { kind: 'user', id: 'tu1', text: 'Implement the skeleton effect in the phone app and add a desktop-style queue. Keep everything smooth.', ts: 1 },
  { kind: 'work', id: 'tw1', durationMs: 2340000, running: false, items: [
    step('a1', 'Read the agentic-build skill', 'success', 'read_file'),
    step('a2', 'Read the apple-design skill', 'success', 'read_file'),
    step('a3', 'Searched memory', 'success', 'memory_search'),
    web('a4', 'Searched “skeleton loading runtime”', 'websearch', 'skeleton loading runtime', searchOut),
    web('a5', 'Fetched https://www.transitions.dev/skeleton', 'webfetch', 'https://www.transitions.dev/skeleton'),
    say('n1', 'Got the effect source (transitions.dev "UI generation" skeleton runtime). Now inspecting the phone app code.'),
    step('b1', 'Ran a command', 'success', 'bash'),
    step('b2', 'Ran a command', 'success', 'bash'),
    say('n2', 'Now writing the QueuedMessages component.'),
    step('c1', 'Wrote QueuedMessages.tsx', 'success', 'write_file', { added: 214, removed: 0 }),
    step('c2', 'Edited App.tsx', 'success', 'edit_file', { added: 189, removed: 12 }),
    step('c3', 'Ran a command', 'success', 'bash'),
  ] },
  { kind: 'answer', id: 'ta1', text: 'Both features are built and merged into **main**. The skeleton effect is already live; the queue needs one server restart.', ts: 2 },
];
const workingItems: ThreadItem[] = [
  turnItems[0],
  { kind: 'work', id: 'tw2', durationMs: 64000, running: true, items: [
    step('a1', 'Read the agentic-build skill', 'success', 'read_file'),
    step('a3', 'Searched memory', 'success', 'memory_search'),
    say('n1', 'Got the effect source. Now inspecting the phone app code.'),
    step('b1', 'Ran a command', 'pending', 'bash'),
  ] },
];
const answeringItems: ThreadItem[] = [
  turnItems[0],
  { ...(turnItems[1] as Extract<ThreadItem, { kind: 'work' }>), running: true, durationMs: 2340000 },
  { kind: 'streaming', id: 'st1', text: 'Both features are built and merged into **main**. The skeleton effect is already' } as ThreadItem,
];

const base: ThreadItem[] = [
  { kind: 'user', id: 'u1', text: 'Why is the orb so low quality? It needs more polish with the setup and layout.', ts: 1 },
  { kind: 'work', id: 'w1', durationMs: 3200, running: false,
    items: [step('s1', 'Read a file', 'success', 'read_file'), step('s2', 'Wrote a file', 'error', 'write_file')] },
];
/* Generic fixtures for every alert voice (no real data). */
const LAB_ALERTS = [
  { title: 'Task was aborted', description: 'The previous run was aborted before it finished.', detail: '', tone: 'muted' as const },
  { title: 'Request rate limited', description: 'The model provider temporarily rate-limited this request. Try again later.', detail: '429 Too Many Requests: rate_limit_exceeded (retry-after 34s)', tone: 'muted' as const },
  { title: 'The AI provider is temporarily unavailable.', description: 'The task stopped because the model request failed with a provider server error. We retried automatically, but the provider did not recover in time. Try again to continue from the latest state.', detail: '529 overloaded_error', tone: 'muted' as const },
  { title: 'Provider sign-in expired', description: 'Reconnect ChatGPT in Aside on your computer, then try the task again.', detail: '401 token_expired', tone: 'muted' as const },
  { title: 'There was an error while running the task', description: 'ENOENT: no such file or directory, open /tmp/example/report.csv', detail: 'ENOENT: no such file or directory, open /tmp/example/report.csv\n    at Object.openSync (node:fs:573:3)', tone: 'destructive' as const },
];

const errorItem: ThreadItem = {
  kind: 'error', id: 'e1', text: 'Request timed out.', ts: 2,
  alert: { title: 'There was an error while running the task', description: 'Request timed out.', detail: 'Request timed out.', tone: 'destructive' },
};
const running = { kind: 'work' as const, id: 'w2', durationMs: 2000, running: true,
  items: [step('r1', 'Move old prototype aside', 'pending')] };

/* A turn that plays out on a 1.3s beat, for watching live-to-done motion. */
const simFrames: { items: WorkStep[] | any[]; running: boolean; label?: string; answer?: string }[] = [
  { items: [step('a1', 'Read the agentic-build skill', 'success', 'read_file')], running: true, label: 'Reading the build skill' },
  { items: [step('a1', 'Read the agentic-build skill', 'success', 'read_file'), step('a3', 'Searched memory', 'success', 'memory_search')], running: true, label: 'Checking what I remember' },
  { items: [step('a1', 'Read the agentic-build skill', 'success', 'read_file'), step('a3', 'Searched memory', 'success', 'memory_search'), say('n1', 'Found the prior notes. Searching for the effect source next.'), web('a4', 'Searched “skeleton loading runtime”', 'websearch', 'skeleton loading runtime', searchOut)], running: true, label: 'Searching the web' },
  { items: [step('a1', 'Read the agentic-build skill', 'success', 'read_file'), step('a3', 'Searched memory', 'success', 'memory_search'), say('n1', 'Found the prior notes. Searching for the effect source next.'), web('a4', 'Searched “skeleton loading runtime”', 'websearch', 'skeleton loading runtime', searchOut), say('n2', 'Got the source. Now inspecting the phone app code.'), step('b1', 'Ran a command', 'pending', 'bash')], running: true, label: 'Running the build' },
  { items: [step('a1', 'Read the agentic-build skill', 'success', 'read_file'), step('a3', 'Searched memory', 'success', 'memory_search'), say('n1', 'Found the prior notes. Searching for the effect source next.'), web('a4', 'Searched “skeleton loading runtime”', 'websearch', 'skeleton loading runtime', searchOut), say('n2', 'Got the source. Now inspecting the phone app code.'), step('b1', 'Ran a command', 'success', 'bash'), step('c1', 'Wrote Skeleton.tsx', 'pending', 'write_file')], running: true, label: 'Writing Skeleton.tsx' },
  { items: [step('a1', 'Read the agentic-build skill', 'success', 'read_file'), step('a3', 'Searched memory', 'success', 'memory_search'), say('n1', 'Found the prior notes. Searching for the effect source next.'), web('a4', 'Searched “skeleton loading runtime”', 'websearch', 'skeleton loading runtime', searchOut), say('n2', 'Got the source. Now inspecting the phone app code.'), step('b1', 'Ran a command', 'success', 'bash'), step('c1', 'Wrote Skeleton.tsx', 'success', 'write_file', { added: 96, removed: 0 })], running: false, answer: 'The skeleton effect is built and the build passes.' },
];
function useSim() {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (state !== 'sim') return undefined;
    const id = window.setInterval(() => setN((v) => Math.min(v + 1, simFrames.length - 1)), Number(new URLSearchParams(location.search).get('beat') || 1300));
    return () => window.clearInterval(id);
  }, []);
  const f = simFrames[n];
  const work = { kind: 'work' as const, id: 'sw', durationMs: 1300 * (n + 1), running: f.running, items: f.items };
  const items: ThreadItem[] = [turnItems[0], work as ThreadItem, ...(f.answer ? [{ kind: 'answer', id: 'sa', text: f.answer, ts: 3 } as ThreadItem] : [])];
  return { items, work, frame: f };
}

function useTasks() {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (state !== 'tasks') return undefined;
    const id = window.setInterval(() => setN((v) => Math.min(v + 1, 4)), 1600);
    return () => window.clearInterval(id);
  }, []);
  const names = ['Read the build skill', 'Trace the live status path', 'Write the skeleton runtime', 'Run the web tests'];
  return names.map((content, i) => ({ id: 't' + i, content, status: i < n ? 'completed' : i === n ? 'in_progress' : 'pending' })) as any[];
}

/* Two subagents that work, then finish one after the other. */
function useAgents() {
  const [t, setT] = useState(() => Math.max(0, Math.min(9, Number(new URLSearchParams(location.search).get('agentFrame')) || 0)));
  useEffect(() => {
    if (state !== 'agents') return undefined;
    if (new URLSearchParams(location.search).has('manualAgents')) {
      const advance = (event: Event) => setT(Math.max(0, Math.min(9, Number((event as CustomEvent).detail) || 0)));
      window.addEventListener('aside:lab-agent-frame', advance);
      return () => window.removeEventListener('aside:lab-agent-frame', advance);
    }
    const id = window.setInterval(() => setT((v) => Math.min(v + 1, 9)), Number(new URLSearchParams(location.search).get('beat') || 1400));
    return () => window.clearInterval(id);
  }, []);
  const aSteps = ['Searching the web', 'Reading 3 web pages', 'Comparing hearing studies', 'Writing the summary'];
  const bSteps = ['Checking what I remember', 'Searching the web', 'Reading WHO guidance', 'Reading 2 reviews', 'Writing the summary'];
  const child = (id: string, title: string, model: string, provider: string, running: boolean, hue: number) =>
    ({ id, title, status: running ? 'running' : 'idle', toolCallId: 'c' + id, modelLabel: model, provider, running, hue });
  const aRunning = t < 6, bRunning = t < 9;
  const spawnA = { callId: 'ca', description: 'Check hearing and ear risks', prompt: '', hue: 0, child: child('ka', 'Check hearing and ear risks', 'Deepseek v4.1 Flash', 'deepseek', aRunning, 0) };
  const spawnB = { callId: 'cb', description: 'Check other radiation claims', prompt: '', hue: 1, child: child('kb', 'Check other radiation claims', 'Space Bunny', 'openrouter', bRunning, 1) };
  const mk = (pre: string, labels: string[], n: number, running: boolean) => ({ childId: pre, total: n, steps: labels.slice(0, n).map((label, i) => ({ kind: 'step', id: pre + i, label, tool: 'websearch', icon: 'search', status: running && i === n - 1 ? 'pending' : 'success', diffstat: null, detail: null, images: [] })) });
  const subagentSteps = {
    ka: mk('ka', aSteps, Math.min(aSteps.length, t + 1), aRunning),
    kb: mk('kb', bSteps, Math.min(bSteps.length, Math.max(1, t - 1)), bRunning),
  } as Record<string, any>;
  const running = t < 9;
  const items: WorkStep[] = [
    step('g1', 'Read the visualize skill', 'success', 'read_file'),
    { ...step('g2', 'Spawned Check hearing and ear risks', 'success', 'subagent'), subagent: spawnA } as WorkStep,
    { ...step('g3', 'Spawned Check other radiation claims', 'success', 'subagent'), subagent: spawnB } as WorkStep,
    step('g4', 'Waiting for subagents', running ? 'pending' : 'success', 'subagent_wait'),
  ];
  const work = { kind: 'work' as const, id: 'aw', durationMs: 60000, running, items };
  const list: ThreadItem[] = [{ kind: 'user', id: 'au', text: 'Are Bluetooth headphones bad for my health?', ts: 1 }, work as ThreadItem,
    ...(running ? [] : [{ kind: 'answer', id: 'aa', text: 'Loud volume is the clear risk; the radiation evidence is weak.', ts: 2 } as ThreadItem])];
  return { items: list, subagentSteps };
}

// Synthetic ordering regression: every card has later content after it.
const chronologyAgent:WorkStep={...step('chron-agent','Dispatched a subagent','success','subagent'),subagent:{callId:'chron-call',description:'Check the phone layout',prompt:'Review the example layout.',hue:0,child:{id:'chron-child',title:'Phone layout check',status:'idle',toolCallId:'chron-call',modelLabel:'Example model',running:false,createdAt:1000,updatedAt:3000}}};
const chronologyItems:ThreadItem[]=[
 {kind:'user',id:'chron-user',text:'Review the example screen.',ts:1},
 {kind:'work',id:'chron-before',durationMs:4000,running:false,items:[step('chron-read','Read the current screen','success','read_file'),chronologyAgent,step('chron-apply','Apply the layout fix')]},
 {kind:'question',id:'chron-question',source:'tool',variant:'ask',status:'answered',answerable:false,answer:'Phone layout',questions:[{header:'Checks',question:'What should I check?',options:[{label:'Phone layout',description:''}]}]},
 {kind:'error',id:'chron-recovered-error',text:'Temporary request failure',ts:2,alert:{title:'Temporary request failure',description:'Recovered',detail:'',tone:'destructive'}},
 {kind:'work',id:'chron-after',durationMs:2000,running:false,items:[step('chron-verify','Verify the screen after the question')]},
 {kind:'answer',id:'chron-answer',text:'I continued the work after the question.',ts:3},
];

function Lab() {
  const agents = useAgents();
  const tasks = useTasks();
  const sim = useSim();
  const scroller = useRef<HTMLDivElement>(null);
  const streamItems = useStreamSim(state === 'stream');
  const follow = useRef({ pinned: { current: true }, landing: { current: false }, touching: { current: false } }).current;
  const noop = useRef(() => {}).current;
  const ender = useEndFollow(scroller, follow, noop);
  // App.tsx also re-pins on every item change.
  useEffect(() => { if (state === 'stream') ender.kick(); }, [streamItems, ender]);
  const [draft, setDraft] = useState(new URLSearchParams(location.search).get('draft') || '');
  const [labFiles, setLabFiles] = useState<ComposerAttachment[]>(() => state === 'attach' ? labAttachments(new URLSearchParams(location.search).get('files') || 'all') : []);
  const [queue, setQueue] = useState<QueuedMessage[]>(() =>
    state === 'queue'
      ? [
          { id: 'q1', text: 'keep going very carefully, very smartly and strategically.', attachments: [], at: 1 },
          ...(location.search.includes('two')
            ? [{ id: 'q2', text: 'Also check the dark theme once the layout pass is done, and compare it against the reference screenshots.', attachments: ['ref.png'], at: 2 }]
            : []),
        ]
      : [],
  );
  const [, setTick] = useState(0);
  useEffect(() => { setTick(1); }, []);
  const turnState = state === 'stream' || state === 'turn' || state === 'working' || state === 'answering' || state === 'sim' || state === 'agents';
  const items: ThreadItem[] = state === 'stream' ? streamItems : state === 'chronology' ? chronologyItems : state === 'questions' ? [{kind:'user',id:'question-lab-user',text:'Update the interface carefully and check it on a phone.',ts:1},questionFixture(new URLSearchParams(location.search))] : state === 'agents' ? agents.items : state === 'sim' ? sim.items : state === 'turn' ? turnItems : state === 'working' ? workingItems
    : state === 'answering' ? answeringItems : state === 'attach' ? LAB_SENT : state === 'slash' ? [{kind:'user',id:'slash-user',text:'Help me get ready for tomorrow.',ts:1},{kind:'answer',id:'slash-answer',text:'Sure. Type / to pick a skill or command.',ts:2}] : state === 'live' ? base : [...base, errorItem];
  const live = state === 'live';
  return (
    <div className="app app-thread">
      <header className="thread-header" data-condensed="false">
        <div className="thread-header-left">
          <button type="button" className="icon-button" aria-label="Back"><ChevronLeft size={20} strokeWidth={1.75} /></button>
        </div>
        <span className="thread-titles">
          <span className="thread-title">Example task</span>
          {state === 'working' || state === 'sim' || state === 'agents' ? (
            <HeaderActivity activity={{ startedAt: Date.now() - 477000 } as never} onOpen={() => {}} />
          ) : (
            <span className="thread-subtitle">{state==='chronology'?'Timeline':state==='questions'?'Waiting for your answers':'Working · 7m 57s'}</span>
          )}
        </span>
        <div className="thread-header-right">
          <button type="button" className="icon-button" aria-label="Session panel"><MoreVertical size={19} strokeWidth={1.75} /></button>
        </div>
      </header>
      <div className="thread-scroll" ref={scroller}>
        {live ? (
          <div className="live-view is-expanded" data-card-kind="live-view">
            <button type="button" className="live-view-head">
              <span className="live-view-favicon"><Globe size={14} /></span>
              <span className="live-view-titles">
                <span className="live-view-title">Example page | Docs</span>
                <span className="live-view-host">Agent tab · example.com</span>
              </span>
              <LiveBadge mode="live" />
              <ChevronDown className="live-view-chevron" size={16} aria-hidden />
            </button>
            <button type="button" className="live-view-stage" style={{ aspectRatio: '16 / 10' }}>
              <img className="live-view-frame" src="/art/zeron-liquid-dots-v2.webp" alt="" style={{ objectFit: 'cover', objectPosition: '50% 25%' }} />
              <span className="live-view-expand" aria-hidden><Maximize2 size={14} /></span>
            </button>
          </div>
        ) : null}
        <Thread items={withoutResolvedErrors(items, state !== 'error' && state !== 'chronology')} sessionId="lab" sources={{}} subagentSteps={state === 'agents' ? agents.subagentSteps : state==='chronology'?{'chron-child':{childId:'chron-child',steps:[step('chron-child-step','Checked the layout')],total:1,tokens:3200,summary:'Layout checked.'}}:{}} onInspectSubagent={() => {}}
          onOpenCitation={() => {}} onAnswer={() => Promise.resolve()} onRecover={state==='questions'&&!new URLSearchParams(location.search).has('readonly')?()=>Promise.resolve():undefined} busy={state !== 'error' && state !== 'questions' && state !== 'chronology'} scrollElementRef={scroller}
          detachedLiveWorkId={null} turnStartedAt={Date.now() - 64000} />
        {state === 'alert' ? <ErrorCard alert={(errorItem as Extract<ThreadItem, { kind: 'error' }>).alert} /> : null}
        {state === 'alerts' ? (
          <div style={{ display: 'grid', gap: 14 }}>
            {LAB_ALERTS.map((a, i) => (
              <ErrorCard key={i} alert={a} onContinue={i % 2 === 0 || a.title === 'Task was aborted' ? () => toast('Sent Continue', { tone: 'success' }) : undefined} />
            ))}
          </div>
        ) : null}
        {false && state === 'sim' && sim.frame.running ? (
          <LiveWorkTail block={sim.work} activity={{ label: sim.frame.label || '', work: 'tools', startedAt: Date.now() - 4000, tokens: 1200, seed: 'sim' }} subagentSteps={{}} onInspectSubagent={() => {}} />
        ) : null}
        {false && state === 'working' ? (
          <LiveWorkTail block={workingItems[1] as Extract<ThreadItem, { kind: 'work' }>} activity={{ label: 'Searching for "Georgia Tech first-year admissions: essay requirements (Common App personal essay, short answer), out-of-state acceptance rate"', work: 'tools',
            startedAt: Date.now() - 64000, tokens: 777, seed: 'lab' }} subagentSteps={{}} onInspectSubagent={() => {}} />
        ) : null}
        {false && state !== 'error' && !turnState ? (
          <LiveWorkTail block={running} activity={{ label: 'Move old prototype aside', work: 'tools',
            startedAt: Date.now() - 476000, tokens: 13000, seed: 'lab' }} subagentSteps={{}} onInspectSubagent={() => {}} />
        ) : null}
      </div>
      <footer className="thread-footer" data-at-end="true">
        {state === 'tasks' ? <TodoSection todos={tasks} /> : null}
        <QueuedMessages items={queue}
          onSendNow={(q) => setQueue((p) => p.filter((x) => x.id !== q.id))}
          onEdit={(q) => { setQueue((p) => p.filter((x) => x.id !== q.id)); setDraft(q.text); }}
          onRemove={(q) => setQueue((p) => p.filter((x) => x.id !== q.id))} />
        <Composer variant="reply" value={draft} onChange={setDraft}
          onSubmit={() => { if (draft.trim()) setQueue((p) => [...p, { id: 'q' + Date.now(), text: draft.trim(), attachments: [], at: Date.now() }]); setDraft(''); }}
          pills={{ modelLabel: 'Claude Opus 5.5', effortLabel: 'High', effortId: 'high', provider: 'claude-code' }}
          onOpenModel={() => {}} attachments={labFiles} onAddFiles={() => {}} onRemoveAttachment={(k) => setLabFiles((p) => p.filter((a) => a.key !== k))}
          onRetryAttachment={(k) => { setLabFiles((p) => p.map((a) => a.key === k ? { ...a, status: 'uploading', error: undefined, retryable: undefined } : a)); window.setTimeout(() => setLabFiles((p) => p.map((a) => a.key === k ? { ...a, status: 'ready' } : a)), 1500); }}
          streaming={state !== 'error' && state !== 'turn' && state !== 'questions' && state !== 'chronology' && state !== 'slash' && state !== 'attach'} />
      </footer>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<StrictMode><Lab />{state === 'alerts' ? <ToastHost /> : null}{state === 'attach' ? <ImageLightbox /> : null}</StrictMode>);
