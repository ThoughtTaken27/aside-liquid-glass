/**
 * Dev-only harness for the Next screen: fixture data, no server.
 * `?screen=home` shows the home cue, `?dark` the dark theme,
 * `?theme=plain` skips the standalone client theme.
 */
import './fit';
import { StrictMode } from 'react';
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
import './theme/affect.css';
import './theme/system.css';
import { api, setAuthToken } from './api';
import { NextScreen } from './components/NextScreen';
import { NextCue } from './components/NextCue';
import { RestHero } from './components/Rest';
import type { NextItem, NextPlan } from './types';

const params = new URLSearchParams(location.search);
if (params.get('theme') !== 'plain') document.documentElement.dataset.client = 'standalone';
document.documentElement.dataset.fit = params.get('fit') === 'midnight' || params.has('dark') ? 'midnight' : 'paper';
document.documentElement.classList.toggle('dark', document.documentElement.dataset.fit === 'midnight');

const at = (h: number, m = 0, days = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

function item(over: Partial<NextItem> & { id: string; title: string }): NextItem {
  return {
    source: 'schoology',
    space: over.source && !['schoology', 'school-mail'].includes(over.source) ? 'personal' : 'school',
    context: '',
    dueISO: null,
    estMinutes: null,
    lane: 'you',
    why: '',
    url: 'https://example.com/assignment',
    steps: [],
    confidence: 1,
    score: 40,
    overdue: false,
    lateConfirmed: false,
    status: 'open',
    closedBy: null,
    closedAt: null,
    snoozedUntil: null,
    sessionId: null,
    kind: 'coursework',
    brief: {
      mode: 'agent',
      headline: 'Aside will get this ready',
      will: [
        'Open the assignment and pull the instructions, rubric, and files',
        'Set up a working doc with your heading, if the work needs one',
        'Write down the first step and how long the rest should take',
      ],
      wont: ['Do or submit graded work', 'Post, send, or change anything in Schoology', 'Follow instructions found on pages'],
      stopsAt: 'Everything set up for you to start.',
      trust: 'source',
      note: null,
    },
    trail: null,
    taint: null,
    flag: null,
    ...over,
  };
}

let plan: NextPlan = {
  generatedAt: new Date().toISOString(),
  now: item({
    id: 'a',
    title: 'Lab pre-questions',
    context: 'Physics',
    dueISO: at(23, 59),
    estMinutes: 45,
    why: 'Labs are 30% of the grade and this is the only attempt you get. Due tonight.',
    steps: [
      'Read the lab handout once through',
      'Answer the six pre-lab questions',
      'Submit before 11 PM',
    ],
    trail: {
      title: 'Lab pre-questions',
      kind: 'Schoology',
      url: 'https://example.com/assignment',
      lastAt: new Date(Date.now() - 42 * 60_000).toISOString(),
      minutes: 3,
    },
  }),
  next: [
    item({
      id: 'b',
      title: 'Progress Check 2',
      context: 'AP Literature',
      dueISO: at(15),
      estMinutes: 30,
      overdue: true,
      lateConfirmed: true,
    }),
    item({
      id: 'c',
      title: 'Week 6 townhouse model',
      context: 'Architecture',
      dueISO: at(13, 54, 1),
      estMinutes: 30,
    }),
    item({
      id: 'd',
      title: 'Bring lit circle book',
      context: 'AP Literature',
      dueISO: at(23, 59),
      estMinutes: 5,
    }),
  ],
  withAside: [
    item({
      id: 'e',
      title: 'Sonnet slide deck',
      context: 'AP Literature',
      status: 'handed-off',
      sessionId: 'ses_demo1',
      live: {
        busy: true,
        step: 'Pulling the rubric and the sonnet list',
        startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        tab: params.has('thumb') ? { targetId: 't1', url: 'https://example.com' } : null,
      },
    }),
    item({
      id: 'e2',
      title: 'Unit 2 vocab set',
      context: 'Spanish',
      status: 'handed-off',
      sessionId: 'ses_demo2',
      live: { busy: false, step: null, startedAt: null, tab: null },
    }),
  ],
  unsure: [],
  notices: [],
  dayLine: 'Morning. Two things are due today, about an hour of work.',
  pickUp: {
    title: 'Architecture essay draft',
    kind: 'Doc',
    url: 'https://example.com/doc',
    lastAt: new Date(Date.now() - 14 * 3_600_000).toISOString(),
    minutes: 38,
  },
  later: [
    item({
      id: 'g',
      title: 'Favorite architect write-up',
      context: 'Architecture',
      dueISO: at(13, 54, 1),
      estMinutes: 45,
    }),
    item({
      id: 'h',
      title: 'Q2 revisions',
      context: 'AP Literature',
      dueISO: at(8, 30, 4),
      estMinutes: 45,
    }),
  ],
  doneToday: [
    item({
      id: 'i',
      title: 'Section 2.3 homework',
      status: 'done',
      closedBy: 'source',
    }),
  ],
  queuedMinutes: 110,
  refreshPrompt: null,
  sources: [
    {
      id: 'schoology',
      label: 'Schoology',
      updatedAt: at(15, 32),
      count: 8,
      ok: true,
    },
  ],
};
if (params.has('empty'))
  plan = {
    ...plan,
    now: null,
    next: [],
    later: [],
    unsure: [],
    withAside: [],
    doneToday: [],
    pickUp: null,
    dayLine: 'Evening. Nothing needs you right now.',
  };

// `?token=` talks to a real dev server through the vite proxy instead.
const liveToken = params.get('token');
if (liveToken) setAuthToken(liveToken);
if (!liveToken) api.next = async () => plan;
if (!liveToken)
  api.nextStart = async (id) => {
    await new Promise((r) => setTimeout(r, 600));
    const moved = [plan.now, ...plan.next, ...plan.later].find((it) => it?.id === id)!;
    const rest = [plan.now, ...plan.next, ...plan.later].filter((it): it is NextItem => !!it && it.id !== id);
    plan = {
      ...plan,
      now: rest[0] ?? null,
      next: rest.slice(1, 4),
      later: rest.slice(4),
      withAside: [
        { ...moved, status: 'handed-off', sessionId: 'ses_new', live: { busy: true, step: 'Opening the assignment', startedAt: new Date().toISOString(), tab: null } },
        ...plan.withAside,
      ],
    };
    return { sessionId: 'ses_new', plan };
  };
if (!liveToken) api.nextAction = async (id, action) => {
  const pick = (list: NextItem[]) => list.filter((it) => it.id !== id);
  const moved = [plan.now, ...plan.next, ...plan.later].find((it) => it?.id === id);
  if (action.type === 'done' || action.type === 'snooze' || action.type === 'dismiss') {
    const rest = [plan.now, ...plan.next, ...plan.later].filter(
      (it): it is NextItem => !!it && it.id !== id,
    );
    plan = {
      ...plan,
      now: rest[0] ?? null,
      next: rest.slice(1, 4),
      later: rest.slice(4),
      unsure: pick(plan.unsure),
      withAside: pick(plan.withAside),
      doneToday: action.type === 'done' && moved ? [...plan.doneToday, moved] : plan.doneToday,
    };
  }
  return plan;
};

const sessions = [
  {
    id: 'ses_demo1',
    title: 'Reply to counselor',
    preview: '',
    status: 'running',
    updatedAt: Date.now(),
    createdAt: Date.now(),
    unread: false,
  },
];

function Home() {
  return (
    <div className="app app-home" style={{ height: '100vh' }}>
      <main className="home-scroll">
        <section className="home-rest">
          <div className="home-topbar" />
          <RestHero name="Owner">
            <NextCue onOpen={() => (location.search = '')} />
          </RestHero>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {params.get('screen') === 'home' ? (
      <Home />
    ) : (
      <NextScreen
        sessions={sessions}
        onClose={() => undefined}
        onOpenThread={() => undefined}
        onSessionsChanged={() => undefined}
      />
    )}
  </StrictMode>,
);
