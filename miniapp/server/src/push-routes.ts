import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PhonePush, PushPreferences } from './push.js';
import { isValidSessionId } from './sessions.js';
export function registerPhonePushRoutes(app: FastifyInstance, deps: {
  push: PhonePush; auth: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  reply: (id: string, text: string) => Promise<void>;
}) {
  const auth = { preHandler: deps.auth };
  app.get('/api/notifications/config', auth, async () => ({ publicKey: deps.push.publicKey }));
  // Which setup step failed on the phone, so "it doesn't work" has a cause in the log. Bounded strings only; no tokens or endpoints.
  app.post('/api/notifications/diagnostic', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const field = (k: string, n: number) => (typeof b[k] === 'string' ? (b[k] as string).slice(0, n) : typeof b[k] === 'boolean' ? String(b[k]) : '');
    req.log.warn({ notificationSetup: { step: field('step', 24), error: field('error', 60), detail: field('detail', 300), permission: field('permission', 16), standalone: field('standalone', 5), controller: field('controller', 5) } }, 'phone notification setup failed');
    return { ok: true };
  });
  app.post('/api/notifications/subscribe', auth, async (req, res) => {
    const body = req.body as { subscription?: unknown; preferences?: Partial<PushPreferences> } | null;
    try { return deps.push.subscribe(body?.subscription, body?.preferences); }
    catch { return res.code(400).send({ error: 'invalid_subscription' }); }
  });
  app.get('/api/notifications/devices/:device', auth, async (req, res) => {
    const d = deps.push.get((req.params as { device: string }).device);
    return d ?? res.code(404).send({ error: 'device_not_found' });
  });
  app.patch('/api/notifications/devices/:device', auth, async (req, res) => {
    try {
      const d = deps.push.update((req.params as { device: string }).device, (req.body ?? {}) as Partial<PushPreferences>);
      return d ?? res.code(404).send({ error: 'device_not_found' });
    } catch { return res.code(400).send({ error: 'invalid_preferences' }); }
  });
  app.delete('/api/notifications/devices/:device', auth, async req => { deps.push.remove((req.params as { device: string }).device); return { ok: true }; });
  app.post('/api/notifications/devices/:device/test', { ...auth, config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req, res) => {
    const id = (req.params as { device: string }).device;
    if (!deps.push.get(id)) return res.code(404).send({ error: 'device_not_found' });
    return deps.push.deliver({ kind: 'test' }, id);
  });
  // Idempotent within this process. The worker never silently retries uncertain sends.
  const replies = new Map<string, { key: string; result: Promise<void> }>();
  app.post('/api/notifications/reply', { ...auth, config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (req, res) => {
    const b = (req.body ?? {}) as { sessionId?: unknown; text?: unknown; requestId?: unknown };
    if (!isValidSessionId(b.sessionId) || b.sessionId.startsWith('-') || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 32_000 || typeof b.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(b.requestId)) return res.code(400).send({ error: 'invalid_reply' });
    const key = `${b.sessionId}\n${b.text}`;
    const old = replies.get(b.requestId);
    if (old && old.key !== key) return res.code(409).send({ error: 'reply_id_conflict' });
    const result = old?.result ?? deps.reply(b.sessionId, b.text.trim());
    if (!old) {
      replies.set(b.requestId, { key, result });
      while (replies.size > 500) replies.delete(replies.keys().next().value!);
    }
    try { await result; return { accepted: true }; }
    catch (e) { replies.delete(b.requestId); return res.code(409).send({ error: 'reply_not_accepted', reason: 'Open the conversation to reply.' }); }
  });
}
