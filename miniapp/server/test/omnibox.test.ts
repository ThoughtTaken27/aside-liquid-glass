/**
 * Address-bar ranking. The rule being tested is not "it sorts correctly"
 * but "it answers like Chrome does": a typed URL beats everything, a
 * frequently-visited site matched on its hostname beats a search
 * suggestion, and a weak match loses to one.
 */
import { describe, expect, it } from 'vitest';
import {
  buildOmnibox,
  buildZeroState,
  frecency,
  matchWeight,
  recencyBoost,
} from '../src/omnibox.js';
import type { HistoryEntry } from '../src/history.js';
import type { Visit } from '../src/visits.js';

const NOW = new Date('2026-08-12T12:00:00Z').getTime();

function page(over: Partial<HistoryEntry>): HistoryEntry {
  return {
    url: 'https://example.com/page',
    title: 'Example',
    domain: 'example.com',
    visitCount: 1,
    lastVisit: NOW,
    ...over,
  };
}

function visit(over: Partial<Visit> & { url: string }): Visit {
  return {
    kind: 'page',
    title: '',
    domain: 'example.com',
    at: NOW,
    count: 1,
    ...over,
  };
}

describe('matchWeight', () => {
  it('scores a domain prefix highest', () => {
    const w = matchWeight(page({ domain: 'github.com' }), 'git');
    expect(w).toBe(5);
  });

  it('scores a full-url prefix just below a domain prefix', () => {
    const w = matchWeight(
      page({ url: 'https://github.com/anthropics/courses', domain: 'github.com' }),
      'github.com/anth',
    );
    expect(w).toBe(4.5);
  });

  it('returns 0 when nothing matches', () => {
    const w = matchWeight(page({ title: 'Recipes' }), 'python');
    expect(w).toBe(0);
  });
});

describe('recencyBoost', () => {
  it('is 3 within an hour', () => {
    expect(recencyBoost(NOW - 30 * 60_000, NOW)).toBe(3);
  });

  it('is 2 within a day', () => {
    expect(recencyBoost(NOW - 2 * 3_600_000, NOW)).toBe(2);
  });

  it('is 0 for anything older than a month', () => {
    expect(recencyBoost(NOW - 60 * 86_400_000, NOW)).toBe(0);
  });

  it('is 0 for a missing timestamp', () => {
    expect(recencyBoost(0, NOW)).toBe(0);
  });
});

describe('frecency', () => {
  it('favour a frequent, recent, well-matched page over a rare old one', () => {
    const good = frecency(
      page({ domain: 'github.com', visitCount: 20, lastVisit: NOW }),
      'git',
      NOW,
    );
    const weak = frecency(
      page({ domain: 'gleam-lang.org', visitCount: 1, lastVisit: NOW - 40 * 86_400_000 }),
      'gleam',
      NOW,
    );
    expect(good).toBeGreaterThan(weak);
  });
});

describe('buildOmnibox', () => {
  it('puts a typed URL first', () => {
    const out = buildOmnibox({
      query: 'github.com',
      directUrl: 'https://github.com',
      history: [],
      visits: [],
      suggestions: ['github.com login'],
      now: NOW,
    });
    expect(out[0]).toEqual({ kind: 'url', url: 'https://github.com', text: 'github.com' });
  });

  it('promotes a strong history match above suggestions', () => {
    const out = buildOmnibox({
      query: 'git',
      history: [page({ domain: 'github.com', url: 'https://github.com', title: 'GitHub' })],
      visits: [],
      suggestions: ['git rebase', 'git stash', 'git commit'],
      now: NOW,
    });
    const firstPage = out.find((o) => o.kind === 'page');
    const firstSuggest = out.find((o) => o.kind === 'search' && o.source === 'suggest');
    expect(firstPage).toBeDefined();
    expect(firstSuggest).toBeDefined();
    // A hostname-prefix match on a visited page outranks the first suggestion.
    expect(out.indexOf(firstPage!)).toBeLessThan(out.indexOf(firstSuggest!));
  });

  it('drops weak history matches below suggestions', () => {
    const out = buildOmnibox({
      query: 'git',
      history: [
        page({
          domain: 'digitmag.com',
          title: 'Digit Magazine',
          url: 'https://digitmag.com/blog',
        }),
      ],
      visits: [],
      suggestions: ['git rebase', 'git stash'],
      now: NOW,
    });
    const firstPage = out.find((o) => o.kind === 'page');
    const firstSuggest = out.find((o) => o.kind === 'search' && o.source === 'suggest');
    expect(firstPage).toBeDefined();
    expect(firstSuggest).toBeDefined();
    // A substring match (domain *contains* but does not start with the query)
    // ranks below Google's suggestions.
    expect(out.indexOf(firstPage!)).toBeGreaterThan(out.indexOf(firstSuggest!));
  });

  it('deduplicates the same page across mac and phone, keeping the better-scoring source', () => {
    const out = buildOmnibox({
      query: 'git',
      history: [page({ domain: 'github.com', url: 'https://github.com', title: 'GitHub', visitCount: 5, lastVisit: NOW })],
      visits: [visit({ kind: 'page', domain: 'github.com', url: 'https://github.com', title: 'GitHub', count: 1, at: NOW })],
      suggestions: [],
      now: NOW,
    });
    const pages = out.filter((o) => o.kind === 'page');
    expect(pages).toHaveLength(1);
  });

  it('deduplicates a past phone search against a live suggestion', () => {
    const out = buildOmnibox({
      query: 'best',
      history: [],
      visits: [
        visit({ kind: 'search', title: 'best laptop', url: 'https://www.google.com/search?q=best+laptop', at: NOW }),
      ],
      suggestions: ['best laptop', 'best phone'],
      now: NOW,
    });
    const searches = out.filter((o) => o.kind === 'search');
    const texts = searches.map((s) => (s as { text: string }).text);
    expect(texts).toContain('best laptop');
    expect(texts.filter((t) => t === 'best laptop')).toHaveLength(1);
    expect(texts).toContain('best phone');
  });
});

describe('buildZeroState', () => {
  it('shows recent pages from both devices, newest first, deduped', () => {
    const out = buildZeroState(
      [page({ domain: 'a.com', url: 'https://a.com', title: 'A', lastVisit: NOW - 10_000 })],
      [visit({ kind: 'page', domain: 'b.com', url: 'https://b.com', title: 'B', at: NOW })],
    );
    expect(out[0]).toMatchObject({ kind: 'page', domain: 'b.com' });
  });
});
