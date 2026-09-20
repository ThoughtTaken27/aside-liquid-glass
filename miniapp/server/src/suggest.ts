/**
 * Address-bar suggestions: the typeahead half of a browser.
 *
 * A browser's address bar is two sources blended into one list. Chrome
 * ranks what you have already visited against what the search engine
 * thinks you are typing, and the reason it feels instant is that the local
 * half never waits on the network half. That property is preserved here:
 * history is read from a local SQLite file and returned even if Google's
 * suggest endpoint is slow, down, or unreachable.
 *
 * Google's suggest endpoint is public, keyless, and unmetered, which is
 * exactly what every Chromium fork uses. `client=firefox` is the variant
 * that answers with plain JSON (`[query, [suggestions], ...]`) instead of
 * the JSONP the Chrome clients get, so it needs no wrapper stripping.
 *
 * This is proxied through the server rather than called from the phone for
 * one boring reason: the endpoint sends no CORS headers, so a browser
 * cannot read the response. It also means a query typed on the phone
 * leaves from the Mac's IP, which keeps the phone out of Google's logs.
 */

/** Public, keyless, unmetered. The same endpoint Chromium itself uses. */
const SUGGEST_ENDPOINT = 'https://suggestqueries.google.com/complete/search';

/**
 * A suggest call must never be the reason a keystroke feels slow.
 *
 * Typing is ~150ms between characters, so anything past this is already
 * stale: the request is abandoned and the local half of the list is shown
 * on its own rather than holding the UI for a late answer.
 */
const SUGGEST_TIMEOUT_MS = 1_200;

/** Suggestions for a given prefix barely change; a short cache is free. */
const CACHE_TTL_MS = 5 * 60_000;

/** Bounded so a long session cannot grow this without limit. */
const CACHE_MAX = 300;

export interface SuggestOptions {
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface CacheEntry {
  at: number;
  items: string[];
}

/**
 * Google answers `client=firefox` with `[query, [suggestions], [], {...}]`.
 *
 * Parsed defensively rather than trusted: this is an undocumented endpoint,
 * and the correct behaviour when its shape changes is an empty typeahead,
 * not a 500 on every keystroke.
 */
export function parseSuggestResponse(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const list = raw[1];
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text) continue;
    if (out.includes(text)) continue;
    out.push(text);
    if (out.length >= 10) break;
  }
  return out;
}

export class SuggestClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SuggestOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? SUGGEST_TIMEOUT_MS;
    this.cacheTtlMs = opts.cacheTtlMs ?? CACHE_TTL_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Suggestions for a prefix. Resolves to `[]` on any failure.
   *
   * Never throws, and that is deliberate. The caller is a keystroke
   * handler, and there is no useful way for a typeahead to report an
   * error: the honest response to "Google did not answer in time" is the
   * history-only list, which the caller already has.
   */
  async suggest(query: string): Promise<string[]> {
    const q = query.trim();
    if (!q) return [];

    const key = q.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) return hit.items;

    const url =
      `${SUGGEST_ENDPOINT}?client=firefox&hl=en` +
      `&q=${encodeURIComponent(q)}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        signal: ac.signal,
        headers: {
          // Google varies the payload by client. A normal desktop UA is
          // the shape this parser was written against.
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) return [];
      // Served as text/javascript despite being JSON, so `res.json()` is
      // not guaranteed to be willing to parse it.
      const text = await res.text();
      const items = parseSuggestResponse(JSON.parse(text));
      this.remember(key, items);
      return items;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private remember(key: string, items: string[]): void {
    if (this.cache.size >= CACHE_MAX) {
      // Insertion-ordered, so the first key is the oldest.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: Date.now(), items });
  }
}
