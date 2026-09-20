import type { ThreadItem, WorkStep } from '../types';

export type ActivityPhase = 'thinking' | 'working' | 'reconnecting' | 'stopping';

/**
 * What the agent is doing, as distinct from what it is doing it TO.
 *
 * `phase` drives the row's visual state and `label` is the sentence --
 * usually the agent's own purpose title, "Research the build
 * regression via aside…". Neither of those tells you the plain mechanical
 * fact underneath: is it reasoning, is a tool out, is it writing.
 *
 * `work` keeps that mechanical mode separate from the authored purpose.
 * The one live heading can therefore show a purpose while tools run and a
 * paced verb while the model reasons or writes, without stacking both.
 */
export type WorkKind =
  | 'thinking'
  | 'tools'
  | 'writing'
  | 'busy'
  | 'reconnecting'
  | 'stopping';

export interface Activity {
  phase: ActivityPhase;
  label: string;
  work: WorkKind;
  /**
   * The concrete thing being done, when one is actually known.

   * Null means we have nothing but a mode, and the row should speak in
   * the paced verb instead. Keeping this separate from `label` is what
   * stops the heading from swapping registers: see `activityHeading`.
   */
  detail: string | null;
}

/**
 * How often the word changes, and when it changes register.
 *
 * The first version had tiers and no rotation, so past sixty seconds the
 * word was chosen once and held for the rest of the turn -- which on a
 * three-minute turn meant staring at `Still cooking...` for two and a
 * half minutes. A status line that never moves stops being evidence of
 * anything.
 *
 * Twelve seconds is the compromise. Long enough to read the word, notice
 * it, and forget about it; short enough that a long turn visibly keeps
 * going. Faster than this and the row is a ticker; slower and it is the
 * bug being fixed.
 *
 * The tier boundaries are multiples of the slot ON PURPOSE. With a
 * fifteen-second first rung the word changed at twelve when the slot
 * turned over, then again at fifteen when the register did -- two changes
 * three seconds apart, which reads as a glitch. Aligned, every change is
 * one change.
 */
const ROTATE_S = 12;
const STILL_AT_IT_S = ROTATE_S;
const A_WHILE_S = ROTATE_S * 5;

/**
 * The status word, by state and by how long it has been going.
 *
 * Three lists per state: opening, still-going, been-a-while. Every rung
 * states a plausible mode of work without pretending to know its result.
 *
 * Prefer compact verbs over strained idioms. `Going the distance`,
 * `elbows deep`, and `deep in the weeds` tried too hard to sound playful
 * and said nothing useful. The vocabulary can have personality, but the
 * default register should still sound like a capable product at work.
 *
 * `stopping` and `reconnecting` get one word forever and no ladder. Those
 * two are the states where a person wants a fact, not a personality.
 */
export const STATUS_WORDS: Record<
  WorkKind,
  readonly [readonly string[], readonly string[], readonly string[]]
> = {
  /*
   * Five or six per rung, deliberately.
   *
   * The word steps one place along its list every twelve seconds, so a
   * list of two means the row flips between the same two phrases for the
   * rest of a long turn, which is barely better than the frozen word it
   * replaced. At five, a rung takes a minute to come back around, and by
   * then the register has usually changed anyway.
   */
  thinking: [
    ['Thinking', 'Pondering', 'Noodling', 'Considering', 'Reasoning'],
    [
      'Synthesizing',
      'Percolating',
      'Connecting the dots',
      'Working it through',
      'Refining the approach',
    ],
    [
      'Taking a closer look',
      'Reviewing the details',
      'Testing the reasoning',
      'Examining the details',
      'Following it through',
    ],
  ],
  tools: [
    ['Checking', 'Tinkering', 'Testing', 'Inspecting', 'Verifying'],
    [
      'Iterating',
      'Troubleshooting',
      'Comparing results',
      'Working through it',
      'Narrowing it down',
    ],
    [
      'Digging deeper',
      'Cross-checking',
      'Validating carefully',
      'Reviewing the output',
      'Running another pass',
    ],
  ],
  writing: [
    ['Drafting', 'Composing', 'Outlining', 'Writing', 'Synthesizing'],
    [
      'Refining',
      'Editing',
      'Structuring',
      'Polishing',
      'Putting it together',
    ],
    [
      'Revising the draft',
      'Tightening the wording',
      'Checking the details',
      'Shaping the answer',
      'Working through the draft',
    ],
  ],
  busy: [
    ['Working', 'Processing', 'Concocting', 'Combobulating', 'Whatchamacalliting'],
    [
      'Making progress',
      'Working through it',
      'Sorting it out',
      'Bringing it together',
      'Percolating',
    ],
    [
      'Continuing',
      'Reviewing the work',
      'Working through the details',
      'Working steadily',
      'Following it through',
    ],
  ],
  stopping: [['Stopping'], ['Stopping'], ['Stopping']],
  reconnecting: [['Reconnecting'], ['Reconnecting'], ['Reconnecting']],
};

/**
 * The rotating verb in the live heading.
 *
 * A fixed `Working on it` adds nothing. These words give reasoning and
 * writing a restrained voice while the separate metric line reports only
 * time and tokens. Tool mode uses its concrete purpose instead.
 *
 * Seeded and paced. The seed gives each turn a stable starting point,
 * while the twelve-second slot advances through the list without random
 * jumps or immediate repeats. A phrase holds long enough to read, then
 * changes often enough to show that a long turn is still alive.
 */
export function statusText(
  work: WorkKind,
  elapsedMs: number,
  seed = '',
): string {
  /* Rounded, not truncated, so the word turns over on the same tick the
     clock beside it does. At 11.9s that clock already reads `12s`, and a
     row saying `12s` next to an opening-tier word is the two halves of
     one line disagreeing about how long they have been waiting. */
  const seconds = Math.round(Math.max(0, elapsedMs) / 1000);
  const tier = seconds >= A_WHILE_S ? 2 : seconds >= STILL_AT_IT_S ? 1 : 0;
  const options = STATUS_WORDS[work][tier];
  return `${pick(
    options,
    `${seed}:${work}:${tier}`,
    Math.floor(seconds / ROTATE_S),
  )}\u2026`;
}

/**
 * The one phrase allowed to describe a live turn.
 *
 * This used to switch on `work`: the authored purpose while a tool was
 * out, a paced verb for everything else. The intent was to stop a stale
 * tool title lingering into a thinking stretch. What it actually produced
 * was a flicker, because `work` is not a phase of a turn -- it is the
 * instantaneous mode, and a working agent crosses between reasoning and
 * tool calls several times a second. Every crossing swapped the row
 * between two different registers, so the line alternated between
 * `Tinkering…` and a real summary faster than it could be read. Reported
 * as "it gives a summary sometimes and flicks back immediately".
 *
 * So the choice is no longer about mode. If we know the concrete thing
 * being done, that is strictly more informative than a verb and it is
 * shown, whichever mode the agent is passing through at this instant.
 * The verb is the fallback for when nothing concrete is known, which is
 * the only case it was ever better than.
 *
 * `detail` therefore holds steady across the same thinking/tools churn
 * that used to drive the swap. `useSteadyText` covers what remains, the
 * genuine changes from one piece of work to the next.
 */
export function activityHeading(
  work: WorkKind,
  label: string,
  elapsedMs: number,
  seed = '',
  detail: string | null = null,
): string {
  if (detail) return detail;
  return work === 'tools' ? label : statusText(work, elapsedMs, seed);
}

const GENERIC_LABEL = /^(?:ran|running|read|reading|wrote|writing|edited|editing|searched|searching|checked|checking|updated|updating|opened|opening|fetched|fetching|worked|working)(?:\s+(?:a|an|the|\d+))?\s+(?:command|commands|script|scripts|file|files|page|pages|web|memory|plan|time)(?:\.{3}|…)?$/i;

/** How much of a sentence this row can hold before it stops being a glance. */
const LABEL_MAX = 46;

/**
 * Cut an authored title down to something a one-line row can hold.
 *
 * The reported case: a step label of `Fetched
 * https://www.example.org/2026/08/23/nx-s1-5938103/a-long-article-slug-that-says-nothing-useful`,
 * which wrapped to three lines and turned a status ticker into a
 * paragraph of slug. A URL is the worst possible thing to print here --
 * almost all of its characters are an id nobody can read, and the one
 * part that means something, the host, is eleven characters in.
 *
 * So: URLs collapse to their host, absolute paths to their basename, and
 * whatever survives is capped at a word boundary. Nothing is invented and
 * nothing is reworded -- the agent's own sentence is kept, just not its
 * machine identifiers.
 */
export function condense(text: string): string {
  let out = text
    .trim()
    // A URL becomes its host, minus the `www.` nobody reads.
    .replace(/https?:\/\/(?:www\.)?([^/\s]+)\S*/gi, '$1')
    // An absolute path becomes its last segment.
    .replace(/(?:^|\s)((?:~|\.{1,2})?\/[^\s]{4,})/g, (_m, path: string) => {
      const parts = path.split('/').filter(Boolean);
      return ` ${parts[parts.length - 1] ?? path}`;
    })
    .replace(/\s+/g, ' ')
    .trim();

  if (out.length <= LABEL_MAX) return out;
  const cut = out.slice(0, LABEL_MAX);
  const space = cut.lastIndexOf(' ');
  // Only break at a word if that leaves most of the budget used; otherwise
  // one very long token would collapse the line to almost nothing.
  out = space > LABEL_MAX * 0.6 ? cut.slice(0, space) : cut;
  return out.replace(/[\s,;:.-]+$/, '');
}

/**
 * Deterministic choice from a list.
 *
 * the user wants this row to feel alive rather than mechanical, and the
 * obvious way to do that -- cycle the wording on a timer -- is the one
 * thing it must not do. A status line that rewords itself while you read
 * it reads as broken, and it destroys the only thing the row is for,
 * which is telling you what is happening right now.
 *
 * The seed is the step's own identity, so a given piece of work picks its
 * phrase once and keeps it for as long as it runs. The variety is real --
 * you see a different word for the next tool, and for the same tool in
 * the next session -- but nothing ever changes under your eyes.
 */
function pick(options: readonly string[], seed: string, step = 0): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  /*
   * `step` walks the list rather than reseeding it.
   *
   * Reseeding on the slot would have been the obvious way to rotate, and
   * it repeats: a hash over a five-item list collides with the previous
   * pick about one time in five, so every fifth change would have been no
   * change at all -- which looks exactly like the row having frozen,
   * which is the thing being fixed. Stepping guarantees a different word
   * every time, and the hash still decides where in the list a given turn
   * starts.
   */
  return options[(Math.abs(hash) + step) % options.length];
}

/**
 * The vocabulary, one entry per tool.
 *
 * Every phrasing in a list has to be true of every call that tool can
 * make -- this is a status line, not a mood ring. That rules out the
 * genuinely funny options: `repl` runs Playwright most of the time but
 * not always, so "Driving the browser" would be a lie on the calls where
 * it is doing arithmetic, and one wrong status is worth more than ten
 * lively ones. What is left is ordinary verbs with some colour in them.
 */
export const TOOL_WORDS: Record<string, readonly string[]> = {
  read_file: ['Reading files', 'Poring over files', 'Skimming files'],
  write_file: ['Writing a file', 'Putting a file together'],
  edit_file: ['Making edits', 'Reworking a file', 'Tweaking a file'],
  websearch: ['Searching the web', 'Scouring the web', 'Combing the web'],
  webfetch: ['Reading a page', 'Pulling up a page', 'Skimming a page'],
  openTab: ['Opening a page', 'Loading a page'],
  memory_search: ['Searching memory', 'Digging through memory', 'Casting back'],
  browsing_history_search: ['Searching history', 'Retracing steps'],
  bash: ['Running a command', 'Working the shell'],
  repl: ['Running a script', 'Working through a script'],
  write_todos: ['Updating the plan', 'Reshuffling the plan'],
  subagent: ['Coordinating agents', 'Dispatching agents', 'Rallying agents'],
  subagent_wait: ['Waiting for agents', 'Hearing back from agents'],
  read_file_metadata: ['Inspecting a file', 'Sizing up a file'],
  get_time: ['Checking the time', 'Checking the clock'],
  routine_update: ['Managing a routine', 'Adjusting a routine'],
  notification: ['Sending a notification'],
};

/** Wording for the two states that have no tool behind them. */
export const THINKING_WORDS = [
  'Thinking',
  'Mulling it over',
  'Turning it over',
  'Chewing on it',
  'Working it out',
] as const;

export const WRITING_WORDS = ['Writing', 'Drafting', 'Putting it together'] as const;

/**
 * Prefer the agent-authored purpose title shown by Aside itself.
 * Generic generated labels fall through to the stable tool vocabulary.
 *
 * The authored title is condensed but never reworded. Our own vocabulary
 * is the only place flavour is added, because it is the only place the
 * words are ours to choose -- rephrasing the agent's sentence to sound
 * livelier would be editing a status report for tone, which is how a
 * status line starts lying.
 */
function purposeLabel(step: Pick<WorkStep, 'tool' | 'label'>): string {
  const title = condense(step.label.trim().replace(/[.…]+$/, ''));
  if (title && !GENERIC_LABEL.test(title)) return `${title}…`;
  return toolLabel(step);
}

/**
 * Stable wording tied to the tool, never random phrases on a timer.
 *
 * Seeded on the tool AND the step's own title where there is one, so two
 * different reads in the same turn can say "Reading files" and "Poring
 * over files" while each of them keeps its word for as long as it runs.
 * Seeding on the tool alone would have been stable and useless: one
 * phrase per tool, forever, which is the same mechanical row with extra
 * code behind it.
 */
function toolLabel(step: Pick<WorkStep, 'tool'> & { label?: string }): string {
  const words = TOOL_WORDS[step.tool];
  // A real pending tool we have no wording for, not a busy fallback.
  if (!words) return 'Working…';
  return `${pick(words, `${step.tool}:${step.label ?? ''}`)}…`;
}

/**
 * Called only while the daemon says this turn is active.
 *
 * Exact live events win. Transcript tools are the cross-device fallback.
 * The remaining active interval is "Working…", never "Thinking…": busy is
 * enough to prove the agent is working, but not enough to claim reasoning.
 */
export function activityPhase(
  items: ThreadItem[], connected: boolean, stopping: boolean,
  live: {
    phase: 'thinking' | 'writing' | null;
    tools: string[];
    summary?: string | null;
  } | null = null,
): Activity {
  // Both states are a fact about the connection, not a description of
  // work, so neither carries a detail for the heading to prefer.
  if (stopping) {
    return {
      phase: 'stopping', label: 'Stopping…', work: 'stopping', detail: null,
    };
  }
  if (!connected) {
    return {
      phase: 'reconnecting',
      label: 'Reconnecting…',
      work: 'reconnecting',
      detail: null,
    };
  }

  /*
   * One seed per turn, for the two states that have no tool to name.
   *
   * `Thinking…` has nothing underneath it to vary on, so without this it
   * is the same word every time forever. The last item's id changes when
   * a turn does and not while one is in flight, which is exactly the
   * behaviour wanted: a different word each time you ask something, and
   * never a word that changes while you are looking at it.
   */
  const turnSeed = items.length ? items[items.length - 1].id : 'idle';

  const pending: WorkStep[] = [];
  let latestPurpose: string | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'user') break;
    if (item.kind === 'work' && item.running) {
      for (let j = item.items.length - 1; j >= 0; j--) {
        const part = item.items[j];
        if (part.kind !== 'step') continue;
        if (part.status === 'pending') pending.push(part);
        const purpose = purposeLabel(part);
        if (!latestPurpose && purpose !== toolLabel(part)) latestPurpose = purpose;
      }
    }
  }

  // Preserve the latest authored purpose as data for the turn. The live
  // heading uses it while tools run; other modes deliberately choose their
  // paced verb in `activityHeading` so a past tool title does not linger.
  const heldPurpose = live?.summary?.trim()
    ? `${condense(live.summary.trim().replace(/[.…]+$/, ''))}…`
    : latestPurpose;
  if (heldPurpose) {
    return {
      phase: live?.phase === 'thinking' ? 'thinking' : 'working',
      label: heldPurpose,
      /* The whole reason this branch exists: an authored purpose survives
         the thinking/tools churn underneath it, so the heading has one
         stable sentence to hold while `work` flips around it. */
      detail: heldPurpose,
      /* Keep purpose and mode separate: the meta row still reports the
         mechanical stage even while the sentence names the purpose. */
      work: live?.phase === 'thinking'
        ? 'thinking'
        : live?.tools.length
          ? 'tools'
          : live?.phase === 'writing'
            ? 'writing'
            : pending.length
              ? 'tools'
              : 'busy',
    };
  }

  // A structured event proves which tools are active.
  if (live) {
    if (live.tools.length) {
      const labels = new Set(live.tools.map(tool => {
        const step = pending.find(candidate => candidate.tool === tool);
        return step ? purposeLabel(step) : toolLabel({ tool });
      }));
      const named = labels.size === 1 ? [...labels][0] : 'Working in parallel…';
      return { phase: 'working', label: named, work: 'tools', detail: named };
    }
    /* Capitalised, like every other label this row can carry. It was the
       one lowercase string among `Working…`, `Writing…`, `Stopping…` and
       the specific purpose labels above. */
    // No concrete action behind either of these, so the paced verb is the
    // honest choice and `detail` stays null to let it through.
    if (live.phase === 'thinking') {
      return {
        phase: 'thinking',
        label: `${pick(THINKING_WORDS, turnSeed)}…`,
        work: 'thinking',
        detail: null,
      };
    }
    if (live.phase === 'writing') {
      return {
        phase: 'working',
        label: `${pick(WRITING_WORDS, turnSeed)}…`,
        work: 'writing',
        detail: null,
      };
    }
    return { phase: 'working', label: 'Working…', work: 'busy', detail: null };
  }

  // Cross-device fallback when the raw event pipe belongs to the desktop.
  if (pending.length) {
    const labels = new Set(pending.map(purposeLabel));
    const named =
      labels.size === 1 ? purposeLabel(pending[0]) : 'Working in parallel…';
    return { phase: 'working', label: named, work: 'tools', detail: named };
  }
  return { phase: 'working', label: 'Working…', work: 'busy', detail: null };
}
