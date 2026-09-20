/**
 * Citation markup that never closes.
 *
 * Reported on 2026-09-01 with screenshots: paragraphs ending in a literal
 * `<citation refs="NH9pusvrG-6Z9Sct7cSJm">`, several per answer. The cause
 * was that the transform only recognised a COMPLETE `<citation …>…
 * </citation>` pair, and several models -- gpt-5.6 in the thread the
 * screenshots came from -- append the tag AFTER the sentence it supports
 * and never close it. Nothing matched, so the raw markup went straight to
 * the reader.
 *
 * The rule these tests pin is absolute and worth stating plainly: NO
 * citation markup, in any shape, ever reaches the rendered text. A chip
 * when the ref resolves, nothing when it does not, but never a tag.
 */
import { describe, expect, it } from 'vitest';
import { dropPartialCitation, transformCitations } from '../src/utils/citations';

const KNOWN = 'NH9pusvrG-6Z9Sct7cSJm';
const isKnown = (ref: string) => ref === KNOWN;
const never = () => false;

/** The invariant, applied to every case below. */
function expectNoMarkup(text: string): void {
  expect(text).not.toMatch(/<\/?citation/i);
  expect(text).not.toMatch(/<\/?quote/i);
}

describe('unclosed citation tags', () => {
  it('turns a trailing orphaned tag into a chip', () => {
    // Verbatim from the reported thread.
    const { markdown, marks } = transformCitations(
      `Opus 5 with roughly half the token usage in some agent tasks. <citation refs="${KNOWN}">`,
      isKnown,
    );
    expectNoMarkup(markdown);
    expect(markdown).toBe(
      'Opus 5 with roughly half the token usage in some agent tasks. [¹](cite:1)',
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].refs).toEqual([KNOWN]);
  });

  it('drops an orphaned tag whose ref resolves to nothing', () => {
    // Same rule as a complete tag: a chip that opens an empty sheet is
    // worse than plain prose.
    const { markdown, marks } = transformCitations(
      'limits very quickly. <citation refs="vXyejOAaYjOOj8DXZ4dou">',
      never,
    );
    expectNoMarkup(markdown);
    expect(markdown.trim()).toBe('limits very quickly.');
    expect(marks).toHaveLength(0);
  });

  it('deletes a closing tag that has nothing to close', () => {
    const { markdown } = transformCitations('orphan closer </citation> gone.', isKnown);
    expectNoMarkup(markdown);
    expect(markdown).toBe('orphan closer  gone.');
  });

  it('puts an orphaned tag’s quote in the sheet, not the paragraph', () => {
    const { markdown, marks } = transformCitations(
      `It burns credits. <citation refs="${KNOWN}"><quote>separate pay-as-you-go credits</quote>`,
      isKnown,
    );
    expectNoMarkup(markdown);
    expect(markdown).toBe('It burns credits. [¹](cite:1)');
    expect(marks[0].quote).toBe('separate pay-as-you-go credits');
  });

  it('numbers mixed complete and orphaned tags in reading order', () => {
    // A single pass over the string, not one pass per shape -- otherwise
    // the second chip on screen could carry the first chip's number.
    const { markdown, marks } = transformCitations(
      `First <citation refs="${KNOWN}">wrapped</citation> then second. <citation refs="${KNOWN}"> then third. <citation refs="${KNOWN}">`,
      isKnown,
    );
    expectNoMarkup(markdown);
    expect(markdown).toContain('First wrapped[¹](cite:1)');
    expect(markdown).toContain('[²](cite:2)');
    expect(markdown).toContain('[³](cite:3)');
    expect(marks.map((m) => m.index)).toEqual([1, 2, 3]);
  });

  it('accepts single-quoted and bare refs', () => {
    // Model output, not a validated document format.
    for (const tag of [
      `<citation refs='${KNOWN}'>`,
      `<citation refs=${KNOWN}>`,
      `<CITATION REFS="${KNOWN}">`,
    ]) {
      const { markdown, marks } = transformCitations(`Text. ${tag}`, isKnown);
      expectNoMarkup(markdown);
      expect(marks, tag).toHaveLength(1);
    }
  });

  it('leaves a complete pair working exactly as before', () => {
    const { markdown, marks } = transformCitations(
      `A <citation refs="${KNOWN}">supporting line<quote>the source said</quote></citation> B`,
      isKnown,
    );
    expect(markdown).toBe('A supporting line[¹](cite:1) B');
    expect(marks[0].quote).toBe('the source said');
  });

  it('survives a whole reported answer without leaking markup', () => {
    const answer = [
      '- **The biggest complaint is the pricing model.** Reddit users describe Pro access as',
      '  feeling like an upsell to Max or extra credits. <citation refs="vXyejOAaYjOOj8DXZ4dou">',
      '- Every found it exceeding word, theme, and quote limits. In one test, 5 of 27 quoted',
      `  passages were not actually in the source. <citation refs="${KNOWN}">`,
      '- Some Hacker News and Reddit users still report dense prose. <citation refs="CAxg1SnL8NXL3V398KIfs">',
    ].join('\n');
    const { markdown } = transformCitations(answer, isKnown);
    expectNoMarkup(markdown);
  });
});

describe('dropPartialCitation', () => {
  it('hides a tag that is still arriving', () => {
    expect(dropPartialCitation('Text. <cit')).toBe('Text. ');
    expect(dropPartialCitation('Text. <citation refs="a')).toBe('Text. ');
    expect(dropPartialCitation('Text. </cit')).toBe('Text. ');
  });

  it('leaves ordinary text with an angle bracket alone', () => {
    expect(dropPartialCitation('a < b and c')).toBe('a < b and c');
  });
});
