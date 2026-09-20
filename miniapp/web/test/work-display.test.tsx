/**
 * How a turn's work is presented.
 *
 * These are the structural decisions from the work-display pass, and each
 * one is here because it was a real defect in a shipped screenshot rather
 * than a preference:
 *
 *  1. The tool detail card repeated the step label it was opened from, so
 *     tapping a row printed the same sentence twice three lines apart.
 *  2. Every card was stamped "Success", spending a pill and a colour to
 *     report that nothing happened.
 *  3. A failed step rendered identically to a successful one, so the only
 *     notice of failure was a `(1 failed)` in the summary -- which is gone
 *     the moment you expand the fold to find out which step it was.
 *  4. The chevron was rendered only on expandable rows, leaving the right
 *     edge of the timeline ragged.
 *
 * Following this project's convention, nothing here asserts CSS: jsdom
 * neither lays out nor composites, so a stylesheet assertion passes just
 * as happily when the effect is broken. Everything below is DOM structure
 * that the styling then hangs off.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

afterEach(cleanup);

import {
  LiveWorkTail,
  WorkFold,
  type LiveActivity,
} from '../src/components/WorkFold';
import { hasLiveRun, liveWorkBlock } from '../src/components/Thread';
import type { ThreadItem, WorkBlock, WorkStep } from '../src/types';

function step(over: Partial<WorkStep> & { id: string; label: string }): WorkStep {
  return {
    kind: 'step',
    icon: 'terminal',
    tool: 'bash',
    status: 'success',
    diffstat: null,
    detail: null,
    images: [],
    ...over,
  } as WorkStep;
}

/*
 * A fresh block id per render, and it is load-bearing rather than tidy.
 *
 * `WorkFold` keeps the reader's open/closed preference in a module-level
 * Map keyed by block id -- deliberately, so a fold survives the thread
 * virtualizer unmounting and remounting its row. That cache also outlives
 * `cleanup()`, so two tests reusing one id share a pin: the second starts
 * open and the first click in it closes the fold instead of opening it.
 */
let nextId = 0;

function block(steps: WorkStep[], running = false): WorkBlock {
  return {
    kind: 'work',
    id: `w${nextId++}`,
    items: steps,
    durationMs: 1000,
    running,
  };
}

function renderFold(
  steps: WorkStep[],
  running = false,
  activity: LiveActivity | null = null,
) {
  return render(
    <WorkFold
      block={block(steps, running)}
      sessionId="s"
      live={running}
      activity={activity}
      subagentSteps={{}}
      onInspectSubagent={() => {}}
      sources={{}}
      onOpenCitation={() => {}}
    />,
  );
}

describe('the work fold', () => {
  /*
   * The mark this used to require is deliberately gone.
   *
   * It named the run's dominant tool and it cost a 20px column that every
   * other line in a turn had to be indented to match -- which is how a
   * left-edge fix turned into a congested reading column on a 393px
   * screen. The reference spends nothing here, and the row still opens
   * with a weighted verb saying what kind of work it was.
   */
  it('carries a verb and one chevron, and no glyph column', () => {
    const { container } = renderFold([
      step({ id: 'a', label: 'Ran a command' }),
      step({ id: 'b', label: 'Read a file', icon: 'file', tool: 'read_file' }),
    ]);
    expect(container.querySelector('.fold-mark')).toBeNull();
    expect(container.querySelector('.fold-seg.is-lead')?.textContent)
      .toBeTruthy();
    // One chevron, rotated by CSS -- not two glyphs swapped on toggle.
    expect(container.querySelectorAll('.fold-row .fold-chevron')).toHaveLength(1);
  });

  it('marks the run open so the rail and chevron can follow it', () => {
    const { container } = renderFold([step({ id: 'a', label: 'Ran a command' })]);
    const row = container.querySelector('.fold-row') as HTMLElement;
    expect(container.querySelector('.fold.is-open')).toBeNull();
    fireEvent.click(row);
    expect(container.querySelector('.fold.is-open')).toBeTruthy();
    expect(container.querySelector('.timeline')).toBeTruthy();
  });

  it('gives every step a chevron slot so the column is straight', () => {
    const { container } = renderFold([
      step({ id: 'a', label: 'Plain step' }),
      step({
        id: 'b',
        label: 'Openable step',
        detail: { command: 'ls', output: 'a\nb' },
      }),
    ]);
    fireEvent.click(container.querySelector('.fold-row') as HTMLElement);

    const rows = container.querySelectorAll('.step-row');
    expect(rows).toHaveLength(2);
    // Both rows carry the slot...
    expect(container.querySelectorAll('.step-row .step-chevron')).toHaveLength(2);
    // ...but only the one that can open draws a glyph in it.
    const slots = container.querySelectorAll('.step-row .step-chevron');
    expect(slots[0].querySelector('svg')).toBeNull();
    expect(slots[1].querySelector('svg')).toBeTruthy();
  });

  it('says on the row itself which step failed', () => {
    const { container } = renderFold([
      step({ id: 'a', label: 'Worked' }),
      step({ id: 'b', label: 'Broke', status: 'error' }),
    ]);
    fireEvent.click(container.querySelector('.fold-row') as HTMLElement);

    const rows = container.querySelectorAll('.step-row');
    expect(rows[0].className).toContain('is-success');
    expect(rows[1].className).toContain('is-error');
  });

  it('names the tool in a detail card rather than repeating the step label', () => {
    const { container, getByText } = renderFold([
      step({
        id: 'a',
        label: 'Reading the release checklist',
        tool: 'bash',
        detail: { command: 'sed -n 1,40p list.md', output: 'first line' },
      }),
    ]);
    fireEvent.click(container.querySelector('.fold-row') as HTMLElement);
    fireEvent.click(container.querySelector('.step-row') as HTMLElement);

    expect(container.querySelector('.tool-card-title')?.textContent).toBe('bash');
    // The label appears once, on the row -- not again as the card's title.
    expect(
      container.querySelectorAll('.tool-card-title, .step-label').length,
    ).toBe(2);
    expect(getByText('Reading the release checklist')).toBeTruthy();
  });

  it('badges a failure and stays silent about success', () => {
    const ok = renderFold([
      step({ id: 'a', label: 'Fine', detail: { command: 'ls', output: 'x' } }),
    ]);
    fireEvent.click(ok.container.querySelector('.fold-row') as HTMLElement);
    fireEvent.click(ok.container.querySelector('.step-row') as HTMLElement);
    expect(ok.container.querySelector('.badge')).toBeNull();

    cleanup();

    const bad = renderFold([
      step({
        id: 'a',
        label: 'Broke',
        status: 'error',
        detail: { command: 'ls', output: 'boom' },
      }),
    ]);
    fireEvent.click(bad.container.querySelector('.fold-row') as HTMLElement);
    fireEvent.click(bad.container.querySelector('.step-row') as HTMLElement);
    const badge = bad.container.querySelector('.badge');
    expect(badge?.textContent).toBe('Failed');
    expect(badge?.className).toContain('is-error');
    expect(bad.container.querySelector('.tool-card.is-error')).toBeTruthy();
  });

  it('marks a running fold so its mark and rail can show it', () => {
    const { container } = renderFold(
      [step({ id: 'a', label: 'Reading the status page', status: 'pending' })],
      true,
    );
    expect(container.querySelector('.fold.is-running')).toBeTruthy();
    expect(container.querySelector('.fold-row.is-running')).toBeTruthy();
  });
});

/*
 * One live row, not three.
 *
 * The reported screen stacked `Ran 4 commands`, then `Finding the answer
 * prose block rules...`, then `1m 34s . 11k tokens . Working on it...` --
 * a tally, a purpose and a clock, all describing the same run in flight.
 * The first two are one fact in two registers and the tally is the weaker
 * of them mid-run, because it counts only what has landed so far.
 *
 * So a run in flight wears the purpose and a settled one wears the tally,
 * and the standalone footer stands down whenever a run is carrying the
 * row itself.
 */
describe('the live row', () => {
  const activity: LiveActivity = {
    label: 'Finding the answer prose block rules…',
    work: 'tools',
    startedAt: Date.now() - 94_000,
    tokens: 11_000,
    seed: 'fixed',
  };

  it('wears the purpose while in flight and the tally once settled', () => {
    const steps = [
      step({ id: 'a', label: 'Ran a command' }),
      step({ id: 'b', label: 'Ran a command' }),
    ];

    const live = renderFold(steps, true, activity);
    expect(live.container.querySelector('.fold-label')?.textContent).toBe(
      'Finding the answer prose block rules…',
    );
    // The tally it replaced must not also be on screen.
    expect(live.container.textContent).not.toMatch(/Ran 2 commands/);
    cleanup();

    const settled = renderFold(steps, false, null);
    expect(settled.container.querySelector('.fold-label')?.textContent)
      .toMatch(/Ran 2 commands/);
  });

  it('hangs exactly one clock off the run, and none when settled', () => {
    const steps = [step({ id: 'c', label: 'Ran a command' })];
    const live = renderFold(steps, true, activity);
    expect(live.container.querySelectorAll('.activity-meta')).toHaveLength(1);
    expect(live.container.querySelector('.activity-meta')?.textContent)
      .toContain('11k tokens');
    // The live mark signs the one heading; the measurement row is quiet.
    expect(
      live.container.querySelectorAll('.fold-row .activity-mark'),
    ).toHaveLength(1);
    expect(live.container.querySelector('.activity-meta .activity-mark'))
      .toBeNull();
    cleanup();

    const settled = renderFold(steps, false, null).container;
    expect(settled.querySelectorAll('.activity-meta')).toHaveLength(0);
    expect(settled.querySelectorAll('.activity-mark')).toHaveLength(0);
  });

  it('keeps the chevron and the steps behind it in both states', () => {
    const steps = [step({ id: 'd', label: 'Ran a command' })];
    for (const running of [true, false]) {
      const view = renderFold(steps, running, running ? activity : null);
      expect(view.container.querySelectorAll('.fold-chevron')).toHaveLength(1);
      fireEvent.click(view.container.querySelector('.fold-row')!);
      expect(view.container.querySelector('.fold')?.className).toContain(
        'is-open',
      );
      cleanup();
    }
  });

  it('returns a settled run to history without losing its open state', () => {
    const liveBlock = block(
      [step({ id: 'stable', label: 'Checking the result' })],
      true,
    );
    const view = render(
      <LiveWorkTail
        block={liveBlock}
        activity={activity}
        subagentSteps={{}}
        onInspectSubagent={() => {}}
      />,
    );
    fireEvent.click(view.container.querySelector('.fold-row')!);
    expect(view.container.querySelector('.fold-row')?.getAttribute('aria-expanded'))
      .toBe('true');

    view.rerender(
      <WorkFold
        block={{ ...liveBlock, running: false }}
        sessionId="s"
        live={false}
        subagentSteps={{}}
        onInspectSubagent={() => {}}
        sources={{}}
        onOpenCitation={() => {}}
      />,
    );
    expect(view.container.querySelector('.fold-row')?.getAttribute('aria-expanded'))
      .toBe('true');
  });

  it('detaches only the active run and mounts it after streamed output', () => {
    const liveBlock = block(
      [step({ id: 'tail', label: 'Checking the result', status: 'pending' })],
      true,
    );
    const { container, getByTestId } = render(
      <>
        <WorkFold
          block={liveBlock}
          sessionId="s"
          live
          detachLiveRun
          subagentSteps={{}}
          onInspectSubagent={() => {}}
          sources={{}}
          onOpenCitation={() => {}}
        />
        <div data-testid="streamed-output">The answer is arriving.</div>
        <LiveWorkTail
          block={liveBlock}
          activity={activity}
          subagentSteps={{}}
          onInspectSubagent={() => {}}
        />
      </>,
    );
    const output = getByTestId('streamed-output');
    const tail = container.querySelector('.is-live-tail');
    expect(container.querySelectorAll('.fold-row')).toHaveLength(1);
    expect(
      output.compareDocumentPosition(tail!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(tail?.querySelector('.activity-meta')?.textContent)
      .toContain('11k tokens');
  });
});

describe('who owns the live row', () => {
  const running = (items: WorkStep[]): ThreadItem => ({
    kind: 'work',
    id: 'w',
    items,
    durationMs: 0,
    running: true,
  });
  const user: ThreadItem = { kind: 'user', id: 'u', text: 'Go', ts: 1 };

  it('gives it to a run that has steps in flight', () => {
    const active = running([step({ id: 'x', label: 'Ran' })]);
    expect(hasLiveRun([user, active])).toBe(true);
    expect(liveWorkBlock([
      user,
      active,
      { kind: 'streaming', id: 'stream', text: 'Answer so far' },
    ])?.id).toBe(active.id);
  });

  it('leaves it to the footer when the running block has no step yet', () => {
    // `WorkFold` renders a `StepRun` only where there are steps, so there
    // would be nothing on screen to carry the row.
    expect(hasLiveRun([user, running([])])).toBe(false);
  });

  it('leaves it to the footer before any work exists', () => {
    expect(hasLiveRun([user])).toBe(false);
    expect(hasLiveRun([])).toBe(false);
  });

  it('does not look past the newest user message', () => {
    const older = running([step({ id: 'y', label: 'Ran' })]);
    expect(hasLiveRun([older, user])).toBe(false);
  });
});
