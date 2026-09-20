/**
 * A static visual harness. Dev-only: it is not an entry in the production
 * build, and nothing in `src/` imports it.
 *
 * Every screen state that is hard to reach on a live daemon is rendered
 * here at once, on fixture data, so a spacing or colour change can be
 * judged against the whole surface rather than against whichever session
 * happens to be open.
 */
import { StrictMode, useState } from 'react';
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './theme/tokens.css';
import './theme/base.css';
import './theme/components.css';

import type { ThreadItem, WorkStep } from './types';
import { Thread, threadRowClassName } from './components/Thread';
import { RestHero } from './components/Rest';
import { Composer } from './components/Composer';
import { ModeSwitch } from './components/ModeSwitch';
import { LiveWorkTail, WorkFold } from './components/WorkFold';
import { UserBubble } from './components/Thread';
import { StreamFooter } from './components/StreamFooter';
import { Markdown } from './components/Markdown';
import { ChevronLeft, Globe, MoreVertical, StopSquare } from './components/Icons';
import { activityPhase } from './utils/activityPhase';

// The gallery previews the standalone phone/PWA, not the Telegram mini app.
document.documentElement.dataset.client = 'standalone';
document.documentElement.classList.toggle('dark', location.search.includes('dark'));

function step(over: Partial<WorkStep> & { id: string; label: string }): WorkStep {
  return {
    kind: 'step',
    icon: 'dot',
    tool: 'bash',
    status: 'success',
    diffstat: null,
    detail: null,
    images: [],
    ...over,
  } as WorkStep;
}

const runOne: WorkStep[] = [
  step({ id: 's1', label: 'Searched memory', icon: 'search', tool: 'memory_search' }),
  step({ id: 's2', label: 'Checked the time', icon: 'clock', tool: 'get_time' }),
  step({
    id: 's3',
    label: 'Reading the release checklist',
    icon: 'terminal',
    tool: 'bash',
    detail: {
      command: 'sed -n "1,40p" docs/release-checklist.md',
      output:
        '# Release checklist\n\nBlocking\n- flaky socket test\n- bundle size\n\nNice to have\n- dark-mode audit\n- icon cleanup\n',
    },
  }),
];

const runTwo: WorkStep[] = [
  step({ id: 's4', label: 'Read 15 files', icon: 'file', tool: 'read_file' }),
  step({ id: 's5', label: 'Searched memory', icon: 'search', tool: 'memory_search' }),
  step({ id: 's6', label: 'Ran 9 scripts', icon: 'terminal', tool: 'bash', status: 'error' }),
  step({
    id: 's7',
    label: 'Edited planner.ts',
    icon: 'file',
    tool: 'edit_file',
    diffstat: { added: 24, removed: 7 },
    file: {
      mode: 'edit',
      path: 'src/planner.ts',
      name: 'planner.ts',
      truncated: false,
      lines: [
        { n: 12, kind: 'ctx', text: 'export function plan() {' },
        { n: 13, kind: 'del', text: '  return items.slice(0, 3);' },
        { n: 13, kind: 'add', text: '  return rank(items).slice(0, 5);' },
        { n: 14, kind: 'ctx', text: '}' },
      ],
    },
  }),
];

const liveRun: WorkStep[] = [
  step({ id: 's8', label: 'Read the changelog', icon: 'file', tool: 'read_file' }),
  step({ id: 's9', label: 'Checking the status page', icon: 'globe', tool: 'browser', status: 'pending' }),
];

const ANSWER = `The range since Friday has **five commits**, including a Wednesday-morning
dependency bump and three Friday fixes, while CI confirms the socket suite is
**flaky at 18%** and the render suite is **green at 100%**.

### What to do first

1. Pin the dependency bump, then re-run the suite.
2. Clear the three Friday fixes while the context is fresh.
3. Leave the changelog for last.

- **Highest leverage**: the pin, because it is the only change touching the socket.
- **Lowest**: the changelog, which blocks nothing.

\`\`\`ts
const plan = rank(items).slice(0, 5);
\`\`\`
`;

const items: ThreadItem[] = [
  {
    kind: 'user',
    id: 'u1',
    ts: null,
    text:
      'Walk me through what changed in the build since Friday, including the '
      + 'dependency bumps, and tell me whether any of it explains the socket '
      + 'test that has started failing about one run in five. Do not just read '
      + 'the changelog. Check the actual diffs, and say plainly if the answer '
      + 'is that nothing in the range accounts for it.',
  },
  {
    kind: 'work',
    id: 'w1',
    durationMs: 42000,
    running: false,
    items: [
      {
        kind: 'text',
        id: 't1',
        text:
          "I'll check what I know about your application status first, then verify how mid-year and final reports actually work.",
      },
      ...runOne,
    ],
  },
  {
    kind: 'work',
    id: 'w2',
    durationMs: 91000,
    running: false,
    items: runTwo,
  },
  { kind: 'answer', id: 'a1', ts: null, text: ANSWER },
  { kind: 'user', id: 'u2', ts: null, text: 'Great. Now draft the release notes.' },
  {
    kind: 'work',
    id: 'w3',
    durationMs: 4000,
    running: true,
    items: liveRun,
  },
  {
    kind: 'streaming',
    id: 'streaming',
    text: 'The release is on track, with one flaky socket test still worth isolating.',
  },
];

const galleryLiveActivity = {
  label: 'Finding the answer prose block rules…',
  work: 'tools' as const,
  startedAt: Date.now() - 94_000,
  tokens: 11_000,
  seed: 'gallery',
};

function Row({ item, index }: { item: ThreadItem; index: number }) {
  return (
    <div className={threadRowClassName(items, index)}>
      {item.kind === 'user' ? (
        <div className="turn turn-user">
          <UserBubble text={item.text} />
        </div>
      ) : item.kind === 'work' ? (
        <WorkFold
          block={item}
          sessionId="gallery"
          live={item.running}
          detachLiveRun={item.running}
          subagentSteps={{}}
          onInspectSubagent={() => {}}
          sources={{}}
          onOpenCitation={() => {}}
        />
      ) : item.kind === 'answer' || item.kind === 'streaming' ? (
        <div className="turn turn-answer">
          <div className="answer">
            <Markdown text={item.text} sources={{}} sessionId="gallery" onOpenCitation={() => {}} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The state a fresh turn actually opens in: one bubble, and the live row.
 *
 * Reached by `?fresh` -- it is the screen the phone shows for the first
 * few seconds of every question, and the one hardest to catch on a live
 * daemon because it lasts a moment.
 */
function FreshTurn() {
  const one: ThreadItem[] = [items[0]];
  const thinking = location.search.includes('thinking');
  const liveActivity = activityPhase(
    thinking
      ? one
      : [
          one[0],
          {
            kind: 'work',
            id: 'wlive',
            durationMs: 2000,
            running: true,
            items: [
              step({
                id: 'live',
                tool: 'webfetch',
                icon: 'globe',
                status: 'pending',
                label:
                  'Fetched https://www.example.org/2026/08/23/nx-s1-5938103/a-long-article-slug-that-says-nothing-useful-in-a-status-row',
              }),
            ],
          },
        ],
    true,
    false,
    thinking ? { phase: 'thinking', tools: [] } : null,
  );
  return (
    <div className="app" data-at-start="true" data-at-end="true">
      <header className="thread-header">
        <div className="thread-header-left">
          <button type="button" className="icon-button" aria-label="Back">
            <ChevronLeft size={20} strokeWidth={1.75} />
          </button>
        </div>
        <span className="thread-titles">
          <span className="thread-title">Long session title that has to ellipsise…</span>
          <span className="thread-subtitle">GPT-5.6 Luna · Default</span>
        </span>
        <div className="thread-header-right">
          <button type="button" className="icon-button" aria-label="Browser tabs">
            <Globe size={18} strokeWidth={1.75} />
          </button>
          <button type="button" className="icon-button" aria-label="Session panel">
            <MoreVertical size={19} strokeWidth={1.75} />
          </button>
        </div>
      </header>
      <div className="thread-scroll">
        <div className="thread">
          <div className={threadRowClassName(one, 0)}>
            <div className="turn turn-user">
              <UserBubble text="Tell me what changed in the build since Friday" />
            </div>
          </div>
        </div>
        {/*
          Driven through `activityPhase` rather than a hand-written label,
          so this shows what the row ACTUALLY does with the worst input
          it has met: a webfetch step whose title is a full article URL.
        */}
        <StreamFooter {...liveActivity} startedAt={Date.now() - 112_000} tokens={1_800} />
      </div>
      <footer className="thread-footer" data-at-end="true">
        <div className="composer composer-reply">
          <div className="composer-above" />
          <div className="composer-input" role="textbox">
            <span style={{ opacity: 0.45 }}>Queue a message…</span>
          </div>
          <div className="composer-actions">
            <button type="button" className="round-button ghost" aria-label="Add">
              +
            </button>
            <button type="button" className="pill">
              GPT-5.6 Luna
            </button>
            <span style={{ flex: 1 }} />
            <button type="button" className="round-button send stop" aria-label="Stop">
              <StopSquare size={15} />
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

function HomePreview() {
  const [mode, setMode] = useState<'chat' | 'search'>('chat');
  const history = [
    ['Release readiness review', 'Socket suite and dependency changes', '10:42 AM'],
    ['College planner', 'Updated the shortlist and next steps', '8:16 AM'],
    ['Schoology daily plan', 'Prioritized tonight’s assignments', 'Yesterday'],
    ['Zeron mobile polish', 'Reviewed the frost and transcript surfaces', 'Yesterday'],
    ['Application timeline', 'Compared deadlines and recommendation tasks', 'Mon'],
    ['Research notes', 'Captured the sources worth revisiting', 'Sun'],
    ['Essay revision', 'Tightened the opening and evidence', 'Sat'],
    ['Summer planning', 'Mapped the next three concrete steps', 'Fri'],
  ];

  return (
    <div className="app app-home has-history" data-at-start="true" data-home-phase={location.search.includes('history') ? 'history' : 'hero'} data-home-active="true">
      <main className="home-scroll">
        <section className="home-rest">
          <div className="home-topbar">
            <ModeSwitch mode={mode} onChange={setMode} />
            <button type="button" className="icon-button" aria-label="Browser tabs">
              <Globe size={19} strokeWidth={1.75} />
            </button>
          </div>
          <RestHero name="Alex" />
          <button type="button" className="rest-cue">Recent work <span aria-hidden="true">↓</span></button>
        </section>
        <section className="home-history">
          <h2 className="home-history-head">Recent work</h2>
          <div className="session-groups">
            <section className="session-group">
              <h3 className="session-group-head">Today</h3>
              <div className="session-rows" data-separator="inset">
                {history.slice(0, 2).map(([title, preview, time], index) => (
                  <button type="button" className="session-row" style={{ '--i': index } as CSSProperties} key={title}>
                    <span className="session-row-main"><span className="session-row-title">{title}</span><span className="session-row-preview">{preview}</span></span>
                    <span className="session-row-time">{time}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="session-group">
              <h3 className="session-group-head">Earlier</h3>
              <div className="session-rows" data-separator="inset">
                {history.slice(2).map(([title, preview, time], index) => (
                  <button type="button" className="session-row" style={{ '--i': index + 2 } as CSSProperties} key={title}>
                    <span className="session-row-main"><span className="session-row-title">{title}</span><span className="session-row-preview">{preview}</span></span>
                    <span className="session-row-time">{time}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </section>
      </main>
      <footer className="home-dock">
        <Composer
          variant="home"
          value=""
          onChange={() => {}}
          onSubmit={() => {}}
          pills={{ modelLabel: 'GPT-5.6 Luna', effortLabel: 'Default', effortId: '' }}
          onOpenModel={() => {}}
          attachments={[]}
          onAddFiles={() => {}}
          onRemoveAttachment={() => {}}
          mode={mode}
        />
      </footer>
    </div>
  );
}

function Gallery() {
  if (location.search.includes('home')) return <HomePreview />;
  if (location.search.includes('fresh')) return <FreshTurn />;
  return (
    <div className="app" data-at-start="false">
      <header className="thread-header">
        <div className="thread-header-left">
          <button type="button" className="icon-button" aria-label="Back">
            <ChevronLeft size={20} strokeWidth={1.75} />
          </button>
        </div>
        <span className="thread-titles">
          <span className="thread-title">Release readiness review</span>
          <span className="thread-subtitle">GPT-5.6 Luna · Full access</span>
        </span>
        <div className="thread-header-right">
          <button type="button" className="icon-button" aria-label="Browser tabs">
            <Globe size={18} strokeWidth={1.75} />
          </button>
          <button type="button" className="icon-button" aria-label="Session panel">
            <MoreVertical size={19} strokeWidth={1.75} />
          </button>
        </div>
      </header>

      <div className="thread-scroll">
        <div className="thread">
          {items.map((item, index) => (
            <Row key={item.id} item={item} index={index} />
          ))}
        </div>
        <LiveWorkTail
          block={items.find((item) => item.kind === 'work' && item.running) as Extract<ThreadItem, { kind: 'work' }>}
          activity={galleryLiveActivity}
          subagentSteps={{}}
          onInspectSubagent={() => {}}
        />
      </div>

      <footer className="thread-footer">
        <div className="composer composer-reply">
          <div className="composer-above" />
          <div className="composer-input" role="textbox">
            <span style={{ opacity: 0.45 }}>Queue a message…</span>
          </div>
          <div className="composer-actions">
            <button type="button" className="round-button ghost" aria-label="Add">
              +
            </button>
            <button type="button" className="pill">
              GPT-5.6 Luna
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);

// Keep the unused import honest for tsc when the harness is trimmed.
export { Thread };
