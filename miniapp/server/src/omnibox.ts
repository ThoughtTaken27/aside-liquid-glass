/**
 * Ranking for the address bar.
 *
 * The list under a browser's address bar is not sorted by relevance in any
 * single sense. It is a blend of three different claims: "you meant to type
 * a URL", "you have been here before", and "other people who typed this
 * meant this". Chrome's ordering encodes a judgement about which claim wins
 * when they disagree, and this reproduces that judgement rather than
 * inventing one:
 *
 *   1. A typed destination outranks everything. If the text parses as a
 *      URL, the owner already said where they want to go.
 *   2. A strong history match outranks suggestions. Somewhere you visit
 *      often, matched on its hostname, is a near-certain intent; a search
 *      suggestion is a guess about a stranger's intent.
 *   3. Everything else is Google's list, in Google's order. It is better at
 *      that than any local heuristic.
 *
 * The scoring is frecency, the same idea Chrome and Firefox both use:
 * frequency and recency multiplied by how well the text matched, so a site
 * visited fifty times last month loses to one visited twice this morning
 * only when the match quality is comparable.
 *
 * Everything here is pure. The IO lives in `history.ts`, `visits.ts` and
 * `suggest.ts`, which is what makes the ordering testable without a
 * database, a network, or a clock.
 */
import type { HistoryEntry } from './history.js';
import type { Visit } from './visits.js';

export type OmniboxItem =
  /** Navigate straight to a typed destination. */
  | { kind: 'url'; url: string; text: string }
  /** A page from history, on either device. */
  | {
      kind: 'page';
      title: string;
      url: string;
      domain: string;
      lastVisit: number;
      source: 'mac' | 'phone';
    }
  /** Run this as a search. */
  | { kind: 'search'; text: string; source: 'suggest' | 'history' };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * How recent a visit is, as a bonus rather than a sort key.
 *
 * Stepped instead of continuous on purpose: an hour ago and two hours ago
 * are the same thing to a person, and a smooth decay would keep reshuffling
 * a list that should feel stable between keystrokes.
 */
export function recencyBoost(lastVisit: number, now: number): number {
  if (!lastVisit) return 0;
  const age = now - lastVisit;
  if (age < HOUR) return 3;
  if (age < DAY) return 2;
  if (age < 7 * DAY) return 1;
  if (age < 30 * DAY) return 0.5;
  return 0;
}

/**
 * How well the text matched, weighted by where it matched.
 *
 * A hostname prefix is the strongest signal in an address bar: typing "git"
 * and meaning github.com is the single most common thing anyone does with
 * one. A word buried in a page title is the weakest. Returns 0 for no
 * match, which is what filters the list.
 */
export function matchWeight(entry: { url: string; title: string; domain: string }, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const domain = entry.domain.toLowerCase();
  const title = entry.title.toLowerCase();
  const url = entry.url.toLowerCase();

  if (domain.startsWith(q)) return 5;
  // "github.com/anthropics" typed as "github.com/anth".
  if (url.replace(/^https?:\/\/(www\.)?/, '').startsWith(q)) return 4.5;
  if (title.startsWith(q)) return 3;
  if (domain.includes(q)) return 2;
  if (title.includes(q)) return 1.5;
  if (url.includes(q)) return 1;
  return 0;
}

export function frecency(
  entry: { url: string; title: string; domain: string; visitCount: number; lastVisit: number },
  query: string,
  now: number,
): number {
  const weight = matchWeight(entry, query);
  if (weight === 0) return 0;
  // Log so a runaway visit count cannot dominate: the difference between 2
  // and 20 visits matters, between 200 and 2000 it does not.
  const frequency = Math.log2(1 + Math.max(0, entry.visitCount));
  return weight * (frequency + recencyBoost(entry.lastVisit, now));
}

/** A phone visit, shaped like a history row so one scorer covers both. */
function asHistoryShape(v: Visit) {
  return {
    url: v.url,
    title: v.title,
    domain: v.domain,
    visitCount: v.count,
    lastVisit: v.at,
  };
}

export interface OmniboxInput {
  query: string;
  /** Rows from the Mac's Chromium history. */
  history: HistoryEntry[];
  /** Pages and searches recorded on the phone. */
  visits: Visit[];
  /** Live suggestions from Google. */
  suggestions: string[];
  /** A destination, when the typed text was one. */
  directUrl?: string | null;
  /** Injectable clock, so ranking tests are not time-dependent. */
  now?: number;
  limit?: number;
}

/**
 * Blend everything into one ordered list.
 *
 * Deduplication is by url for pages and by lowercased text for searches,
 * which matters most where the two sources overlap: a query typed on the
 * phone yesterday will also come back from Google today, and showing it
 * twice makes the list look broken.
 */
export function buildOmnibox(input: OmniboxInput): OmniboxItem[] {
  const now = input.now ?? Date.now();
  const limit = input.limit ?? 10;
  const query = input.query.trim();
  const out: OmniboxItem[] = [];

  if (input.directUrl) {
    out.push({ kind: 'url', url: input.directUrl, text: query });
  }

  const seenUrls = new Set<string>();
  const seenText = new Set<string>();
  if (query) seenText.add(query.toLowerCase());

  // Pages from both devices, scored together so the better match wins
  // regardless of which machine it came from.
  const pages = [
    ...input.history.map((h) => ({ entry: h, source: 'mac' as const })),
    ...input.visits
      .filter((v) => v.kind === 'page')
      .map((v) => ({ entry: asHistoryShape(v), source: 'phone' as const })),
  ]
    .map((p) => ({ ...p, score: frecency(p.entry, query, now) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);

  const pageItems: OmniboxItem[] = [];
  for (const p of pages) {
    const key = p.entry.url.toLowerCase().replace(/\/$/, '');
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    pageItems.push({
      kind: 'page',
      title: p.entry.title || p.entry.domain,
      url: p.entry.url,
      domain: p.entry.domain,
      lastVisit: p.entry.lastVisit,
      source: p.source,
    });
    if (pageItems.length >= 4) break;
  }

  // Past searches from this device, which Google cannot know about.
  const pastSearches: OmniboxItem[] = [];
  for (const v of input.visits) {
    if (v.kind !== 'search') continue;
    const text = v.title.trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seenText.has(key)) continue;
    if (query && !key.startsWith(query.toLowerCase())) continue;
    seenText.add(key);
    pastSearches.push({ kind: 'search', text, source: 'history' });
    if (pastSearches.length >= 2) break;
  }

  const suggestItems: OmniboxItem[] = [];
  for (const s of input.suggestions) {
    const key = s.trim().toLowerCase();
    if (!key || seenText.has(key)) continue;
    seenText.add(key);
    suggestItems.push({ kind: 'search', text: s.trim(), source: 'suggest' });
  }

  /*
   * The one ordering decision worth stating.
   *
   * A hostname-prefix match on a page visited recently is a near-certain
   * intent, so it is promoted above Google's suggestions. Anything weaker
   * sits below them, because at that point Google's guess about what the
   * words mean beats a local guess about which page they resemble.
   */
  const strong = pageItems.filter(
    (p) =>
      p.kind === 'page' &&
      query.length >= 2 &&
      p.domain.toLowerCase().startsWith(query.toLowerCase()),
  );
  const weak = pageItems.filter((p) => !strong.includes(p));

  out.push(...strong.slice(0, 2));
  out.push(...pastSearches);
  out.push(...suggestItems);
  out.push(...weak);

  return out.slice(0, limit);
}

/**
 * The list shown before a single character is typed.
 *
 * Chrome shows recent and frequent destinations here. Same idea: newest
 * first across both devices, deduplicated, with search entries dropped
 * because a bare list of old queries is noise without a prefix to anchor
 * them.
 */
export function buildZeroState(
  history: HistoryEntry[],
  visits: Visit[],
  limit = 12,
): OmniboxItem[] {
  const merged = [
    ...history.map((h) => ({
      kind: 'page' as const,
      title: h.title || h.domain,
      url: h.url,
      domain: h.domain,
      lastVisit: h.lastVisit,
      source: 'mac' as const,
    })),
    ...visits
      .filter((v) => v.kind === 'page')
      .map((v) => ({
        kind: 'page' as const,
        title: v.title || v.domain,
        url: v.url,
        domain: v.domain,
        lastVisit: v.at,
        source: 'phone' as const,
      })),
  ].sort((a, b) => b.lastVisit - a.lastVisit);

  const seen = new Set<string>();
  const out: OmniboxItem[] = [];
  for (const m of merged) {
    const key = m.url.toLowerCase().replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}
