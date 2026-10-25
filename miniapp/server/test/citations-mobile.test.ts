import { describe, expect, it } from 'vitest';
import { citedSources } from '../src/threadstore.js';
import { stripMarkdown } from '../src/transcript.js';
import type { ThreadItem } from '../src/thread.js';

const sources = { demo: { id: 'demo', url: 'https://example.com/report', title: 'Report', domain: 'example.com', excerpt: '' } };
describe('mobile citation syntax in server projections', () => {
  it.each(['<citation refs="demo" />', "<citation refs='demo'/>", '<citation refs=demo/>'])('keeps catalog source for %s', (tag) => {
    const items = [{ kind: 'answer', id: 'answer', text: 'Claim. ' + tag }] as unknown as ThreadItem[];
    expect(citedSources(items, sources)).toEqual(sources);
  });
  it.each(['<citation refs="demo" />', "<citation refs='demo'/>", '<citation refs=demo/>', '<CITATION REFS="demo" / >'])('hides citation syntax in preview: %s', (tag) => {
    expect(stripMarkdown('Claim. ' + tag + ' Next.')).toBe('Claim.  Next.');
  });
});
