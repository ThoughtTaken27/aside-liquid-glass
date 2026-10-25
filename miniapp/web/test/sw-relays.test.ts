/**
 * The service worker's relay-aware offline page.
 *
 * Source-level like sw-update.test.ts: the worker's contract with the
 * cached shell is what matters, and a jsdom mock of CacheStorage plus
 * navigation timing would test the mock more than the code.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const sw = readFileSync(path.join(here, '../public/sw.js'), 'utf8');

describe('relay list caching', () => {
  it('scrapes the failover meta tag out of each fresh shell', () => {
    expect(sw).toContain('aside-relays');
    expect(sw).toMatch(/RELAY_LIST_KEY = 'aside-relay-list'/);
    expect(sw).toMatch(/cache\.put\(\s*RELAY_LIST_KEY/);
  });

  it('validates origins before caching or linking them', () => {
    const matches = sw.match(/\/\^https:\\\/\\\/\[A-Za-z0-9\.-\]/g) || [];
    // Once for the scrape, once for the offline page: both ends distrust.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('never lets a failed scrape fail the navigation', () => {
    const start = sw.indexOf('Scrape the failover list');
    const scrape = sw.slice(start, sw.indexOf('return res;', start));
    expect(scrape).toMatch(/try \{/);
    expect(scrape).toMatch(/catch \{/);
  });
});

describe('offline page with a cached relay list', () => {
  it('reads the list and links each backup address', () => {
    expect(sw).toMatch(/caches\.match\(RELAY_LIST_KEY\)/);
    expect(sw).toMatch(/<a href="\$\{o\}\/app">/);
  });

  it('warns that each address pairs separately', () => {
    expect(sw).toContain('Each address pairs');
    expect(sw).toContain('asks for its pairing link first');
  });

  it('keeps the honest no-list page when nothing was cached', () => {
    expect(sw).toContain("Can't reach your Mac");
    expect(sw).toMatch(/let relayLinks = '';/);
  });
});
