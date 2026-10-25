/**
 * Hey Aside phone API. Everything except the two pairing steps requires a
 * request signed by the phone's hardware key (signing.ts); anything that acts
 * on the world also needs a fingerprint-signed ticket (Tier C), checked here
 * against rate limits before the phone is allowed to carry it out.
 *
 * Tiers (decided by code, never by a model):
 *   A  harmless, no personal data           signed request
 *   B  reads his data                       signed request (key works only unlocked)
 *   C  acts on the world                    signed request + fingerprint ticket + Mac approval
 *   D  payments, passwords, security        not reachable by voice at all
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const shaAction = (a: unknown) => crypto.createHash('sha256').update(JSON.stringify(a)).digest('hex');
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AttestationError, fetchRevokedSerials, verifyAttestation } from './attestation.js';
import { classifyTask, type VoiceAgent } from './agent.js';
import { AuditLog } from './audit.js';
import { think, type BrainDeps } from './brain.js';
import { DeviceRegistry, coarseLocation, readVoiceConfig, type VoiceDevice } from './devices.js';
import { decideStep, P1_APPS, P1_POLICY, type ScreenClef, type ScreenStepInput } from './screen.js';
import { NonceCache, SignatureError, verifySignedRequest, verifyTicket, type ActionTicket } from './signing.js';
import { synthesize, TtsError } from './tts.js';
import type { Completer } from '../inbox.js';

// ---------------------------------------------------------------------------
// Pairing codes: 8 digits, 5 minutes, 3 tries, issued only on the Mac's loopback page.

export class VoicePairCodes {
  private codes = new Map<string, { exp: number; tries: number }>();
  issue(now = Date.now()): string {
    for (const [c, v] of this.codes) if (v.exp <= now) this.codes.delete(c);
    // One live code at a time: issuing a new one kills the old.
    this.codes.clear();
    const code = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
    this.codes.set(code, { exp: now + 5 * 60_000, tries: 0 });
    return code;
  }
  /** Spends the code on success; every failure counts against the live code. */
  consume(code: string, now = Date.now()): boolean {
    const clean = code.replace(/\D/g, '');
    for (const [c, v] of this.codes) {
      if (v.exp <= now) {
        this.codes.delete(c);
        continue;
      }
      if (clean.length === 8 && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(clean))) {
        this.codes.delete(c);
        return true;
      }
      v.tries++;
      if (v.tries >= 3) this.codes.delete(c);
    }
    return false;
  }
}

interface PendingPair {
  challenge: Buffer;
  exp: number;
}

// ---------------------------------------------------------------------------
// Tier C limits: forced-finger and runaway-loop protection.

export class ActionLimiter {
  private times: number[] = [];
  constructor(private perTenMin = 5, private perDay = 30, private readonly file?: string) {
    if (file && fs.existsSync(file)) {
      const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(data) || data.some(t => typeof t !== 'number' || !Number.isFinite(t))) throw new Error('invalid_action_limit_state');
      this.times = data as number[];
    }
  }
  allow(now = Date.now()): boolean {
    this.times = this.times.filter((t) => now - t < 86_400_000);
    const recent = this.times.filter((t) => now - t < 600_000).length;
    if (recent >= this.perTenMin || this.times.length >= this.perDay) return false;
    this.times.push(now);
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.times), { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    }
    return true;
  }
}

/** Kinds of Tier C action the phone may carry out. Anything else is refused. */
// No direct sends or autonomous screen effects in this build. The OS composer/dialer is the final step.
export const PHONE_ACTIONS = new Set(['sms.compose', 'call.dial']);
export function validPhoneAction(action: Record<string, unknown>): boolean {
  if (action.kind === 'agent.task') {
    // A spoken "do this for me" request, run on the Mac by a locked task helper.
    if (Object.keys(action).some((k) => !['kind', 'target', 'text'].includes(k))) return false;
    return action.target === 'mac' && typeof action.text === 'string' && action.text.length >= 1 && action.text.length <= 400 && !/[\u0000-\u001f\u007f\u200B-\u200F\u202A-\u202E\u2060-\u206F]/.test(action.text);
  }
  if (!PHONE_ACTIONS.has(String(action.kind))) return false;
  if (Object.keys(action).some((k) => !['kind', 'target', 'text'].includes(k))) return false;
  if (typeof action.target !== 'string' || !/^\+?[0-9]{5,15}$/.test(action.target)) return false;
  if (typeof action.text !== 'string' || action.text.length < 1 || action.text.length > 400 || /[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/.test(action.text)) return false;
  return true;
}

/** Single-use capability for one server-produced, non-private-classified public reply. No arbitrary TTS text. */
export class PublicSpeechTokens {
  private tokens = new Map<string, { device: string; text: string; exp: number }>();
  issue(device: string, text: string, now = Date.now()): string {
    for (const [id, entry] of this.tokens) if (entry.exp <= now) this.tokens.delete(id);
    if (this.tokens.size >= 256) this.tokens.delete(this.tokens.keys().next().value!);
    const id = crypto.randomBytes(24).toString('base64url');
    this.tokens.set(id, { device, text: text.slice(0, 600), exp: now + 60_000 }); return id;
  }
  consume(device: string, id: string, now = Date.now()): string | null {
    const entry = this.tokens.get(id);
    if (!entry || entry.device !== device || entry.exp <= now) return null;
    this.tokens.delete(id); return entry.text;
  }
}

export interface VoiceRouteOptions {
  stateDir: string;
  brain: BrainDeps;
  /** Luna (Codex) for screen steps Clef is unsure about. Never a free-model fallback (PHONE-CONTROL.md D1). */
  screenComplete?: () => Completer | null;
  /** Clef-flash, then Clef 27B, for screen steps (Owner, Oct 6: Clef as much as possible). */
  screenClef?: ScreenClef;
  /** Off unless voice-config.json has "screenControl": true. */
  screenControl?: () => boolean;
  /** Tool-less model for screen steps. */
  complete: () => Completer | null;
  transcribe?: (audio: Buffer) => Promise<string>;
  /** Mac-side alert (notification); best effort. */
  alert?: (title: string, body: string) => void;
  pairCodes: VoicePairCodes;
  /** Full Aside tasks in locked sessions (agent.ts). Absent = feature off. */
  agent?: VoiceAgent;
  /** Test seams. */
  revokedSerials?: () => Promise<Set<string>>;
  rootSpkiSha256?: string[];
  now?: () => number;
}

declare module 'fastify' {
  interface FastifyRequest {
    voiceDevice?: VoiceDevice;
    rawBody?: Buffer;
  }
}

export async function voiceRoutes(app: FastifyInstance, opts: VoiceRouteOptions): Promise<void> {
  const registry = new DeviceRegistry(opts.stateDir);
  const audit = new AuditLog(opts.stateDir);
  const nonces = new NonceCache(undefined, path.join(opts.stateDir, 'voice-nonces.json'));
  const limiter = new ActionLimiter(5, 30, path.join(opts.stateDir, 'voice-action-limits.json'));
  const speechTokens = new PublicSpeechTokens();
  const pending = new Map<string, PendingPair>();
  const badSigs: number[] = [];
  const now = () => opts.now?.() ?? Date.now();
  const alert = (t: string, b: string) => {
    try {
      opts.alert?.(t, b);
    } catch {
      /* best effort */
    }
  };

  // Raw bodies are needed to check signatures; this parser only applies inside this plugin.
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 256 * 1024 }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      const e = new Error('bad_json') as Error & { statusCode: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as Buffer;
    done(null, body);
  });

  const signed = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      request.voiceDevice = verifySignedRequest(
        { method: request.method, url: request.url, headers: request.headers, rawBody: request.rawBody ?? Buffer.alloc(0) },
        registry,
        nonces,
        now(),
      );
    } catch (err) {
      const code = err instanceof SignatureError ? err.code : 'invalid';
      audit.write({ kind: 'auth.fail', ok: false, detail: `${code} ${request.method} ${request.url.split('?')[0]}` });
      const t = now();
      badSigs.push(t);
      while (badSigs.length && t - badSigs[0] > 600_000) badSigs.shift();
      if (badSigs.length === 3) alert('Hey Aside', 'Three rejected requests in 10 minutes. Someone may be probing the voice API.');
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  // ------------------------------------------------------------- pairing

  app.post('/api/voice/pair/start', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const code = String((request.body as { code?: unknown })?.code ?? '');
    if (!opts.pairCodes.consume(code, now())) {
      audit.write({ kind: 'pair.code_rejected', ok: false });
      return reply.code(401).send({ error: 'bad_code' });
    }
    const id = crypto.randomBytes(16).toString('base64url');
    const challenge = crypto.randomBytes(32);
    pending.set(id, { challenge, exp: now() + 5 * 60_000 });
    return { pairId: id, challenge: challenge.toString('base64') };
  });

  app.post('/api/voice/pair/finish', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const b = (request.body ?? {}) as {
      pairId?: string;
      name?: string;
      requestKey?: string;
      actionKey?: string;
      requestChain?: string[];
      actionChain?: string[];
    };
    const p = pending.get(String(b.pairId ?? ''));
    pending.delete(String(b.pairId ?? ''));
    if (!p || p.exp < now()) return reply.code(401).send({ error: 'pairing_expired' });
    const cfg = readVoiceConfig(opts.stateDir);
    try {
      const revoked = await (opts.revokedSerials ?? (() => fetchRevokedSerials()))();
      const common = {
        challenge: p.challenge,
        expectedPackage: cfg.packageName,
        expectedSigningDigest: cfg.signingCertSha256,
        revokedSerials: revoked,
        rootSpkiSha256: opts.rootSpkiSha256,
        now: now(),
      };
      const reqKey = Buffer.from(String(b.requestKey ?? ''), 'base64');
      const actKey = Buffer.from(String(b.actionKey ?? ''), 'base64');
      const f1 = verifyAttestation(b.requestChain ?? [], reqKey, { ...common, role: 'request' });
      verifyAttestation(b.actionChain ?? [], actKey, { ...common, role: 'action' });
      const dev = registry.add(
        {
          name: String(b.name ?? 'Phone').replace(/[^\w .-]/g, '').slice(0, 40) || 'Phone',
          requestKey: reqKey.toString('base64'),
          actionKey: actKey.toString('base64'),
          securityLevel: f1.securityLevel,
        },
        cfg.maxDevices,
      );
      audit.write({ kind: 'pair.ok', deviceId: dev.id, ok: true, detail: `${dev.name} ${dev.securityLevel}` });
      alert('Hey Aside', `A phone was paired (${dev.name}). If this wasn't you, run the kill switch.`);
      return { deviceId: dev.id, securityLevel: dev.securityLevel };
    } catch (err) {
      const code = err instanceof AttestationError ? err.code : err instanceof Error ? err.message : 'failed';
      audit.write({ kind: 'pair.rejected', ok: false, detail: code });
      return reply.code(403).send({ error: 'attestation_failed', reason: code });
    }
  });

  // ------------------------------------------------------------- signed routes

  app.get('/api/voice/status', { preHandler: signed }, async (request) => ({
    ok: true,
    device: { id: request.voiceDevice!.id, name: request.voiceDevice!.name },
    time: new Date(now()).toISOString(),
  }));

  app.post('/api/voice/turn', { preHandler: signed, config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async (request) => {
    const b = (request.body ?? {}) as { text?: unknown; history?: unknown; location?: unknown; screen?: unknown };
    const text = typeof b.text === 'string' ? b.text : '';
    const history = Array.isArray(b.history)
      ? (b.history as Array<{ q?: unknown; a?: unknown }>).slice(-3).map((h) => ({ q: String(h.q ?? '').slice(0, 400), a: String(h.a ?? '').slice(0, 600) }))
      : [];
    // Phone's rounded location when it sent one, else the Mac's area-level home setting.
    const location = coarseLocation(b.location) ?? readVoiceConfig(opts.stateDir).homeLocation;
    const started = now();
    const screen = typeof b.screen === 'string' ? b.screen.slice(0, 6000) : null;
    const taskKind = opts.agent && !screen && text.length <= 400 ? classifyTask(text) : null;
    if (opts.agent && taskKind === 'act') {
      // Never starts here: the phone must come back with a fingerprint-signed ticket for this exact text.
      const say = 'I can do that on your Mac. Approve it with your fingerprint first.';
      audit.write({ kind: 'turn.approve', deviceId: request.voiceDevice!.id, tier: 'C', ok: true, detail: `${now() - started}ms` });
      return { lane: 'approve', say, detail: null, private: true, sources: [], handoff: null, ui: null,
        approval: { kind: 'agent.task', target: 'mac', text, limits: opts.agent.limits('act'), readyInMin: opts.agent.readyIn('act') },
        speechToken: speechTokens.issue(request.voiceDevice!.id, say, now()) };
    }
    if (opts.agent && taskKind === 'research') {
      const t = await opts.agent.start('research', text);
      if ('taskId' in t) {
        const say = 'On it. I’m researching that on your Mac.';
        audit.write({ kind: 'turn.task', deviceId: request.voiceDevice!.id, tier: 'B', ok: true, detail: 'research' });
        return { lane: 'task', say, detail: null, private: true, sources: [], handoff: null, ui: null, taskId: t.taskId,
          speechToken: speechTokens.issue(request.voiceDevice!.id, say, now()) };
      }
      // No locked researcher ready: answer through the normal tool-less lanes instead.
    }
    const r = await think({ text, history, location, screen }, opts.brain);
    audit.write({
      kind: `turn.${r.lane}`,
      deviceId: request.voiceDevice!.id,
      tier: r.private ? 'B' : 'A',
      ok: true,
      detail: `${now() - started}ms`,
    });
    // Any server-written reply can be spoken by Ryan; the phone decides whether to use it (Owner chose Ryan for all, Oct 5).
    return { ...r, speechToken: !screen ? speechTokens.issue(request.voiceDevice!.id, r.say, now()) : null };
  });

  app.get('/api/voice/task/:id', { preHandler: signed, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? '');
    const st = /^[a-f0-9]{24}$/.test(id) ? opts.agent?.status(id) ?? null : null;
    if (!st) return reply.code(404).send({ error: 'unknown_task' });
    const speak = st.state !== 'running' && st.say ? speechTokens.issue(request.voiceDevice!.id, st.say, now()) : null;
    return { ...st, speechToken: speak };
  });

  app.post('/api/voice/task/:id/stop', { preHandler: signed }, async (request) => {
    const id = String((request.params as { id?: string }).id ?? '');
    const ok = /^[a-f0-9]{24}$/.test(id) && Boolean(opts.agent?.stop(id));
    audit.write({ kind: 'task.stop', deviceId: request.voiceDevice!.id, ok, detail: '' });
    return { ok };
  });

  app.post('/api/voice/tts', { preHandler: signed, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = request.body as { token?: unknown; phrase?: unknown };
    const token = String(body?.token ?? '');
    // Short confirmations the phone writes itself ("Flashlight on.", "It's 9:14 PM.") from the
    // hardware-paired device only; capped and plain text so the Mac is not a general TTS relay.
    const phrase = typeof body?.phrase === 'string' && body.phrase.length <= 200 && /^[\p{L}\p{N} .,:;'’!?%°&()\-]+$/u.test(body.phrase) ? body.phrase : null;
    const text = phrase ?? speechTokens.consume(request.voiceDevice!.id, token, now());
    if (!text) return reply.code(403).send({ error: 'speech_token_required' });
    try {
      const mp3 = await synthesize(text);
      return reply.header('cache-control', 'no-store').type('audio/mpeg').send(mp3);
    } catch (err) {
      // 503 (never 502/530: the front door would read those as "Mac offline").
      return reply.code(503).send({ error: 'tts_unavailable', reason: err instanceof TtsError ? err.code : 'error' });
    }
  });

  app.post('/api/voice/stt', { preHandler: signed, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!opts.transcribe) return reply.code(503).send({ error: 'stt_unavailable' });
    const audio = request.rawBody ?? Buffer.alloc(0);
    if (audio.length < 1000) return reply.code(400).send({ error: 'too_short' });
    try {
      return { text: (await opts.transcribe(audio)).slice(0, 2000) };
    } catch {
      return reply.code(503).send({ error: 'stt_failed' });
    }
  });

  app.post('/api/voice/screen/step', { preHandler: signed, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!opts.screenControl?.()) return reply.code(403).send({ error: 'screen_control_off' });
    const complete = opts.screenComplete?.() ?? null;
    if (!complete && !opts.screenClef) return reply.code(503).send({ error: 'model_unavailable' });
    const b = request.body as ScreenStepInput;
    if (!b || typeof b.goal !== 'string' || !Array.isArray(b.elements) || !b.app) return reply.code(400).send({ error: 'bad_request' });
    if (!P1_APPS.has(String(b.app.pkg ?? ''))) {
      audit.write({ kind: 'screen.refused', deviceId: request.voiceDevice!.id, tier: 'D', ok: false, detail: String(b.app.pkg ?? '').slice(0, 80) });
      return reply.code(403).send({ error: 'app_not_allowed' });
    }
    const input: ScreenStepInput = {
      goal: b.goal.slice(0, 300),
      app: { pkg: String(b.app.pkg ?? '').slice(0, 120), label: String(b.app.label ?? '').slice(0, 60) },
      elements: b.elements.slice(0, 150).map((e) => ({
        i: Number(e.i),
        cls: String(e.cls ?? '').slice(0, 30),
        text: String(e.text ?? '').slice(0, 200),
        desc: String(e.desc ?? '').slice(0, 200),
        click: e.click === true,
        edit: e.edit === true,
        scroll: e.scroll === true,
        password: e.password === true,
        id: String(e.id ?? '').slice(0, 80),
        safe: e.safe === true,
        link: e.link === true,
        selected: e.selected === true,
      })),
      done: Array.isArray(b.done) ? b.done.slice(-10).map((d) => String(d).slice(0, 160)) : [],
      step: Number.isInteger(b.step) ? b.step : 0,
    };
    const action = await decideStep(input, { clef: opts.screenClef, complete }, P1_POLICY).catch((err: unknown) => {
      const m = String((err as Error)?.message ?? '');
      const quota = /usage limit|429/i.test(m);
      const reset = m.match(/reset after (\d+)\s*m/i)?.[1];
      return { type: 'fail' as const, say: quota ? `Phone control is paused: your Codex limit resets in about ${reset ?? 'a few'} minutes.` : 'The model did not answer.', commit: false as const, ...(quota ? { quota: true } : {}) };
    });
    const by = (action as { by?: string }).by ?? 'luna';
    audit.write({ kind: `screen.${action.type}`, deviceId: request.voiceDevice!.id, tier: action.commit ? 'C' : 'B', ok: true, detail: `${input.app.pkg} step ${input.step} by ${by} ${(action as { trail?: string }).trail ?? ''}`.slice(0, 300) });
    return action;
  });

  /** The Mac co-signs every Tier C action: fingerprint ticket + limits + not revoked. */
  app.post('/api/voice/action/approve', { preHandler: signed }, async (request, reply) => {
    const dev = request.voiceDevice!;
    const t = (request.body as { ticket?: ActionTicket })?.ticket as ActionTicket;
    let action: Record<string, unknown>;
    try {
      action = verifyTicket(dev, t, nonces, now());
    } catch (err) {
      const code = err instanceof SignatureError ? err.code : 'bad_ticket';
      audit.write({ kind: 'action.rejected', deviceId: dev.id, tier: 'C', ok: false, detail: code });
      alert('Hey Aside', `An action ticket was rejected (${code}).`);
      return reply.code(403).send({ error: 'ticket_rejected', reason: code });
    }
    const kind = String(action.kind ?? '');
    if (!validPhoneAction(action)) {
      audit.write({ kind: 'action.refused', deviceId: dev.id, tier: 'D', ok: false, detail: kind.slice(0, 40) });
      return reply.code(403).send({ error: 'not_allowed' });
    }
    if (!limiter.allow(now())) {
      audit.write({ kind: 'action.limited', deviceId: dev.id, tier: 'C', ok: false, detail: kind });
      alert('Hey Aside', 'Action limit reached. Further actions are blocked for now.');
      return reply.code(429).send({ error: 'limit' });
    }
    audit.write({ kind: 'action.approved', deviceId: dev.id, tier: 'C', ok: true, detail: `${kind} hash=${shaAction(action)}` });
    if (kind === 'agent.task') {
      if (!opts.agent) return reply.code(503).send({ error: 'tasks_off' });
      const t = await opts.agent.start('act', String(action.text));
      if ('taskId' in t) return { ok: true, taskId: t.taskId };
      return reply.code(503).send({ error: t.error, readyInMin: 'readyInMin' in t ? t.readyInMin : null });
    }
    return { ok: true, undoMs: 0 }; // Draft/dial only; no automatic sends.
  });

  /** The phone reports the outcome (sent, cancelled during undo, failed). */
  app.post('/api/voice/action/result', { preHandler: signed }, async (request) => {
    const b = (request.body ?? {}) as { kind?: unknown; outcome?: unknown };
    audit.write({ kind: `action.${String(b.outcome ?? 'unknown').slice(0, 20)}`, deviceId: request.voiceDevice!.id, tier: 'C', ok: true, detail: String(b.kind ?? '').slice(0, 40) });
    return { ok: true };
  });

  /** Duress phrase heard: lock everything, quietly. */
  app.post('/api/voice/duress', { preHandler: signed }, async (request) => {
    const n = registry.revokeAll('duress');
    audit.write({ kind: 'duress', deviceId: request.voiceDevice!.id, tier: 'D', ok: true, detail: `revoked ${n}` });
    alert('Hey Aside: duress', 'The duress phrase was used. All phones are unpaired.');
    return { ok: true };
  });

  app.post('/api/voice/revoke-self', { preHandler: signed }, async (request) => {
    registry.revoke(request.voiceDevice!.id, 'phone_request');
    audit.write({ kind: 'revoke.self', deviceId: request.voiceDevice!.id, ok: true });
    return { ok: true };
  });

  app.get('/api/voice/audit', { preHandler: signed }, async (request) => ({
    entries: audit.recent(200).filter((e) => e.deviceId === request.voiceDevice!.id).slice(-40).map((e) => ({ at: e.at, kind: e.kind, tier: e.tier, ok: e.ok })),
  }));
}
