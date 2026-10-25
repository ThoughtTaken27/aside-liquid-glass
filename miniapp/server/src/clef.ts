/**
 * Clef (Cloudflare Workers AI) as a second door for decision questions.
 *
 * Clef and Clef-flash speak the same typed language as Jev (noul / choice /
 * score) and return the same answer shapes, so jev.ts can route a feature to
 * either one and fall back to the other. This file is only the Cloudflare
 * side: credentials, a daily budget, a breaker, a cache, and strict answer
 * validation. It never writes text and never causes an action.
 *
 *   Budget   Workers AI gives every account 10,000 Neurons a day free. We stop
 *            at 8,000 (cap) so a miscount can never become a bill, and split
 *            it by tier exactly like Jev: background 55%, you 85%, safety 100%.
 *            Cost is billed per input token: Clef-flash 8,182 Neurons per
 *            million tokens, Clef 21,818. Output is not billed.
 *   Reset    Cloudflare resets at 00:00 UTC, same as our ledger day.
 *   Breaker  429 pauses until the window can reopen (to midnight UTC if the
 *            daily allowance is gone, else 2 min). A rejected token pauses 10
 *            min. Three network failures or timeouts pause 2 min. While
 *            paused callers get a refusal and jev.ts tries the next door.
 *   Cache    Same model + questions + state = same answer for a week, on disk.
 *   Privacy  Credentials live in one 0600 file and are never logged. The
 *            private-text guard runs in jev.ts before any door is tried.
 *
 * Hedging: a stalled request is raced against one identical retry after `hedgeMs`.
 * Only slow or failed calls pay for the second request, and an answer is an answer
 * whichever copy returns it.
 *
 * Gotcha (Oct 5, 2026): the Workers AI REST endpoint answers 422 "questions
 * Field required" if the request carries `content-type: application/json`.
 * Send the JSON string with no content-type header.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readAnswer, type JevAnswers, type JevAsk, type JevQuestions, type JevResult, type JevTier } from './jev.js';

export type ClefModel = 'clef-flash' | 'clef';

export interface ClefCreds {
  accountId: string;
  token: string;
}

/** Neurons per million input tokens, from the Workers AI pricing page (Oct 2026). */
export const NEURONS_PER_M: Record<ClefModel, number> = { 'clef-flash': 8182, clef: 21818 };

const TIER_SHARE: Record<JevTier, number> = { background: 0.55, you: 0.85, safety: 1 };
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const PAUSE_NET_MS = 2 * 60_000;
/** An ordinary 429 pauses for Retry-After when sent, else this. Cloudflare's per-minute windows reopen fast. */
const PAUSE_429_MS = 20_000;
const PAUSE_429_MAX_MS = 60_000;
const PAUSE_AUTH_MS = 10 * 60_000;
const MAX_CACHE = 3000;
/** Chars per token is about 3 for this kind of text; estimate high so the cap holds. */
const CHARS_PER_TOKEN_EST = 2.6;

export interface ClefOptions {
  /** Read on every call so a rotated token needs no restart. */
  creds: () => ClefCreds | null;
  stateDir: string;
  /** Neurons per UTC day we allow ourselves. Free allowance is 10,000. */
  neuronCap?: number;
  concurrency?: number;
  /** Per-request timeout in ms. Default 3000 (6000 for the safety tier): voice cannot wait. */
  timeoutMs?: number;
  /**
   * If no answer after this many ms, send the same request again and take whichever
   * returns first (also retries at once after a network error or 5xx). About 2% of
   * calls stall for seconds; this keeps voice from waiting on them. The speculative
   * copy is skipped while more than two requests are already in flight, so a busy
   * or slow moment never doubles its own load. Default 900.
   */
  hedgeMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string, extra?: unknown) => void;
}

interface Ledger {
  day: string;
  neurons: number;
  calls: number;
  byTier: Record<JevTier, number>;
  byModel: Record<string, number>;
  byFeature: Record<string, number>;
  /** Failures today by reason, so a flaky day shows up in status. */
  errors: Record<string, number>;
  /** Speculative second requests sent today, and calls that took over 2 s end to end. */
  hedges: number;
  slow: number;
  pausedUntil: number;
  last429: number;
  lastError: string | null;
}

interface CacheRow {
  at: number;
  ttl: number;
  answers: JevAnswers;
}

export interface ClefStatus {
  state: 'ok' | 'paused' | 'limited' | 'off';
  day: string;
  neurons: number;
  cap: number;
  calls: number;
  byModel: Record<string, number>;
  byTier: Record<JevTier, number>;
  byFeature: Record<string, number>;
  cacheHits: number;
  pausedUntil: string | null;
  lastError: string | null;
  errors: Record<string, number>;
  hedges: number;
  slow: number;
  p50ms: number | null;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function nextUtcMidnight(ms: number): number {
  return (Math.floor(ms / DAY_MS) + 1) * DAY_MS;
}

/** Credentials from a 0600 JSON file: { "accountId": "...", "token": "..." }. Re-read when the file changes. */
export function fileCreds(file: string): () => ClefCreds | null {
  let cached: { mtime: number; creds: ClefCreds | null } | null = null;
  return () => {
    try {
      const st = fs.statSync(file);
      if (cached && cached.mtime === st.mtimeMs) return cached.creds;
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ClefCreds>;
      const ok = typeof j.accountId === 'string' && /^[a-f0-9]{32}$/i.test(j.accountId) && typeof j.token === 'string' && j.token.length >= 20;
      cached = { mtime: st.mtimeMs, creds: ok ? { accountId: j.accountId!, token: j.token! } : null };
      return cached.creds;
    } catch {
      return null;
    }
  };
}

export class ClefDoor {
  private ledger: Ledger;
  private cache = new Map<string, CacheRow>();
  private inflight = new Map<string, Promise<JevResult>>();
  private running = 0;
  private queue: Array<() => void> = [];
  private netFails = 0;
  private probing = false;
  private cacheHits = 0;
  private latencies: number[] = [];
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  readonly cap: number;

  constructor(private readonly o: ClefOptions) {
    this.now = o.now ?? Date.now;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.cap = o.neuronCap ?? 8000;
    this.ledger = this.readLedger() ?? this.fresh();
    this.readCache();
  }

  private get ledgerPath(): string {
    return path.join(this.o.stateDir, 'clef-ledger.json');
  }
  private get cachePath(): string {
    return path.join(this.o.stateDir, 'clef-cache.json');
  }

  private fresh(): Ledger {
    return {
      day: utcDay(this.now()),
      neurons: 0,
      calls: 0,
      byTier: { safety: 0, you: 0, background: 0 },
      byModel: {},
      byFeature: {},
      errors: {},
      hedges: 0,
      slow: 0,
      pausedUntil: 0,
      last429: 0,
      lastError: null,
    };
  }

  private readLedger(): Ledger | null {
    try {
      const l = JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8')) as Ledger;
      if (typeof l.neurons === 'number' && l.byTier && typeof l.day === 'string') return { ...this.fresh(), ...l };
    } catch {
      /* first run */
    }
    return null;
  }

  private rollDay(): void {
    if (this.ledger.day !== utcDay(this.now())) {
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
      write(this.ledgerPath, this.ledger);
      write(this.cachePath, [...this.cache.entries()].slice(-MAX_CACHE));
    } catch (err) {
      this.o.log?.('clef flush failed', err);
    }
  }

  private key(model: ClefModel, questions: JevQuestions, state: string): string {
    return crypto.createHash('sha256').update('clef:').update(model).update('\0').update(JSON.stringify(questions)).update('\0').update(state).digest('hex');
  }

  private estimateNeurons(model: ClefModel, req: JevAsk): number {
    const chars = req.state.length + JSON.stringify(req.questions).length;
    return (Math.ceil(chars / CHARS_PER_TOKEN_EST) * NEURONS_PER_M[model]) / 1e6;
  }

  private refuse(why: 'off' | 'paused' | 'budget' | 'error'): JevResult {
    return { ok: false, why };
  }

  /** Rough count of calls left for a tier today (planning only; assumes the bigger model). */
  leftCalls(tier: JevTier): number {
    this.rollDay();
    if (!this.o.creds() || this.now() < this.ledger.pausedUntil) return 0;
    const room = Math.floor(this.cap * TIER_SHARE[tier]) - this.ledger.neurons;
    return Math.max(0, Math.floor(room / 12));
  }

  async ask(model: ClefModel, req: JevAsk): Promise<JevResult> {
    if (!this.o.creds()) return this.refuse('off');
    const k = this.key(model, req.questions, req.state);
    const hit = this.cache.get(k);
    if (hit && this.now() - hit.at < hit.ttl) {
      this.cacheHits++;
      return { ok: true, answers: hit.answers, cached: true, ms: 0, via: model };
    }
    const pending = this.inflight.get(k);
    if (pending) return pending;
    const p = this.run(model, req, k).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  private async slot(): Promise<() => void> {
    const max = this.o.concurrency ?? 4;
    if (this.running >= max) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    return () => {
      this.running--;
      this.queue.shift()?.();
    };
  }

  private noteError(reason: string): void {
    this.ledger.lastError = reason;
    this.ledger.errors[reason] = (this.ledger.errors[reason] ?? 0) + 1;
  }

  private pauseFor(ms: number, reason: string): void {
    this.ledger.pausedUntil = this.now() + ms;
    this.noteError(reason);
    this.o.log?.(`clef paused ${Math.round(ms / 1000)}s: ${reason}`);
    this.flush();
  }

  private failNet(reason: string): JevResult {
    this.noteError(reason);
    if (++this.netFails >= 3) {
      this.netFails = 0;
      this.pauseFor(PAUSE_NET_MS, `paused: ${reason}`);
    }
    return this.refuse('error');
  }

  /** First good response wins; a second copy is launched after hedgeMs, or at once if the first fails. */
  private hedged(make: () => Promise<Response>): Promise<Response> {
    const hedgeMs = this.o.hedgeMs ?? 900;
    return new Promise<Response>((resolve, reject) => {
      let launched = 0;
      let failed = 0;
      let done = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        fn();
      };
      const onFail = (e: unknown) => {
        failed++;
        if (done) return;
        if (launched < 2) launch();
        else if (failed >= launched) finish(() => reject(e));
      };
      const launch = () => {
        if (done || launched >= 2) return;
        launched++;
        const first = launched === 1;
        make().then(
          (r) => (r.status >= 500 && first ? onFail(new Error(`http ${r.status}`)) : finish(() => resolve(r))),
          onFail,
        );
        if (first) {
          timer = setTimeout(() => {
            // Hedging a busy pool only makes it busier.
            if (this.running <= 2 && !done) {
              this.ledger.hedges++;
              launch();
            }
          }, hedgeMs);
          timer.unref?.();
        }
      };
      launch();
    });
  }

  private async run(model: ClefModel, req: JevAsk, k: string): Promise<JevResult> {
    const release = await this.slot();
    let isProbe = false;
    try {
      this.rollDay();
      const creds = this.o.creds();
      if (!creds) return this.refuse('off');
      const t = this.now();
      if (t < this.ledger.pausedUntil) return this.refuse('paused');
      if (this.ledger.pausedUntil) {
        // First request after a pause: let exactly one through to test the water.
        if (this.probing) return this.refuse('paused');
        this.probing = isProbe = true;
      }
      const est = this.estimateNeurons(model, req);
      if (this.ledger.neurons + est > Math.floor(this.cap * TIER_SHARE[req.tier])) return this.refuse('budget');

      const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/run/@cf/cloudflare/${model}`;
      const started = this.now();
      let res: Response;
      try {
        const body = JSON.stringify({ model, state: req.state, questions: req.questions });
        // Safety checks may wait a little; voice and background fall through to the next door sooner.
        const timeout = this.o.timeoutMs ?? (req.tier === 'safety' ? 6000 : 3000);
        res = await this.hedged(() =>
          this.fetchImpl(url, {
            method: 'POST',
            // No content-type on purpose (see the gotcha above).
            headers: { authorization: `Bearer ${creds.token}` },
            body,
            signal: AbortSignal.timeout(timeout),
          }),
        );
      } catch {
        return this.failNet('network or timeout');
      }
      if (res.status === 429) {
        this.ledger.last429 = this.now();
        const text = await res.text().catch(() => '');
        const daily = /4006|daily|neuron|allocation/i.test(text);
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(PAUSE_429_MAX_MS, retryAfter * 1000) : PAUSE_429_MS;
        this.pauseFor(daily ? nextUtcMidnight(this.now()) - this.now() : wait, daily ? 'daily allowance used up' : 'rate limited');
        // Keep a short, secret-free snippet of what Cloudflare said, to learn the real limit.
        this.ledger.lastError = `${daily ? 'daily allowance used up' : 'rate limited'}: ${text.replace(/\s+/g, ' ').slice(0, 120)}`;
        return this.refuse('paused');
      }
      if (res.status === 401 || res.status === 403) {
        await res.arrayBuffer().catch(() => null);
        this.pauseFor(PAUSE_AUTH_MS, `token rejected (${res.status})`);
        return this.refuse('error');
      }
      if (!res.ok) {
        await res.arrayBuffer().catch(() => null);
        // 422 means our request was malformed: a bug to see, not a reason to pause everyone.
        if (res.status === 422) {
          this.noteError('request rejected (422)');
          return this.refuse('error');
        }
        return this.failNet(`http ${res.status}`);
      }
      this.netFails = 0;
      const body = (await res.json().catch(() => null)) as {
        success?: boolean;
        result?: { answers?: Record<string, unknown>; usage?: { input_tokens?: number } };
      } | null;
      if (!body || body.success === false || !body.result?.answers) {
        this.noteError('bad reply shape');
        return this.refuse('error');
      }
      const answers: JevAnswers = {};
      for (const [id, q] of Object.entries(req.questions)) {
        const a = readAnswer(q, body.result.answers[id]);
        if (!a) {
          this.noteError('off-shape answer');
          return this.refuse('error');
        }
        answers[id] = a;
      }
      // Cloudflare reports the exact cost per call; fall back to the token count, then the estimate.
      const reported = Number(res.headers.get('cf-ai-neurons'));
      const tokens = body.result.usage?.input_tokens;
      const cost = Number.isFinite(reported) && reported > 0 ? reported : typeof tokens === 'number' && tokens >= 0 ? (tokens * NEURONS_PER_M[model]) / 1e6 : est;
      this.ledger.neurons += cost;
      this.ledger.calls++;
      this.ledger.byTier[req.tier] += cost;
      this.ledger.byModel[model] = (this.ledger.byModel[model] ?? 0) + 1;
      this.ledger.byFeature[req.feature] = (this.ledger.byFeature[req.feature] ?? 0) + 1;
      this.ledger.lastError = null;
      if (isProbe) this.ledger.pausedUntil = 0;
      const ms = this.now() - started;
      if (ms > 2000) this.ledger.slow++;
      this.latencies.push(ms);
      if (this.latencies.length > 200) this.latencies.shift();
      const ttl = req.ttlMs ?? WEEK_MS;
      if (ttl > 0) {
        this.cache.set(k, { at: this.now(), ttl, answers });
        if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
      }
      this.scheduleSave();
      return { ok: true, answers, cached: false, ms, via: model };
    } finally {
      if (isProbe) this.probing = false;
      release();
    }
  }

  status(): ClefStatus {
    this.rollDay();
    const l = this.ledger;
    const t = this.now();
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      state: !this.o.creds() ? 'off' : t < l.pausedUntil ? 'paused' : l.neurons >= this.cap ? 'limited' : 'ok',
      day: l.day,
      neurons: Math.round(l.neurons * 10) / 10,
      cap: this.cap,
      calls: l.calls,
      byModel: { ...l.byModel },
      byTier: Object.fromEntries(Object.entries(l.byTier).map(([k, v]) => [k, Math.round(v * 10) / 10])) as Record<JevTier, number>,
      byFeature: { ...l.byFeature },
      cacheHits: this.cacheHits,
      pausedUntil: t < l.pausedUntil ? new Date(l.pausedUntil).toISOString() : null,
      lastError: l.lastError,
      errors: { ...l.errors },
      hedges: l.hedges,
      slow: l.slow,
      p50ms: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    };
  }
}
