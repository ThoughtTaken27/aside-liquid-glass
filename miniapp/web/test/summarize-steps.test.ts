/**
 * The one line that stands in for a whole run of tool calls.
 *
 * What these pin down is that the sentence stays HONEST as it gets
 * shorter. A summary is only worth the space if it cannot mislead: the
 * order has to be the order things happened, a single step has to name
 * what it touched rather than generalise it away, and a run that lost a
 * step must not read like one that did not.
 */
import { describe, expect, it } from 'vitest';
import { summarizeSteps } from '../src/utils/summarizeSteps';
import type { WorkItem, WorkStep } from '../src/types';

function step(tool: string, label: string, over: Partial<WorkStep> = {}): WorkStep {
  return {
    kind: 'step',
    id: Math.random().toString(36).slice(2),
    icon: 'dot',
    label,
    tool,
    status: 'success',
    diffstat: null,
    detail: null,
    images: [],
    ...over,
  };
}

const text = (items: WorkItem[]) => summarizeSteps(items)?.text;

describe('summarizing a run of steps', () => {
  it('says nothing when nothing happened', () => {
    expect(summarizeSteps([])).toBeNull();
    // Commentary is not work: a turn can talk before it acts.
    expect(
      summarizeSteps([{ kind: 'text', id: 't', text: 'thinking out loud' }]),
    ).toBeNull();
  });

  it('names the target when there was only one step', () => {
    // "Read a file" is both a worse sentence and strictly less informative
    // than the label the server already built.
    const summary = summarizeSteps([step('read_file', 'Read 00-Self.md')])!;
    expect(summary.text).toBe('Read 00-Self.md');
    expect(summary.segments).toEqual([
      { text: 'Read', tone: 'lead' },
      { text: '00-Self.md', tone: 'mono' },
    ]);
  });

  it('does not set a non-filename in a code face', () => {
    const summary = summarizeSteps([step('websearch', 'Searched “tuition”')])!;
    expect(summary.segments[1]).toEqual({ text: '“tuition”', tone: 'muted' });
  });

  it('counts repeats of the same tool into one clause', () => {
    expect(
      text([
        step('read_file', 'Read a.ts'),
        step('read_file', 'Read b.ts'),
        step('read_file', 'Read c.ts'),
      ]),
    ).toBe('Read 3 files');
  });

  it('writes "a file" rather than "1 file"', () => {
    // This is a sentence, not a table.
    expect(
      text([step('read_file', 'Read a.ts'), step('bash', 'Ran build')]),
    ).toBe('Read a file, ran a command');
  });

  it('orders clauses by when each kind of work first happened', () => {
    // Sorting by count would read as a ranking and misdescribe the turn:
    // "ran 3 commands, read a file" when the read came first and caused
    // the rest.
    expect(
      text([
        step('read_file', 'Read a.ts'),
        step('bash', 'Ran one'),
        step('bash', 'Ran two'),
        step('bash', 'Ran three'),
      ]),
    ).toBe('Read a file, ran 3 commands');
  });

  it('keeps reads, writes and edits as separate clauses', () => {
    // The icon collapses these three; the sentence must not. "Wrote 2
    // files" and "read 2 files" are the difference between a turn that
    // changed the machine and one that only looked at it.
    expect(
      text([
        step('read_file', 'Read a.ts'),
        step('edit_file', 'Edited a.ts'),
        step('write_file', 'Wrote b.ts'),
      ]),
    ).toBe('Read a file, edited a file, wrote a file');
  });

  it('reports failures inside the clause they belong to', () => {
    expect(
      text([
        step('read_file', 'Read a.ts'),
        step('read_file', 'Read b.ts', { status: 'error' }),
        step('read_file', 'Read c.ts'),
        step('read_file', 'Read d.ts'),
        step('bash', 'Ran build'),
      ]),
    ).toBe('Read 4 files (1 failed), ran a command');
  });

  it('marks a single failed step without inventing a count', () => {
    const summary = summarizeSteps([
      step('read_file', 'Read gone.ts', { status: 'error' }),
    ])!;
    expect(summary.text).toBe('Read gone.ts (failed)');
    expect(summary.failed).toBe(1);
  });

  it('fills the line, then counts what is left over', () => {
    const summary = summarizeSteps([
      step('read_file', 'Read a.ts'),
      step('bash', 'Ran build'),
      step('websearch', 'Searched “x”'),
      step('write_file', 'Wrote b.ts'),
      step('write_file', 'Wrote c.ts'),
    ])!;
    expect(summary.text).toBe(
      'Read a file, ran a command, searched the web, +2 more',
    );
    expect(summary.count).toBe(5);
  });

  it('keeps a very long turn to one readable line', () => {
    // The case this budget exists for: a real turn came back "Read 27
    // files, searched memory, 110 more steps (3 failed)", which wrapped
    // to three lines and stopped being a summary partway through.
    const many: WorkItem[] = [
      ...Array.from({ length: 27 }, () => step('read_file', 'Read x.ts')),
      ...Array.from({ length: 12 }, () => step('memory_search', 'Searched memory')),
      ...Array.from({ length: 40 }, () => step('bash', 'Ran it')),
      ...Array.from({ length: 20 }, () => step('edit_file', 'Edited y.ts')),
    ];
    const summary = summarizeSteps(many)!;
    expect(summary.text.length).toBeLessThanOrEqual(60);
    expect(summary.count).toBe(99);
    // Nothing is silently lost: the clauses plus the remainder still
    // account for every step.
    expect(summary.text).toContain('+');
  });

  it('uses fixed phrasing where counting reads badly', () => {
    expect(text([step('websearch', 'Searched “x”'), step('bash', 'Ran it')]))
      .toBe('Searched the web, ran a command');
    expect(
      text([step('write_todos', 'Updated the task list'), step('bash', 'Ran it')]),
    ).toBe('Updated the plan, ran a command');
  });

  it('counts unknown tools rather than dropping them', () => {
    // Silently losing steps from the count would make the summary a lie.
    const summary = summarizeSteps([
      step('read_file', 'Read a.ts'),
      step('bash', 'Ran build'),
      step('some_new_tool', 'Did a thing'),
      step('another_new_tool', 'Did another'),
    ])!;
    expect(summary.text).toBe('Read a file, ran a command, +2 more');
    expect(summary.count).toBe(4);
  });

  it('splits the lead verb out for the accent', () => {
    const summary = summarizeSteps([
      step('bash', 'Ran one'),
      step('bash', 'Ran two'),
    ])!;
    expect(summary.segments[0]).toEqual({ text: 'Ran', tone: 'lead' });
    expect(summary.segments[1]).toEqual({ text: '2 commands', tone: 'muted' });
  });

  it('does not repeat a verb two clauses already share', () => {
    // bash and the REPL are both "ran", which produced "Ran 7 commands,
    // ran 2 scripts" -- not how anyone says it, and the repetition reads
    // as a broken sentence rather than as two kinds of work.
    expect(
      text([
        ...Array.from({ length: 7 }, () => step('bash', 'Ran it')),
        step('repl', 'Ran a script'),
        step('repl', 'Ran another'),
      ]),
    ).toBe('Ran 7 commands, 2 scripts');
  });

  it('keeps the verb in front of an article', () => {
    // "Ran a subagent, a command" is grammatical and still reads clipped:
    // a number can carry a clause alone, an article cannot.
    const spawn = step('subagent', 'Spawned a reviewer', {
      subagent: { child: null } as WorkStep['subagent'],
    });
    expect(text([spawn, step('bash', 'Ran it')])).toBe(
      'Ran a subagent, ran a command',
    );
  });

  it('treats a subagent spawn as delegated work', () => {
    const spawn = step('subagent', 'Spawned a reviewer', {
      subagent: { child: null } as WorkStep['subagent'],
    });
    expect(text([spawn, step('bash', 'Ran it')])).toBe(
      'Ran a subagent, ran a command',
    );
  });
});
