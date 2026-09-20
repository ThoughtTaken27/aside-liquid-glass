import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { STEADY_DWELL_MS, useSteadyText } from '../src/hooks/useSteadyText';
import {
  activityHeading,
  activityPhase,
  condense,
  statusText,
  STATUS_WORDS,
  THINKING_WORDS,
  TOOL_WORDS,
  WRITING_WORDS,
} from '../src/utils/activityPhase';
import { StreamFooter } from '../src/components/StreamFooter';
import type { ThreadItem, WorkBlock } from '../src/types';

const user: ThreadItem = { kind: 'user', id: 'u', text: 'Help', ts: 1 };
const work: WorkBlock = {
  kind: 'work', id: 'w', running: true, durationMs: 0,
  items: [{ kind: 'step', id: 's', tool: 'read_file', icon: 'file',
    label: 'Read a file', status: 'pending', detail: null, diffstat: null, images: [] }],
};
afterEach(cleanup);

describe('current-turn activity', () => {
  it('keeps an active turn visible without falsely calling it thinking', () => {
    expect(activityPhase([user], true, false)).toEqual({ phase: 'working', label: 'Working…', work: 'busy', detail: null });
    expect(activityPhase([], true, false)).toEqual({ phase: 'working', label: 'Working…', work: 'busy', detail: null });
  });
  it('works while a tool is in flight, then thinks again', () => {
    expect(activityPhase([user, work], true, false)).toMatchObject({ phase: 'working' });
    const settled = { ...work, items: work.items.map(s => ({ ...s, status: 'success' as const })) };
    expect(activityPhase([user, settled], true, false)).toEqual({ phase: 'working', label: 'Working…', work: 'busy', detail: null });
  });
  it('does not reuse an interrupted tool from a previous turn', () => {
    expect(activityPhase([work, user], true, false)).toEqual({ phase: 'working', label: 'Working…', work: 'busy', detail: null });
    expect(activityPhase([{ ...work, running: false }], true, false)).toEqual({ phase: 'working', label: 'Working…', work: 'busy', detail: null });
  });
  it('does not mistake an accumulated text buffer for active writing', () => {
    expect(activityPhase([user, { kind: 'streaming', id: 's', text: 'Hello' }], true, false)).toEqual({ phase: 'working', label: 'Working…', work: 'busy', detail: null });
  });
  /*
   * The wording varies; the meaning does not.
   *
   * These used to pin one exact string each. The row now draws its
   * phrasing from a small vocabulary per state, seeded on the turn, so
   * asserting `'Thinking…'` would be asserting one arbitrary member of a
   * set. What actually has to hold is that the phrase comes from the
   * RIGHT set -- a thinking state never borrows a writing word -- and
   * that it is stable, which is the property the variation could
   * plausibly have broken.
   */
  it('shows thinking or writing only before a purpose exists', () => {
    const thinking = activityPhase([user], true, false, { phase: 'thinking', tools: [] });
    expect(thinking.phase).toBe('thinking');
    expect(THINKING_WORDS.map((w) => `${w}…`)).toContain(thinking.label);

    const writing = activityPhase([user], true, false, { phase: 'writing', tools: [], summary: null });
    expect(writing.phase).toBe('working');
    expect(WRITING_WORDS.map((w) => `${w}…`)).toContain(writing.label);

    expect(activityPhase([user], true, false, null)).toEqual({ phase: 'working', label: 'Working…', work: 'busy', detail: null });
  });

  it('never reworders itself while one turn is in flight', () => {
    const live = { phase: 'thinking' as const, tools: [] as string[] };
    const first = activityPhase([user], true, false, live).label;
    for (let i = 0; i < 20; i++) {
      expect(activityPhase([user], true, false, live).label).toBe(first);
    }
  });

  it('gives different turns different words to choose from', () => {
    const live = { phase: 'thinking' as const, tools: [] as string[] };
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      seen.add(
        activityPhase(
          [{ ...user, id: `u${i}` }],
          true,
          false,
          live,
        ).label,
      );
    }
    // Not "all of them" -- that would be asserting the hash distribution.
    // More than one is the whole claim: the row is not a fixed string.
    expect(seen.size).toBeGreaterThan(1);
  });
  it('keeps the latest purpose through tool end, thinking, and writing', () => {
    const live = { tools: [] as string[], summary: 'Planning tool status synchronization' };
    expect(activityPhase([user], true, false, { ...live, phase: null }).label).toBe('Planning tool status synchronization…');
    expect(activityPhase([user], true, false, { ...live, phase: 'thinking' }).label).toBe('Planning tool status synchronization…');
    expect(activityPhase([user], true, false, { ...live, phase: 'writing' }).label).toBe('Planning tool status synchronization…');
  });
  it('names the actual tool and handles simultaneous kinds without guessing', () => {
    // One of `read_file`'s phrasings -- it must not reach for another
    // tool's vocabulary, and it must not fall back to "Working…".
    expect(TOOL_WORDS.read_file.map((w) => `${w}…`)).toContain(
      activityPhase([user, work], true, false)?.label,
    );
    const mixed: WorkBlock = { ...work, items: [...work.items, {
      ...work.items[0], kind: 'step', id: 'edit', tool: 'edit_file', icon: 'file',
      label: 'Edit', status: 'pending', detail: null, diffstat: null, images: [],
    }] };
    // The newest human purpose is more informative than enumerating two
    // simultaneous plumbing operations.
    expect(activityPhase([user, mixed], true, false)?.label).toBe('Edit…');
  });
  it('uses the current Aside purpose title instead of a generic tool label', () => {
    const titled: WorkBlock = { ...work, items: [{ ...work.items[0], label: 'Measuring live sync latency' }] };
    expect(activityPhase([user, titled], true, false)?.label)
      .toBe('Measuring live sync latency…');
    expect(activityPhase([user, titled], true, false, { phase: null, tools: ['read_file'] })?.label)
      .toBe('Measuring live sync latency…');
  });
  it('does not dress a generic generated title up as a thought summary', () => {
    const generic: WorkBlock = { ...work, items: [{ ...work.items[0], label: 'Reading a file' }] };
    expect(TOOL_WORDS.read_file.map((w) => `${w}…`)).toContain(
      activityPhase([user, generic], true, false)?.label,
    );
  });
  it('reports connection loss and stop truthfully', () => {
    expect(activityPhase([work], false, false)).toMatchObject({ phase: 'reconnecting' });
    expect(activityPhase([work], true, true)).toMatchObject({ phase: 'stopping' });
    expect(activityPhase([work], false, true)).toMatchObject({ phase: 'stopping' });
  });
});

/*
 * The reported defect: the row printed
 * `Fetched https://www.example.org/2026/08/23/nx-s1-5938103/a-long-article-slug-that-says-nothing-useful-in-a-status-row…`
 * and wrapped to three lines. Almost every character of that is an
 * article slug -- unreadable, and it buried the one part that means
 * something.
 */
describe('condensing a live label', () => {
  it('reduces a URL to its host', () => {
    expect(
      condense(
        'Fetched https://www.example.org/2026/08/23/nx-s1-5938103/a-long-article-slug-that-says-nothing-useful-in-a-status-row',
      ),
    ).toBe('Fetched example.org');
  });

  it('reduces an absolute path to its basename', () => {
    expect(condense('Reading /home/dev/project/miniapp/web/src/App.tsx'))
      .toBe('Reading App.tsx');
  });

  it('caps a long sentence at a word boundary', () => {
    const out = condense(
      'Checking the build workflow and the last release state before drafting notes',
    );
    expect(out.length).toBeLessThanOrEqual(46);
    // Cut between words, not mid-word, and no dangling punctuation.
    expect(out).not.toMatch(/[\s,;:.-]$/);
    expect('Checking the build workflow and the last release state before drafting notes')
      .toContain(out);
  });

  it('leaves a short label exactly as written', () => {
    expect(condense('Reading the changelog')).toBe('Reading the changelog');
  });

  it('keeps the whole label out of the row when it is one huge token', () => {
    const out = condense('x'.repeat(300));
    expect(out.length).toBeLessThanOrEqual(46);
  });
});

describe('the reference activity row', () => {
  it('switches labels in one mounted row', () => {
    const { rerender, container } = render(<StreamFooter phase="thinking" />);
    expect(STATUS_WORDS.thinking[0]).toContain(
      word(screen.getByRole('status').textContent ?? ''),
    );
    rerender(<StreamFooter phase="working" label="Planning tool status synchronization…" />);
    expect(screen.getByRole('status').textContent).toBe('Planning tool status synchronization…');
    expect(container.querySelectorAll('.stream-footer')).toHaveLength(1);
  });
  /*
   * Live work gets one semantic motion mark. The orb changes animation with
   * the work instead of spinning or fragmenting the Aside logo, and the
   * measurement row stays text-only.
   */
  it('signs the row with one work-specific thinking orb', () => {
    const { container } = render(<StreamFooter phase="working" label="Checking sync…" />);
    expect(container.querySelectorAll('.activity-line .activity-mark')).toHaveLength(1);
    expect(container.querySelector('.activity-orb[data-orb-state="searching"]')).toBeTruthy();
    expect(container.querySelector('.activity-meta .activity-mark')).toBeNull();
    expect(container.querySelector('.activity-dot')).toBeNull();
    expect(container.querySelector('.activity-spark')).toBeNull();
    expect(container.querySelector('.activity-clock')).toBeNull();
  });
  it('uses neutral recovery labels', () => {
    const { rerender } = render(<StreamFooter phase="reconnecting" />);
    expect(screen.getByRole('status').textContent).toBe('Reconnecting…');
    rerender(<StreamFooter phase="stopping" />);
    expect(screen.getByRole('status').textContent).toBe('Stopping…');
  });
});

/*
 * The instrumentation row.
 *
 * What it is for: the live row used to be indistinguishable from the
 * settled summaries above it -- same size, same ink -- while a second
 * stage phrase echoed beneath it. These cover the merged heading and the
 * quiet measurements that remain.
 */
/** The word without its ellipsis, for comparison against the lists. */
function word(text: string): string {
  return text.replace(/\u2026$/, '');
}

describe('the active heading', () => {
  it('names concrete work in any mode, and paces a verb when there is none', () => {
    const purpose = 'Research the build regression…';
    // A known action outranks the verb whatever mode the agent is passing
    // through, because the mode is instantaneous and the action is not.
    for (const mode of ['tools', 'thinking', 'writing', 'busy'] as const) {
      expect(activityHeading(mode, purpose, 0, 'turn', purpose)).toBe(purpose);
    }
    // With nothing concrete to name, each mode speaks in its own voice.
    expect(STATUS_WORDS.thinking[0]).toContain(
      word(activityHeading('thinking', purpose, 0, 'turn', null)),
    );
    expect(STATUS_WORDS.writing[0]).toContain(
      word(activityHeading('writing', purpose, 0, 'turn', null)),
    );
  });

  it('holds one register while the mode flips under a held purpose', () => {
    /*
     * The reported flicker, as data: one turn, one summary, and a mode
     * that crosses between reasoning and tool calls several times a
     * second. Every crossing used to swap the row between a paced verb
     * and the summary. All four of these must now read identically.
     */
    const base = { summary: 'Research the build regression' };
    const live = [
      { ...base, phase: 'thinking' as const, tools: [] },
      { ...base, phase: null, tools: ['read_file'] },
      { ...base, phase: 'writing' as const, tools: [] },
      { ...base, phase: null, tools: [] },
    ];
    const headings = new Set(
      live.map(event => {
        const state = activityPhase([user, work], true, false, event);
        return activityHeading(state.work, state.label, 0, 'turn', state.detail);
      }),
    );
    expect(headings).toEqual(new Set(['Research the build regression…']));
  });

  it('still reports the mechanical stage under that one register', () => {
    // Holding the sentence still must not flatten the state behind it --
    // the meta row and the row's own styling both read `work`.
    const base = { summary: 'Research the build regression' };
    expect(activityPhase([user, work], true, false,
      { ...base, phase: 'thinking', tools: [] }).work).toBe('thinking');
    expect(activityPhase([user, work], true, false,
      { ...base, phase: null, tools: ['read_file'] }).work).toBe('tools');
  });

  it('draws from the tier its own clock puts it in', () => {
    const seed = 'turn-1';
    // Exact strings are not asserted anywhere here on purpose: the whole
    // point of the vocabulary is that the wording can be edited without
    // touching a test. What has to hold is that a word can only appear
    // while it is true, which means it must come from its own state and
    // its own tier.
    const cases: Array<[number, 0 | 1 | 2]> = [
      [0, 0],
      [11_400, 0],
      // Rounded, not truncated, so the word turns over on the same tick
      // the clock beside it does. At 11.9s that clock already reads 12s.
      [11_900, 1],
      [12_000, 1],
      [59_000, 1],
      [60_000, 2],
      [600_000, 2],
    ];
    for (const [elapsed, tier] of cases) {
      for (const state of ['thinking', 'tools', 'writing', 'busy'] as const) {
        expect(STATUS_WORDS[state][tier]).toContain(
          word(statusText(state, elapsed, seed)),
        );
      }
    }
  });

  it('holds a word long enough to read it, then moves on', () => {
    // Stable inside its own twelve-second slot: a status line that
    // rewords itself while you are reading it reads as broken.
    const first = statusText('tools', 500, 'turn-a');
    for (const elapsed of [1_000, 5_000, 11_400]) {
      expect(statusText('tools', elapsed, 'turn-a')).toBe(first);
    }
    // And it does move on. The first version had tiers and no rotation,
    // so past sixty seconds the word was chosen once and held for the
    // rest of the turn -- two and a half minutes of `Still cooking...`
    // on a three-minute turn.
    const late = [60, 72, 84, 96, 108].map((s) =>
      statusText('busy', s * 1_000, 'turn-a'),
    );
    expect(new Set(late).size).toBe(late.length);
  });

  it('never repeats the word it just replaced', () => {
    // Reseeding on the slot would collide with the previous pick about
    // one change in five, and a change that changes nothing looks exactly
    // like the row having frozen -- the bug this rotation exists to fix.
    for (const state of ['thinking', 'tools', 'writing', 'busy'] as const) {
      for (const seed of ['a', 'b', 'c']) {
        const run = [0, 12, 24, 36, 48].map((s) =>
          statusText(state, s * 1_000, seed),
        );
        for (let i = 1; i < run.length; i += 1) {
          expect(run[i], `${state}/${seed}`).not.toBe(run[i - 1]);
        }
      }
    }
  });

  it('gives different turns different words', () => {
    const seeds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((seed) =>
      statusText('thinking', 0, seed),
    );
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it('gives the two states that want a fact one word and no ladder', () => {
    for (const ms of [0, 30_000, 600_000]) {
      expect(statusText('stopping', ms, 'x')).toBe('Stopping…');
      expect(statusText('reconnecting', ms, 'x')).toBe('Reconnecting…');
    }
  });

  it('uses compact work verbs instead of strained endurance idioms', () => {
    const vocabulary = Object.values(STATUS_WORDS).flat(2);
    for (const phrase of [
      'Going the distance',
      'Elbows deep',
      'Deep in the weeds',
      'Grinding away',
      'Chipping away at it',
    ]) {
      expect(vocabulary).not.toContain(phrase);
    }
    for (const verb of [
      'Pondering',
      'Percolating',
      'Noodling',
      'Concocting',
      'Tinkering',
      'Synthesizing',
      'Combobulating',
      'Whatchamacalliting',
    ]) {
      expect(vocabulary).toContain(verb);
    }
  });

  it('has a non-empty list for every state and tier', () => {
    for (const [state, tiers] of Object.entries(STATUS_WORDS)) {
      expect(tiers, state).toHaveLength(3);
      for (const tier of tiers) expect(tier.length, state).toBeGreaterThan(0);
    }
  });
});

describe('the activity meta row', () => {
  it('reports the stage even while the sentence names the purpose', () => {
    const held = activityPhase([user, work], true, false, {
      phase: null,
      tools: ['read_file'],
      summary: 'Research the build regression',
    });
    expect(held.label).toBe('Research the build regression…');
    expect(held.work).toBe('tools');
    expect(STATUS_WORDS.tools[0]).toContain(word(statusText(held.work, 0, 's')));
  });

  it('tracks the stage under a held purpose as the turn moves on', () => {
    const base = { summary: 'Research the build regression' };
    expect(activityPhase([user, work], true, false,
      { ...base, phase: 'thinking', tools: [] }).work).toBe('thinking');
    expect(activityPhase([user, work], true, false,
      { ...base, phase: 'writing', tools: [] }).work).toBe('writing');
  });

  it('keeps only the clock and tokens under the live heading', () => {
    const { container } = render(
      <StreamFooter
        phase="working"
        work="tools"
        label="Research the build regression…"
        startedAt={Date.now() - 112_000}
        tokens={1_800}
      />,
    );
    const meta = container.querySelector('.activity-meta');
    expect(meta?.textContent).toContain('1m 52s');
    expect(meta?.textContent).toContain('1.8k tokens');
    expect(meta?.textContent).not.toMatch(/running task|Refining|Thinking/);
    expect(meta?.querySelector('.activity-mark')).toBeNull();
    expect(screen.getByRole('status').textContent)
      .toBe('Research the build regression…');
  });

  it('omits the token counter until there is a reading', () => {
    const { container } = render(
      <StreamFooter phase="working" work="busy" label="Working…" tokens={0} />,
    );
    const meta = container.querySelector('.activity-meta');
    expect(meta?.textContent).toBe('0s');
    expect(meta?.textContent).not.toContain('tokens');
  });

  it('ignores a start time no clock could honestly produce', () => {
    // A far-future stamp from a skewed Mac clock, and a stale one from a
    // transcript a day old. Either would print a nonsense duration.
    for (const startedAt of [Date.now() + 600_000, Date.now() - 90_000_000]) {
      const { container } = render(
        <StreamFooter phase="working" work="tools" label="Working…" startedAt={startedAt} />,
      );
      expect(container.querySelector('.activity-meta-time')?.textContent).toBe('0s');
      cleanup();
    }
  });
});

/**
 * Pacing.
 *
 * The vocabulary above decides WHAT the row says. This decides how often
 * it is allowed to say something new, which is the half of the problem
 * that no amount of better wording fixes: upstream events are legitimate
 * and they arrive faster than anyone can read.
 */
describe('status pacing', () => {
  it('shows the first change at once, then rate-limits the rest', () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ text }) => useSteadyText(text),
        { initialProps: { text: 'Thinking…' } },
      );
      expect(result.current).toBe('Thinking…');

      // Immediate: a dwell that delayed this would leave the row stale at
      // exactly the moment something started, which is a worse bug.
      rerender({ text: 'Reading files…' });
      expect(result.current).toBe('Reading files…');

      // Two more inside the beat. Neither may replace it yet.
      rerender({ text: 'Tinkering…' });
      expect(result.current).toBe('Reading files…');
      rerender({ text: 'Running a command…' });
      expect(result.current).toBe('Reading files…');

      // The newest wins when the beat is up. The skipped phrase is never
      // shown rather than queued, so the row cannot play catch-up through
      // a backlog of words nobody read.
      act(() => { vi.advanceTimersByTime(STEADY_DWELL_MS); });
      expect(result.current).toBe('Running a command…');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a settled heading through without waiting', () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ text, active }) => useSteadyText(text, active),
        { initialProps: { text: 'Working…', active: true } },
      );
      // A finished turn is an answer to "is it done", so pacing it would
      // read as a hang.
      rerender({ text: 'Ran 2 commands', active: false });
      expect(result.current).toBe('Ran 2 commands');
    } finally {
      vi.useRealTimers();
    }
  });
});
