/**
 * Full-text search across transcripts on disk. Day 4 plan 8.7: "grows
 * valuable as history grows." The session LIST already has a client-side
 * filter over titles/previews (`SessionList.tsx`); this is what backs
 * finding something inside a session nobody has open right now.
 *
 * Deliberately simple: a substring scan over each candidate transcript's
 * already-parsed messages, capped to the most recently active N sessions.
 * A real inverted index is not worth building for a single-owner app with
 * a few hundred sessions at most; this is a few dozen milliseconds of
 * `Array.prototype.includes` calls.
 */
import { listSessions, sessionMsgFile } from './sessions.js';
import { readHistory } from './jsonl.js';

export interface SearchHit {
  sessionId: string;
  title: string;
  /** The matching text, trimmed around the hit so it reads like a preview. */
  snippet: string;
  /** Which message in the transcript matched, most recent match per session. */
  ts?: number;
}

/** `content` is `unknown` on the wire -- flatten whatever shape it turns out to be into plain text for matching. */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in (part as Record<string, unknown>)) {
          return String((part as Record<string, unknown>).text || '');
        }
        return '';
      })
      .join(' ');
  }
  return '';
}

function snippetAround(text: string, query: string, radius = 80): string {
  const lower = text.toLowerCase();
  const at = lower.indexOf(query);
  if (at === -1) return text.slice(0, radius * 2).trim();
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + query.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

const DEFAULT_MAX_SESSIONS = 300;
const MAX_RESULTS = 30;

export function searchTranscripts(
  sessionsDir: string,
  rawQuery: string,
  opts: { maxSessions?: number; limit?: number } = {},
): SearchHit[] {
  const query = rawQuery.trim().toLowerCase();
  if (query.length < 2) return [];

  const candidates = listSessions(sessionsDir, opts.maxSessions ?? DEFAULT_MAX_SESSIONS);
  const limit = Math.min(opts.limit ?? MAX_RESULTS, MAX_RESULTS);
  const hits: SearchHit[] = [];

  for (const session of candidates) {
    if (hits.length >= limit) break;
    // The title/preview match is already what SessionList's own client-side
    // filter catches -- searching the transcript body is the incremental
    // value here, so a title-only match without also appearing in the body
    // is left to that existing filter rather than duplicated.
    const msgFile = sessionMsgFile(sessionsDir, session.id);
    if (!msgFile) continue;
    let messages;
    try {
      messages = readHistory(msgFile);
    } catch {
      continue;
    }
    let bestSnippet: string | null = null;
    let bestTs: number | undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = flatten(messages[i].content);
      if (!text || !text.toLowerCase().includes(query)) continue;
      bestSnippet = snippetAround(text, query);
      bestTs = messages[i].timestamp;
      break; // most recent match is the most useful one to show
    }
    if (bestSnippet) {
      hits.push({
        sessionId: session.id,
        title: session.title,
        snippet: bestSnippet,
        ts: bestTs,
      });
    }
  }

  return hits;
}
