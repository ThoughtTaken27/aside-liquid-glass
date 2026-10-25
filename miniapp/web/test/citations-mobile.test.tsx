import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Markdown } from '../src/components/Markdown';
import { dropPartialCitation, transformCitations } from '../src/utils/citations';
import type { CitationSource } from '../src/types';

afterEach(cleanup);
const sources: Record<string, CitationSource> = {
  stanford: { id: 'stanford', url: 'https://hai.stanford.edu/report', title: 'AI Index: economy', domain: 'hai.stanford.edu', excerpt: 'Research summary.' },
  energy: { id: 'energy', url: 'https://iea.org/report', title: 'Energy and AI', domain: 'iea.org', excerpt: '' },
};
const known = (ref: string) => Boolean(sources[ref]);

describe('phone citation regression', () => {
  it.each(['<citation refs="stanford" />', "<citation refs='stanford'/>", '<citation refs=stanford/>', '<CITATION REFS="stanford" / >'])('renders self-closing syntax: %s', (tag) => {
    const result = transformCitations(`Research. ${tag} Next sentence.`, known);
    expect(result.markdown).not.toMatch(/<\/?citation|refs=/i);
    expect(result.markdown).toContain('Next sentence.');
    expect(result.marks[0]?.refs).toEqual(['stanford']);
  });
  it('keeps a complete self-closing citation while streaming', () => {
    const text = 'Research. <citation refs="stanford" />';
    expect(dropPartialCitation(text)).toBe(text);
  });
  it('removes unresolved tags without losing prose', () => {
    expect(transformCitations('Before <citation refs="missing" /> after.', known).markdown).toBe('Before  after.');
  });
  it('deduplicates refs and renders one domain badge per source', () => {
    const open = vi.fn();
    render(<Markdown text={'Research.<citation refs="stanford,energy,stanford" />'} sources={sources} onOpenCitation={open} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Open source: hai.stanford.edu' }).textContent).toBe('hai.stanford.edu');
    fireEvent.click(screen.getByRole('button', { name: 'Open source: iea.org' }));
    expect(open.mock.calls[0][0].refs).toEqual(['energy']);
  });
  it('upgrades when source metadata arrives, never leaking markup', () => {
    const text = '[AI Index](https://hai.stanford.edu/report) <citation refs="stanford" />';
    const view = render(<Markdown text={text} sources={{}} onOpenCitation={() => {}} />);
    expect(view.container.textContent).toBe('AI Index');
    view.rerender(<Markdown text={text} sources={sources} onOpenCitation={() => {}} />);
    expect(screen.getByRole('button', { name: 'Open source: hai.stanford.edu' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'AI Index' }).getAttribute('href')).toBe(sources.stanford.url);
  });
  it('preserves literal citation examples in fenced and inline code', () => {
    const text = '`<citation refs="stanford" />`\n\n```xml\n<citation refs="energy" />\n```\n\nFact.<citation refs="stanford" />';
    const result = transformCitations(text, known);
    expect(result.markdown).toContain('`<citation refs="stanford" />`');
    expect(result.markdown).toContain('```xml\n<citation refs="energy" />\n```');
    expect(result.marks).toHaveLength(1);
  });
  it('preserves paired content and quote details', () => {
    const open = vi.fn();
    render(<Markdown text={'The result is <citation refs="stanford">**descriptive**<quote>Not proof of causation.</quote></citation>.'} sources={sources} onOpenCitation={open} />);
    expect(screen.getByText('descriptive').tagName).toBe('STRONG');
    fireEvent.click(screen.getByRole('button', { name: 'Open source: hai.stanford.edu' }));
    expect(open.mock.calls[0][0].quote).toBe('Not proof of causation.');
  });
});

it('preserves code inside a paired citation body and quote', () => {
  const result = transformCitations('<citation refs="stanford">Use `value`<quote>Set `flag` to true.</quote></citation>', known);
  expect(result.markdown).toBe('Use `value`[¹](cite:1)');
  expect(result.marks[0].quote).toBe('Set `flag` to true.');
});
it('keeps fenced examples and partial tags in code during streaming', () => {
  const text = '~~~xml\n<citation refs="stanford" />\n~~~\n\nFact.<citation refs="energy" />';
  expect(transformCitations(text, known).marks[0].refs).toEqual(['energy']);
  expect(transformCitations(text, known).markdown).toContain('~~~xml\n<citation refs="stanford" />\n~~~');
  expect(dropPartialCitation('```xml\n<citation refs="a')).toBe('```xml\n<citation refs="a');
});
it('does not turn unsafe source URLs into navigation controls', () => {
  const unsafe = { ...sources, bad: { ...sources.energy, id: 'bad', url: 'javascript:alert(1)' } };
  render(<Markdown text={'Claim.<citation refs="bad" />'} sources={unsafe} onOpenCitation={() => {}} />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
});
it('opens a safe source link when no sheet handler is available', () => {
  render(<Markdown text={'Claim.<citation refs="energy" />'} sources={sources} />);
  expect(screen.getByRole('link', { name: 'Open source: iea.org' }).getAttribute('href')).toBe(sources.energy.url);
});
