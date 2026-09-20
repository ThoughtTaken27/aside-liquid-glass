/**
 * `asUrl` and `googleSearchUrl`: the address bar's first decision.
 *
 * The one property that matters across the server and the client is that
 * they agree, because a different answer in the two places sends the same
 * text to different places depending on who is looking. These mirror the
 * assertions in `openUrl.test` on the web side.
 */
import { describe, expect, it } from 'vitest';
import { asUrl, googleSearchUrl } from '../src/urlguess.js';

describe('asUrl', () => {
  it('recognises a full https url', () => {
    expect(asUrl('https://github.com/anthropics')).toBe('https://github.com/anthropics');
  });

  it('prepends https to a bare host.tld', () => {
    expect(asUrl('reddit.com')).toBe('https://reddit.com');
  });

  it('prepends http to localhost', () => {
    expect(asUrl('localhost:3000')).toBe('http://localhost:3000');
  });

  it('returns null for text with spaces (a search, not a destination)', () => {
    expect(asUrl('node.js streams')).toBeNull();
  });

  it('returns null for a bare word', () => {
    expect(asUrl('github')).toBeNull();
  });

  it('does not treat a sentence-ending dot as a TLD', () => {
    expect(asUrl('best laptop 2026.')).toBeNull();
  });
});

describe('googleSearchUrl', () => {
  it('sets igu=1, which is the whole point', () => {
    const url = googleSearchUrl('test');
    expect(url).toContain('igu=1');
    expect(url).toContain('q=test');
    expect(url).toContain('hl=en');
    expect(url).toContain('gl=us');
  });

  it('preserves spaces as + in the query', () => {
    const url = googleSearchUrl('best laptop');
    expect(url).toMatch(/q=best\+laptop/);
  });

  it('adds a udm for the images vertical', () => {
    expect(googleSearchUrl('cats', { vertical: 'images' })).toContain('udm=2');
  });

  it('adds no udm for the web vertical', () => {
    expect(googleSearchUrl('cats', { vertical: 'web' })).not.toContain('udm=');
  });
});
