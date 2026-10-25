import { readOwnerProfile } from './owner-profile.js';
/**
 * Read-only bridge to Aside's own Context Awareness (Oct 21, 2026).
 *
 * Aside records Owner's activity in ~/.aside/u/0/context-awareness/ledger.db and
 * writes 10-minute and 6-hour summaries. This module reads only what Next and
 * Jarvis need, on demand, and never stores a copy:
 *  - event metadata (time, app, window title, URL host). Never the content blobs.
 *  - completed summaries (title, description, body).
 *  - older summaries via `aside memory search --json` (Aside's own index).
 *
 * Rules that hold everywhere in this file:
 *  - No model call and no network. Callers decide where text may go.
 *  - Off when Aside's Context Awareness is off or paused.
 *  - Aside's denylist is applied again here, so a rule added today also hides
 *    what was captured before it existed.
 *  - Private hosts Aside still observes (Gmail, Google Messages, account pages)
 *    are dropped here, along with anything privateText() flags.
 *  - Everything returned is data about the screen, never instructions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { privateText } from './guards.js';

const require = createRequire(import.meta.url);

/** Hosts under domains Aside keeps observing (google.com) that must never surface. */
export const PRIVATE_HOSTS = [
  'mail.google.com', 'messages.google.com', 'accounts.google.com', 'myaccount.google.com', 'passwords.google.com',
  'pay.google.com', 'payments.google.com', 'voice.google.com', 'contacts.google.com', 'photos.google.com',
  'takeout.google.com', 'one.google.com',
];
const PRIVATE_APPS = new Set(['com.apple.mail', 'com.apple.MobileSMS', 'com.apple.Passwords', 'com.apple.keychainaccess', 'com.apple.SecurityAgent',
  'net.whatsapp.WhatsApp', 'ru.keepcoder.Telegram', 'org.whispersystems.signal-desktop', 'com.hnc.Discord', 'com.facebook.archon', 'com.apple.FaceTime']);
/** Words in a summary that point at mail, texts or credentials. Such a summary is only counted, never shown. */
const PRIVATE_WORDS = /\b(gmail|inbox|e-?mail(s|ed)?|text(ed)? messages?|texted|google messages|sms|imessage|whatsapp|telegram|signal app|messenger|direct messages?|dms?|messaged|chatted|discord dms?|verification code|one-time code|otp|2fa|password|passcode|bank|visa|uscis|i-?94|passport|ssn|social security)\b/i;

const CALL_APPS = new Set(['us.zoom.xos', 'com.microsoft.teams2', 'com.microsoft.teams', 'com.cisco.webexmeetingsapp', 'com.apple.FaceTime', 'com.hnc.Discord']);
const CALL_HOSTS = ['meet.google.com', 'zoom.us', 'teams.microsoft.com', 'teams.live.com', 'whereby.com'];
const VIDEO_HOSTS = ['youtube.com', 'netflix.com', 'disneyplus.com', 'hulu.com', 'primevideo.com', 'twitch.tv', 'max.com', 'crunchyroll.com'];

const MIN = 60_000;
const DAY = 86_400_000;

export interface CtxRule { scope: 'app' | 'url'; behavior: string; bundleId?: string; urlDomain?: string }
export interface CtxSettings { enabled: boolean; pausedUntil: number | null; rules: CtxRule[] }

export interface CtxEvent { at: number; app: string; bundle: string; title: string; host: string; kind: string }
export interface CtxSummary { kind: string; from: number; to: number; title: string; description: string; body: string }

export interface Situation {
  off: boolean;
  /** What is in front, as of the last captured event. */
  app: string | null;
  title: string | null;
  host: string | null;
  /** Seconds the same app (and site) has been in front. */
  dwellSec: number;
  /** Seconds since Aside last saw any activity. */
  quietSec: number;
  typing: boolean;
  inCall: boolean;
  watching: boolean;
}

export interface Pack {
  off: boolean;
  /** Short, labelled lines for a model to answer from. Empty when nothing relevant was found. */
  facts: string;
  sources: string[];
  /** Relevant windows left out because they looked private. */
  hidden: number;
}

export interface MemoryHit { path: string; title: string; excerpt: string; date?: string; score?: number }
export type MemorySearch = (q: string, n: number) => Promise<MemoryHit[]>;

export interface DoneSignalLike { kind: 'done'; subject: string; host: string; at: string; p: number }

export interface AsideContextOptions {
  /** ~/.aside/u/0 */
  asideRoot: string;
  now?: () => number;
  memorySearch?: MemorySearch | null;
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

const under = (host: string, domain: string) => host === domain || host.endsWith('.' + domain);

export function isPrivateHost(host: string): boolean {
  return !!host && PRIVATE_HOSTS.some((h) => under(host, h));
}

/** Strips private-looking titles down to nothing; clips the rest. */
export function safeText(s: string | null | undefined, max = 160): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  if (!t || privateText(t) || PRIVATE_WORDS.test(t)) return '';
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Keeps only the sentences with nothing private in them. */
export function cleanSentences(s: string, max = 260): string {
  const kept = (s ?? '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter((x) => x && !privateText(x) && !PRIVATE_WORDS.test(x));
  const t = kept.join(' ');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function readCtxSettings(asideRoot: string): CtxSettings {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(asideRoot, 'settings.json'), 'utf8')) as { contextAwareness?: Partial<CtxSettings> };
    const c = s.contextAwareness ?? {};
    return { enabled: c.enabled === true, pausedUntil: typeof c.pausedUntil === 'number' ? c.pausedUntil : null, rules: Array.isArray(c.rules) ? c.rules as CtxRule[] : [] };
  } catch {
    return { enabled: false, pausedUntil: null, rules: [] };
  }
}

/** Default memory search: Aside's own CLI, read-only, about 0.9 s. Only context-awareness pages are kept. */
export function cliMemorySearch(bin = path.join(process.env.HOME ?? '', '.local/bin/aside'), timeoutMs = 2500): MemorySearch {
  return (q, n) => new Promise((resolve) => {
    if (!fs.existsSync(bin)) return resolve([]);
    execFile(bin, ['memory', 'search', '--json', '-n', String(Math.min(10, Math.max(1, n))), q], { timeout: timeoutMs, maxBuffer: 2_000_000 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const rows = JSON.parse(stdout) as MemoryHit[];
        resolve(Array.isArray(rows) ? rows : []);
      } catch { resolve([]); }
    });
  });
}

const STOP = new Set('the a an and or of to in on at for with from by is was were be been i me my you your it this that what where when how did do does have has had about any some just'.split(' '));
export function words(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
}

export class AsideContext {
  private db: DatabaseSync | null = null;
  private dbFile: string;
  private now: () => number;
  private search: MemorySearch | null;
  private doneCache: { at: number; v: DoneSignalLike[] } | null = null;

  constructor(private readonly o: AsideContextOptions) {
    this.dbFile = path.join(o.asideRoot, 'context-awareness', 'ledger.db');
    this.now = o.now ?? Date.now;
    this.search = o.memorySearch === undefined ? cliMemorySearch() : o.memorySearch;
  }

  settings(): CtxSettings { return readCtxSettings(this.o.asideRoot); }

  /** Off when Aside's Context Awareness is off or paused. */
  isOff(): boolean {
    const s = this.settings();
    return !readOwnerProfile().privacyConfigured || !s.enabled || (s.pausedUntil !== null && s.pausedUntil > this.now());
  }

  private open(): DatabaseSync | null {
    if (this.db) return this.db;
    if (!fs.existsSync(this.dbFile)) return null;
    try {
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
      this.db = new DatabaseSync(this.dbFile, { readOnly: true });
      this.db.exec('PRAGMA busy_timeout = 500;');
      return this.db;
    } catch { this.db = null; return null; }
  }

  private query<T>(sql: string, ...args: Array<string | number>): T[] {
    const db = this.open();
    if (!db) return [];
    try { return db.prepare(sql).all(...args) as T[]; }
    catch { try { db.close(); } catch { /* ignore */ } this.db = null; return []; }
  }

  close(): void { try { this.db?.close(); } catch { /* ignore */ } this.db = null; }

  /** True when this app/host may surface: not denylisted (now), not private. */
  private visible(bundle: string, host: string, rules: CtxRule[]): boolean {
    const profile = readOwnerProfile();
    if (!profile.privacyConfigured || PRIVATE_APPS.has(bundle) || profile.privateAppIds.includes(bundle) || isPrivateHost(host)) return false;
    for (const r of rules) {
      if (r.behavior !== 'do_not_observe') continue;
      if (r.scope === 'app' && r.bundleId && r.bundleId === bundle) return false;
      if (r.scope === 'url' && r.urlDomain && host && under(host, r.urlDomain.toLowerCase().replace(/^www\./, ''))) return false;
    }
    return true;
  }

  /** Recent event metadata, newest first, with hidden apps/hosts removed. */
  events(sinceMs: number, limit = 400): CtxEvent[] {
    if (this.isOff()) return [];
    const rules = this.settings().rules;
    const rows = this.query<{ at: number; app: string; bundle: string; title: string; url: string | null; kind: string }>(
      `SELECT occurred_at AS at, app_name AS app, bundle_id AS bundle, window_title AS title, url, kind
         FROM context_awareness_events WHERE occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?`, sinceMs, limit);
    const out: CtxEvent[] = [];
    for (const r of rows) {
      const host = hostOf(r.url);
      if (!this.visible(r.bundle, host, rules)) continue;
      out.push({ at: r.at, app: r.app || r.bundle, bundle: r.bundle, title: safeText(r.title, 120), host, kind: r.kind });
    }
    return out;
  }

  /** Completed summaries overlapping the window, newest first. Private ones are counted, not returned. */
  summaries(sinceMs: number, limit = 40): { list: CtxSummary[]; hidden: number } {
    if (this.isOff()) return { list: [], hidden: 0 };
    const rules = this.settings().rules;
    const rows = this.query<{ kind: string; from: number; to: number; title: string; description: string; body: string | null; citations: string }>(
      `SELECT kind, window_from AS "from", window_to AS "to", title, description, body, citations
         FROM context_awareness_summaries WHERE status = 'completed' AND window_to >= ? ORDER BY window_from DESC LIMIT ?`, sinceMs, limit);
    const list: CtxSummary[] = [];
    let hidden = 0;
    for (const r of rows) {
      if (this.summaryPrivate(r.citations, `${r.title}\n${r.description}\n${r.body ?? ''}`, rules)) { hidden++; continue; }
      list.push({ kind: r.kind, from: r.from, to: r.to, title: r.title, description: r.description, body: r.body ?? '' });
    }
    return { list, hidden };
  }

  private summaryPrivate(citations: string, text: string, rules: CtxRule[]): boolean {
    if (privateText(text)) return true;
    try {
      const cites = JSON.parse(citations) as Array<{ type?: string; id?: string; url?: string; href?: string }>;
      for (const c of Array.isArray(cites) ? cites : []) {
        const u = c.url ?? c.href;
        if (u && !this.visible('', hostOf(u), rules)) return true;
      }
      const ids = (Array.isArray(cites) ? cites : []).filter((c) => c.type === 'event' && typeof c.id === 'string').map((c) => c.id as string).slice(0, 60);
      if (ids.length) {
        const rows = this.query<{ bundle: string; url: string | null }>(
          `SELECT bundle_id AS bundle, url FROM context_awareness_events WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
        if (rows.some((r) => !this.visible(r.bundle, hostOf(r.url), rules))) return true;
      }
    } catch { /* malformed citations: judge by text alone */ }
    // Mail, texts and credentials inside an allowed site are cut sentence by sentence (cleanSentences).
    return false;
  }

  /** What is in front right now, for quiet rules and "this". No text beyond a safe title. */
  situation(): Situation {
    const now = this.now();
    const off: Situation = { off: true, app: null, title: null, host: null, dwellSec: 0, quietSec: 0, typing: false, inCall: false, watching: false };
    if (this.isOff()) return off;
    const ev = this.events(now - 45 * MIN, 300);
    if (!ev.length) return { ...off, off: false, quietSec: 45 * 60 };
    const front = ev.find((e) => e.kind !== 'session.ended') ?? ev[0];
    let since = front.at;
    for (const e of ev) {
      if (e.bundle !== front.bundle || (front.host && e.host && e.host !== front.host)) break;
      since = e.at;
    }
    const recent = ev.filter((e) => now - e.at < 2 * MIN);
    const typing = ev.some((e) => e.kind === 'keyboard.text_input' && now - e.at < 75_000);
    // Calls can happen in private apps (FaceTime, Discord): bundle ids only, no titles or text.
    const callBundles = this.query<{ bundle: string }>(`SELECT DISTINCT bundle_id AS bundle FROM context_awareness_events WHERE occurred_at >= ?`, now - 2 * MIN);
    const inCall = callBundles.some((r) => CALL_APPS.has(r.bundle)) || recent.some((e) => CALL_HOSTS.some((h) => under(e.host, h)));
    const watching = !!front.host && VIDEO_HOSTS.some((h) => under(front.host, h)) && now - front.at < 10 * MIN;
    return {
      off: false, app: front.app || null, title: front.title || null, host: front.host || null,
      dwellSec: Math.max(0, Math.round((now - since) / 1000)), quietSec: Math.max(0, Math.round((now - ev[0].at) / 1000)),
      typing, inCall, watching,
    };
  }

  /**
   * A small, labelled fact sheet for one question about Owner's own recent activity.
   * Recent 10-minute windows plus the most relevant older ones; never more than ~1,600 characters.
   */
  async pack(question: string, opts: { hours?: number; maxChars?: number } = {}): Promise<Pack> {
    if (this.isOff()) return { off: true, facts: '', sources: [], hidden: 0 };
    const now = this.now();
    const maxChars = opts.maxChars ?? 1600;
    const q = words(question);
    const { list, hidden } = this.summaries(now - (opts.hours ?? 36) * 3_600_000, 80);
    const tenMin = list.filter((s) => s.kind === '10min');
    const score = (s: CtxSummary) => {
      const w = new Set(words(`${s.title} ${s.description} ${s.body}`));
      const hit = q.filter((x) => w.has(x)).length;
      const age = (now - s.to) / 3_600_000;
      return hit * 2 + Math.max(0, 3 - age);   // relevance first, then recency (last ~3 h)
    };
    const ranked = [...tenMin].sort((a, b) => score(b) - score(a));
    const chosen = new Set<CtxSummary>([...tenMin.slice(0, 3), ...ranked.slice(0, 3)]);
    const lines: string[] = [];
    const sources: string[] = [];
    const clock = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const day = (t: number) => {
      const d = new Date(t), n = new Date(now);
      if (d.toDateString() === n.toDateString()) return 'today';
      if (d.toDateString() === new Date(now - DAY).toDateString()) return 'yesterday';
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    };
    for (const s of [...chosen].sort((a, b) => b.from - a.from)) {
      const t = safeText(s.title, 120), d = cleanSentences(s.description, 260);
      if (!t && !d) continue;
      lines.push(`- ${day(s.from)} ${clock(s.from)}–${clock(s.to)}: ${t}${d ? `. ${d}` : ''}`);
      sources.push(`summary:${s.kind}:${s.from}`);
    }
    // Where he is right now, from metadata only.
    const sit = this.situation();
    if (!sit.off && sit.app) {
      const mins = Math.round(sit.dwellSec / 60);
      lines.unshift(`- now: ${sit.app}${sit.title ? ` — "${sit.title}"` : ''}${sit.host ? ` (${sit.host})` : ''}${mins >= 1 ? `, in front for ${mins} min` : ''}${sit.quietSec > 300 ? `, no activity for ${Math.round(sit.quietSec / 60)} min` : ''}`);
      sources.push('situation');
    }
    // Older days: Aside's own memory index, context-awareness pages only.
    const older = /\b(yesterday|last (week|night|time|weekend)|days? ago|the other day|on (mon|tues|wednes|thurs|fri|satur|sun)day|earlier this week)\b/i.test(question);
    if (this.search && q.length && (older || chosen.size < 2)) {
      const hits = (await this.search(question, 6)).filter((h) => /\/episodic\/context-awareness-\d{4}-\d{2}-\d{2}\.md$/.test(h.path));
      for (const h of hits.slice(0, 2)) {
        const when = h.date ?? (h.path.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? '');
        if (when && Date.parse(when) > now - 2 * DAY) continue;   // already covered by the ledger
        const ex = cleanSentences(h.excerpt.replace(/[*_`#>]/g, ''), 300);
        if (!ex) continue;
        lines.push(`- ${when}: ${safeText(h.title, 100)}. ${ex}`);
        sources.push(`memory:${when}`);
      }
    }
    let facts = '';
    for (const l of lines) {
      if (facts.length + l.length + 1 > maxChars) break;
      facts += (facts ? '\n' : '') + l;
    }
    return { off: false, facts, sources, hidden };
  }

  /**
   * "Looks done?" evidence: a recent summary that says he submitted or turned something in.
   * Cached five minutes. Negated or partial phrasing ("did not submit", "draft") never counts.
   */
  doneSignals(days = 14): DoneSignalLike[] {
    const now = this.now();
    if (this.doneCache && now - this.doneCache.at < 5 * MIN) return this.doneCache.v;
    const out: DoneSignalLike[] = [];
    const { list } = this.summaries(now - days * DAY, 400);
    const YES = /\b(you\s+)?(submitted|turned in|handed in|submission (was )?(received|confirmed|complete)|marked (it |the \w+ )?(as )?(done|complete))\b/i;
    const NO = /\b(not|n't|never|without|unsubmitted|draft|didn't|did not|yet to|before submitting|to submit|wasn't|was not|no submission|left .{0,30}unsubmitted)\b/i;
    for (const s of list) {
      if (s.kind !== '10min') continue;
      const text = [s.title, s.description, s.body].map((x) => x.trim().replace(/[.!?]+$/, '')).filter(Boolean).join('. ').replace(/[*_`#>]/g, ' ') + '.';
      if (!/schoology|classroom|assignment|quiz|lab|worksheet|assessment|essay|homework/i.test(text)) continue;
      for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
        if (!YES.test(sentence) || NO.test(sentence)) continue;
        const subject = safeText(sentence, 160);
        if (!subject) continue;
        out.push({ kind: 'done', subject, host: 'screen', at: new Date(s.to).toISOString(), p: 0.85 });
      }
    }
    this.doneCache = { at: now, v: out.slice(0, 40) };
    return this.doneCache.v;
  }
}

// --------------------------------------------------------------------------
// "Looks done?" from the screen: local matching only, never a model.

export interface ScreenDoneTarget { id: string; source: string; title: string; resolved: boolean; dueISO: string | null; doneHint?: unknown }

/** Words that name the assignment itself, not the class or the action. */
function titleWords(title: string): string[] {
  return words(title).filter((w) => w.length >= 3 && !/^(assignment|homework|due|submit|class|period|unit|week|day|quiz|test|lab|key)$/.test(w));
}

/** Best screen sentence for an item, or null. Needs most of the title's distinctive words. */
export function matchScreenDone<T extends ScreenDoneTarget>(item: T, signals: DoneSignalLike[]): DoneSignalLike | null {
  if (item.resolved || item.doneHint || (item.source !== 'schoology' && item.source !== 'task')) return null;
  const tw = [...new Set(titleWords(item.title))];
  if (!tw.length) return null;
  let best: { s: DoneSignalLike; r: number } | null = null;
  for (const s of signals) {
    if (item.dueISO && Date.parse(s.at) < Date.parse(item.dueISO) - 30 * DAY) continue;
    const sw = new Set(words(s.subject));
    const hit = tw.filter((w) => sw.has(w)).length;
    const r = hit / tw.length;
    const enough = tw.length === 1 ? hit === 1 && tw[0].length >= 5 : hit >= 2 && r >= 0.6;
    if (enough && (!best || r > best.r || (r === best.r && s.at > best.s.at))) best = { s, r };
  }
  return best ? best.s : null;
}

export function applyScreenDone<T extends ScreenDoneTarget>(raws: T[], signals: DoneSignalLike[]): T[] {
  if (!signals.length) return raws;
  return raws.map((r) => {
    const s = matchScreenDone(r, signals);
    return s ? { ...r, doneHint: { subject: s.subject, at: s.at, p: s.p, via: 'screen' as const } } : r;
  });
}
