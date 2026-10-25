import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { spaceDayLine } from '../src/utils/nextSpace';
import { TaskRow } from '../src/components/NextToday';
import type { NextItem } from '../src/types';

const now = new Date(2026, 0, 5, 14, 0);
const base = (over: Partial<NextItem>): NextItem => ({
  id: 'a', title: 'Sample task', source: 'schoology', space: 'school', context: 'Class', dueISO: new Date(2026, 0, 5, 20).toISOString(),
  estMinutes: 30, lane: 'you', why: '', url: null, steps: [], confidence: 1, score: 1, overdue: false, lateConfirmed: false,
  status: 'open', closedBy: null, closedAt: null, snoozedUntil: null, sessionId: null, kind: 'coursework',
  brief: { mode: 'agent', headline: '', will: [], wont: [], stopsAt: '', trust: 'source', note: null }, trail: null, taint: null, flag: null,
  ...over,
} as NextItem);

describe('Next day line wording', () => {
  it('says "about an hour", never "1 hours", for several tasks', () => {
    const line = spaceDayLine([base({ id: 'a' }), base({ id: 'b' })], 0, now);
    expect(line).toBe('Afternoon. Two things are due today, about an hour in all.');
  });
  it('keeps "of work" for a single task', () => {
    expect(spaceDayLine([base({ estMinutes: 90 })], 0, now)).toBe('Afternoon. One thing is due today, about 1.5 hours of work.');
  });
});

describe('Task row quick choices', () => {
  const noop = () => {};
  it('offers Later and Not for me on a source task', () => {
    const html = renderToStaticMarkup(<TaskRow item={base({})} now={now} onOpen={noop} onDone={noop} onLater={noop} onSkip={noop} />);
    expect(html).toContain('Not for me<');
    expect(html).toContain('Later<');
  });
  it('says Remove for a task he added himself', () => {
    const html = renderToStaticMarkup(<TaskRow item={base({ source: 'manual' })} now={now} onOpen={noop} onDone={noop} onLater={noop} onSkip={noop} />);
    expect(html).toContain('Remove<');
    expect(html).not.toContain('Not for me');
  });
  it('shows no quick choices where triage is not offered', () => {
    const html = renderToStaticMarkup(<TaskRow item={base({})} now={now} onOpen={noop} onDone={noop} onLater={noop} />);
    expect(html).not.toContain('n3-row-triage');
  });
  it('says Skip step for a step of his own project', () => {
    const html = renderToStaticMarkup(<TaskRow item={base({ source: 'project' } as Partial<NextItem>)} now={now} onOpen={noop} onDone={noop} onLater={noop} onSkip={noop} />);
    expect(html).toContain('Skip step<');
    expect(html).not.toContain('Not for me');
  });
});
