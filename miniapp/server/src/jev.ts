/**
 * One shared door to Jev (TypeSafe's decision model) for everything on this
 * Mac: mail gates, Next's background checks, research audits, and outside
 * tools through a local socket.
 *
 * Jev only answers typed questions (yes/no probability, pick-one, score). It
 * never writes text, and nothing here lets its answer cause an action: code
 * reads the numbers and decides. The rules this file enforces:
 *
 *   Budget   The free tier stops at roughly 200-250 requests a day (seen
 *            Sep 26: 248, then 429s for hours). Requests are counted, not
 *            questions, so callers pack many questions into one call. Each
 *            tier has a ceiling so background work can never starve the
 *            safety checks: background <= 55%, you <= 85%, safety <= 100%.
 *   Breaker  A 429 pauses every caller for 30 minutes, then one request is
 *            let through as a probe. Three network failures pause 2 minutes.
 *            When paused, callers get null and fall back to plain code.
 *   Cache    Same model + questions + state = same answer for a week. Kept
 *            on disk so a restart doesn't spend the budget again.
 *   Privacy  Text that looks private (codes, money, immigration, health,
 *            legal) is refused unless the caller already filtered it.
 *            Local endpoint only: the key never leaves 127.0.0.1.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { privateText } from './guards.js';
import type { ClefDoor, ClefStatus } from './clef.js';

export type JevTier = 'safety' | 'you' | 'background';

/** Which model answers: TypeSafe's Jev, or Cloudflare's Clef (27B) / Clef-flash (9B). */
export type Backend = 'jev' | 'clef-flash' | 'clef';

export type JevQuestion =
  | { type: 'noul'; instructions: unknown; criteria?: { true: unknown; false: unknown } }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
  | { type: 'score'; instructions: unknown; criteria: unknown[] };

export type JevQuestions = Record<string, JevQuestion>;

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}
export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface ScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type JevAnswers = Record<string, JevAnswer>;

export type JevRefusal = 'private' | 'budget' | 'paused' | 'error' | 'off' | 'too-big';

export interface JevAsk {
  state: string;
  questions: JevQuestions;
  tier: JevTier;
  /** Short label for stats, e.g. "mail.gate" or "next.dedupe". */
  feature: string;
  /** Caller already ran its own private filter (mail gates). */
  allowPrivate?: boolean;
  /** Cache lifetime. Default one week; 0 = don't cache. */
  ttlMs?: number;
}

export type JevResult = { ok: true; answers: JevAnswers; cached: boolean; ms: number; via?: Backend } | { ok: false; why: JevRefusal };

/**
 * Which backends to try, in order, per feature. Read from a small JSON file so
 * a change (or a rollback to Jev only) needs no rebuild or restart:
 *   { "enabled": true, "routes": { "heyaside.route": ["clef-flash", "jev"], "*": ["jev", "clef"] } }
 * Keys match exactly, then by `prefix.*`, then `*`. Anything missing, invalid, or
 * disabled means Jev only, which is how this door behaved before Clef.
 */
export interface RouteTable {
  enabled: boolean;
  routes: Record<string, Backend[]>;
}

const BACKENDS: ReadonlySet<string> = new Set(['jev', 'clef-flash', 'clef']);

export function parseRoutes(raw: unknown): RouteTable | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { enabled?: unknown; routes?: unknown };
  if (r.enabled !== true || !r.routes || typeof r.routes !== 'object') return null;
  const routes: Record<string, Backend[]> = {};
  for (const [k, v] of Object.entries(r.routes as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue;
    const chain = [...new Set(v.filter((x): x is Backend => typeof x === 'string' && BACKENDS.has(x)))];
    if (chain.length) routes[k] = chain;
  }
  return Object.keys(routes).length ? { enabled: true, routes } : null;
}

export function chainFor(table: RouteTable | null, feature: string): Backend[] {
  if (!table) return ['jev'];
  const exact = table.routes[feature];
  if (exact) return exact;
  let best: Backend[] | null = null;
  let bestLen = -1;
  for (const [k, v] of Object.entries(table.routes)) {
    if (k.endsWith('.*') && feature.startsWith(k.slice(0, -1)) && k.length > bestLen) {
      best = v;
      bestLen = k.length;
    }
  }
  return best ?? table.routes['*'] ?? ['jev'];
}

/** A route table from a JSON file, re-read when the file changes. */
export function fileRoutes(file: string): () => RouteTable | null {
  let cached: { mtime: number; table: RouteTable | null } | null = null;
  return () => {
    try {
      const st = fs.statSync(file);
      if (cached && cached.mtime === st.mtimeMs) return cached.table;
      cached = { mtime: st.mtimeMs, table: parseRoutes(JSON.parse(fs.readFileSync(file, 'utf8'))) };
      return cached.table;
    } catch {
      return null;
    }
  };
}

export interface JevEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface JevStatus {
  state: 'ok' | 'paused' | 'limited' | 'off';
  day: string;
  used: number;
  cap: number;
  byTier: Record<JevTier, number>;
  byFeature: Record<string, number>;
  cacheHits: number;
  refused: Partial<Record<JevRefusal, number>>;
  pausedUntil: string | null;
  last429: string | null;
  p50ms: number | null;
  /** Network lane counted right now, and today's use in each lane. */
  lane?: JevLane;
  lanes?: Partial<Record<JevLane, { used: number; paused: boolean }>>;
  /** Cloudflare Clef door, when one is attached. */
  clef?: ClefStatus;
  /** Which backends each feature tries, in order, right now. */
  routes?: Record<string, Backend[]> | null;
}

const TIER_SHARE: Record<JevTier, number> = { background: 0.55, you: 0.85, safety: 1 };
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const PAUSE_429_MS = 30 * 60_000;
const PAUSE_NET_MS = 2 * 60_000;
/** 32k-token context; stay well inside it. */
const MAX_STATE = 24_000;
const MAX_CACHE = 3000;

interface Ledger {
  day: string;
  used: number;
  byTier: Record<JevTier, number>;
  byFeature: Record<string, number>;
  pausedUntil: number;
  last429: number;
}

interface CacheRow {
  at: number;
  ttl: number;
  answers: JevAnswers;
}

export interface JevOptions {
  /** Resolves the endpoint each call so a config change needs no restart. */
  endpoint: () => JevEndpoint | null;
  stateDir: string;
  cap?: number;
  concurrency?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string, extra?: unknown) => void;
  /**
   * Which network the Mac is on right now (Sep 27). The free tier counts per
   * address, so Owner gets ~250 at home and another ~250 with X-VPN on (school
   * days 7 AM-3 PM). Each lane keeps its own count and its own 429 pause.
   */
  lane?: () => JevLane;
  /** Cloudflare Clef door. Without it, every route that names a Clef model falls through to the next backend. */
  clef?: ClefDoor;
  /** Per-feature backend order. Without it (or when disabled), Jev only. */
  routes?: () => RouteTable | null;
}

export type JevLane = 'home' | 'vpn';

let laneCache: { at: number; lane: JevLane } | null = null;
/** 'vpn' when a non-Tailscale VPN service is connected (X-VPN), else 'home'. Cached 20 s. */
export function detectLane(now = Date.now()): JevLane {
  if (laneCache && now - laneCache.at < 20_000) return laneCache.lane;
  let lane: JevLane = 'home';
  try {
    const out = execFileSync('/usr/sbin/scutil', ['--nc', 'list'], { encoding: 'utf8', timeout: 1500 });
    if (out.split('\n').some((l) => l.includes('(Connected)') && !/tailscale/i.test(l))) lane = 'vpn';
  } catch {
    /* no scutil: count everything as home */
  }
  laneCache = { at: now, lane };
  return lane;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function prob(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function numMap(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== 'object') return null;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const p = prob(x);
    if (p === null) return null;
    out[k] = p;
  }
  return out;
}

/** Validate one answer against the question that asked it. Anything off-shape is dropped. */
export function readAnswer(q: JevQuestion, raw: unknown): JevAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (q.type === 'noul') {
    const n = prob(a.noul);
    return n === null ? null : { type: 'noul', noul: n };
  }
  const probabilities = numMap(a.probabilities);
  const confidence = prob(a.confidence);
  if (!probabilities || confidence === null) return null;
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria);
    const choice = typeof a.choice === 'string' && keys.includes(a.choice) ? a.choice : null;
    return choice ? { type: 'choice', choice, confidence, probabilities } : null;
  }
  const top = q.criteria.length - 1;
  const score = typeof a.score === 'number' && a.score >= 0 && a.score <= top ? a.score : null;
  return score === null ? null : { type: 'score', score, confidence, probabilities };
}

export class Jev {
  private lanes: Partial<Record<JevLane, Ledger>> = {};
  private laneNow(): JevLane {
    return this.o.lane ? this.o.lane() : process.env.VITEST ? 'home' : detectLane(this.now());
  }
  private get ledger(): Ledger {
    const k = this.laneNow();
    return (this.lanes[k] ??= this.fresh());
  }
  private set ledger(l: Ledger) {
    this.lanes[this.laneNow()] = l;
  }
  private cache = new Map<string, CacheRow>();
  private inflight = new Map<string, Promise<JevResult>>();
  private running = 0;
  private queue: Array<() => void> = [];
  private netFails = 0;
  private probing = false;
  private cacheHits = 0;
  private refused: Partial<Record<JevRefusal, number>> = {};
  private latencies: number[] = [];
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  readonly cap: number;

  constructor(private readonly o: JevOptions) {
    this.now = o.now ?? Date.now;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.cap = o.cap ?? 240;   // per lane (home, vpn): ~250 each upstream
    this.lanes = this.readLedger();
    this.readCache();
  }

  private get ledgerPath(): string {
    return path.join(this.o.stateDir, 'jev-ledger.json');
  }
  private get cachePath(): string {
    return path.join(this.o.stateDir, 'jev-cache.json');
  }

  private fresh(): Ledger {
    return { day: utcDay(this.now()), used: 0, byTier: { safety: 0, you: 0, background: 0 }, byFeature: {}, pausedUntil: 0, last429: 0 };
  }

  private readLedger(): Partial<Record<JevLane, Ledger>> {
    try {
      const l = JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8')) as Ledger | { lanes: Partial<Record<JevLane, Ledger>> };
      if ('lanes' in l && l.lanes) return l.lanes;
      if ('used' in l && typeof l.used === 'number' && l.byTier) return { home: l };
    } catch {
      /* first run */
    }
    return {};
  }

  private rollDay(): void {
    const today = utcDay(this.now());
    if (this.ledger.day !== today) {
      // A pause from yesterday's 429 still stands; the counters restart.
      this.ledger = { ...this.fresh(), pausedUntil: this.ledger.pausedUntil, last429: this.ledger.last429 };
    }
  }

  private readCache(): void {
    try {
      const rows = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) as Array<[string, CacheRow]>;
      const t = this.now();
      for (const [k, r] of rows) if (t - r.at < r.ttl) this.cache.set(k, r);
    } catch {
      /* none yet */
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 2000);
    this.saveTimer.unref?.();
  }

  /** Write ledger and cache now (atomic rename; 0600). */
  flush(): void {
    try {
      fs.mkdirSync(this.o.stateDir, { recursive: true });
      const write = (file: string, data: unknown) => {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
        fs.renameSync(tmp, file);
      };
      write(this.ledgerPath, { lanes: this.lanes });
      write(this.cachePath, [...this.cache.entries()].slice(-MAX_CACHE));
    } catch (err) {
      this.o.log?.('jev flush failed', err);
    }
    this.o.clef?.flush();
  }

  private key(model: string, questions: JevQuestions, state: string): string {
    return crypto.createHash('sha256').update(model).update('\0').update(JSON.stringify(questions)).update('\0').update(state).digest('hex');
  }

  private refuse(why: JevRefusal): JevResult {
    this.refused[why] = (this.refused[why] ?? 0) + 1;
    return { ok: false, why };
  }

  /** Would a call at this tier be allowed right now? (No side effects.) */
  canSpend(tier: JevTier, n = 1): boolean {
    this.rollDay();
    if (this.clefEnabled() && this.o.clef!.leftCalls(tier) >= n) return true;
    if (this.now() < this.ledger.pausedUntil) return false;
    return this.ledger.used + n <= Math.floor(this.cap * TIER_SHARE[tier]);
  }

  /** Requests left today for a tier (Jev's, plus a rough Clef count when routes may use it). */
  left(tier: JevTier): number {
    this.rollDay();
    const jev = Math.max(0, Math.floor(this.cap * TIER_SHARE[tier]) - this.ledger.used);
    return jev + (this.clefEnabled() ? this.o.clef!.leftCalls(tier) : 0);
  }

  private clefEnabled(): boolean {
    return Boolean(this.o.clef && this.o.routes?.());
  }

  /**
   * Ask the backends the route table names for this feature, in order, and
   * return the first answer. A refusal (budget, pause, error, off) moves on to
   * the next one; text that is private or too big stops everything, because
   * no backend should see it. With no routes this is exactly the Jev-only door.
   */
  async ask(req: JevAsk): Promise<JevResult> {
    const chain = chainFor(this.o.routes?.() ?? null, req.feature);
    if (chain.length === 1 && chain[0] === 'jev') return this.askJev(req);
    if (req.state.length > MAX_STATE) return this.refuse('too-big');
    if (!req.allowPrivate && privateText(req.state)) return this.refuse('private');
    let last: JevResult = { ok: false, why: 'off' };
    for (const b of chain) {
      const r = b === 'jev' ? await this.askJev(req) : this.o.clef ? await this.o.clef.ask(b, req) : ({ ok: false, why: 'off' } as JevResult);
      if (r.ok) return r.via ? r : { ...r, via: b };
      last = r;
    }
    return last;
  }

  private async askJev(req: JevAsk): Promise<JevResult> {
    const ep = this.o.endpoint();
    if (!ep) return this.refuse('off');
    if (req.state.length > MAX_STATE) return this.refuse('too-big');
    if (!req.allowPrivate && privateText(req.state)) return this.refuse('private');
    const k = this.key(ep.model, req.questions, req.state);
    const hit = this.cache.get(k);
    if (hit && this.now() - hit.at < hit.ttl) {
      this.cacheHits++;
      return { ok: true, answers: hit.answers, cached: true, ms: 0 };
    }
    // The same question asked twice at once costs one request.
    const pending = this.inflight.get(k);
    if (pending) return pending;
    const p = this.run(ep, req, k).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  private async slot(): Promise<() => void> {
    const max = this.o.concurrency ?? 3;
    if (this.running >= max) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    return () => {
      this.running--;
      this.queue.shift()?.();
    };
  }

  private async run(ep: JevEndpoint, req: JevAsk, k: string): Promise<JevResult> {
    const release = await this.slot();
    let isProbe = false;
    try {
      this.rollDay();
      const t = this.now();
      if (t < this.ledger.pausedUntil) return this.refuse('paused');
      if (this.ledger.pausedUntil && this.ledger.last429 && this.ledger.pausedUntil > this.ledger.last429) {
        // First request after a 429 pause: let exactly one through.
        if (this.probing) return this.refuse('paused');
        this.probing = isProbe = true;
      }
      if (this.ledger.used + 1 > Math.floor(this.cap * TIER_SHARE[req.tier])) return this.refuse('budget');
      this.ledger.used++;
      this.ledger.byTier[req.tier]++;
      this.ledger.byFeature[req.feature] = (this.ledger.byFeature[req.feature] ?? 0) + 1;
      this.scheduleSave();
      const url = `${new URL(ep.baseUrl).origin}/api/v1/systemone`;
      const started = this.now();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
          body: JSON.stringify({ model: ep.model, state: req.state, questions: req.questions }),
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 12_000),
        });
      } catch {
        if (++this.netFails >= 3) {
          this.ledger.pausedUntil = this.now() + PAUSE_NET_MS;
          this.netFails = 0;
        }
        return this.refuse('error');
      }
      if (res.status === 429) {
        // A refused request likely didn't count upstream; don't count it here.
        this.ledger.used--;
        this.ledger.byTier[req.tier]--;
        this.ledger.last429 = this.now();
        this.ledger.pausedUntil = this.now() + PAUSE_429_MS;
        this.o.log?.('jev 429: paused 30 min', { feature: req.feature });
        this.flush();
        return this.refuse('paused');
      }
      if (!res.ok) {
        if (++this.netFails >= 3) {
          this.ledger.pausedUntil = this.now() + PAUSE_NET_MS;
          this.netFails = 0;
        }
        return this.refuse('error');
      }
      this.netFails = 0;
      if (isProbe) this.ledger.pausedUntil = 0;
      const body = (await res.json().catch(() => null)) as { answers?: Record<string, unknown> } | null;
      const answers: JevAnswers = {};
      for (const [id, q] of Object.entries(req.questions)) {
        const a = readAnswer(q, body?.answers?.[id]);
        if (!a) return this.refuse('error');
        answers[id] = a;
      }
      const ms = this.now() - started;
      this.latencies.push(ms);
      if (this.latencies.length > 200) this.latencies.shift();
      const ttl = req.ttlMs ?? WEEK_MS;
      if (ttl > 0) {
        this.cache.set(k, { at: this.now(), ttl, answers });
        if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
        this.scheduleSave();
      }
      return { ok: true, answers, cached: false, ms };
    } finally {
      if (isProbe) this.probing = false;
      release();
    }
  }

  status(): JevStatus {
    this.rollDay();
    const l = this.ledger;
    const t = this.now();
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      state: !this.o.endpoint() ? 'off' : t < l.pausedUntil ? 'paused' : l.used >= this.cap ? 'limited' : 'ok',
      day: l.day,
      used: l.used,
      cap: this.cap,
      byTier: { ...l.byTier },
      byFeature: { ...l.byFeature },
      cacheHits: this.cacheHits,
      refused: { ...this.refused },
      pausedUntil: t < l.pausedUntil ? new Date(l.pausedUntil).toISOString() : null,
      last429: l.last429 ? new Date(l.last429).toISOString() : null,
      p50ms: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      lane: this.laneNow(),
      lanes: Object.fromEntries(
        Object.entries(this.lanes).map(([k, v]) => [k, { used: v!.day === l.day ? v!.used : 0, paused: t < v!.pausedUntil }]),
      ),
      clef: this.o.clef?.status(),
      routes: this.o.routes ? (this.o.routes()?.routes ?? null) : null,
    };
  }

  /**
   * A `fetch` that goes through this door, for older callers built around
   * fetch (inbox.ts jevDecider, personal.ts jevPersonal). Their request body
   * is re-read so the budget, breaker, cache and stats all apply.
   */
  fetchFor(tier: JevTier, feature: string, allowPrivate = true): typeof fetch {
    return (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { state?: string; questions?: JevQuestions };
      const r = await this.ask({ state: String(body.state ?? ''), questions: body.questions ?? {}, tier, feature, allowPrivate });
      if (!r.ok) return new Response(JSON.stringify({ error: r.why }), { status: 503 });
      return new Response(JSON.stringify({ answers: r.answers }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }
}

// --------------------------------------------------------------------------
// Small helpers every caller wants.

export function noul(a: JevAnswers | undefined, id: string): number | null {
  const x = a?.[id];
  return x && x.type === 'noul' ? x.noul : null;
}

export function choice(a: JevAnswers | undefined, id: string): ChoiceAnswer | null {
  const x = a?.[id];
  return x && x.type === 'choice' ? x : null;
}

export function score(a: JevAnswers | undefined, id: string): ScoreAnswer | null {
  const x = a?.[id];
  return x && x.type === 'score' ? x : null;
}

/** Words that carry meaning, for cheap candidate matching before any model call. */
export function tokens(s: string): Set<string> {
  const STOP = new Set('the a an and or of to for in on at by with your you is are be this that from please due re fw fwd new reminder assignment homework hw class'.split(' '));
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
}
