/** Authenticated, no-store control/recall API. No capture, models or actions here. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ContextMemory, ContextMemoryError, canonicalDocument } from './context-memory.js';
import type { ContextSource } from './context.js';
import type { RawItem } from './next.js';
import type { MemorySpace } from './context-memory.js';
export interface ContextRouteOptions {
  memory: ContextMemory;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  refresh: () => Promise<unknown>;
  globalPaused: () => boolean;
  resolveTask?: (id: string) => RawItem | null;
}
export async function contextRoutes(app: FastifyInstance, opts: ContextRouteOptions): Promise<void> {
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store, max-age=0');
    reply.header('Pragma', 'no-cache'); reply.header('X-Content-Type-Options', 'nosniff');
  });
  app.addHook('preHandler', opts.requireAuth);
  const guarded = async (reply: FastifyReply, work: () => unknown) => {
    try { return await work(); }
    catch (error) {
      return reply.code(error instanceof ContextMemoryError ? error.status : 503).send({ error: error instanceof ContextMemoryError ? error.code : 'context_unavailable' });
    }
  };
  const status = () => ({ ...opts.memory.status(), nextPaused: opts.globalPaused() });
  app.get('/', async (_request, reply) => guarded(reply, status));
  app.post('/settings', async (request, reply) => guarded(reply, () => ({ ...opts.memory.configure(request.body), nextPaused: opts.globalPaused() })));
  app.get('/history', async (request, reply) => guarded(reply, () => {
    const q = request.query as Record<string, string>;
    if (Object.keys(q).some(k => !['space', 'day', 'q', 'source', 'offset', 'limit', 'window'].includes(k))) throw new ContextMemoryError('invalid_context_query');
    for (const k of ['offset', 'limit']) if (q[k] !== undefined && !/^\d{1,4}$/.test(q[k])) throw new ContextMemoryError('invalid_context_query');
    return opts.memory.history({
      ...(q.space !== undefined ? { space: q.space as MemorySpace } : {}),
      ...(q.day !== undefined ? { day: q.day } : {}), ...(q.q !== undefined ? { q: q.q } : {}),
      ...(q.source !== undefined ? { source: q.source as ContextSource } : {}),
      ...(q.offset !== undefined ? { offset: Number(q.offset) } : {}), ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
      ...(q.window !== undefined ? { window: q.window as 'ten-minutes' | 'six-hours' } : {}),
    });
  }));
  app.post('/refresh', async (_request, reply) => guarded(reply, async () => {
    if (opts.globalPaused()) return reply.code(423).send({ error: 'next_paused' });
    if (opts.memory.status().state !== 'ready') return reply.code(403).send({ error: 'context_off_or_paused' });
    await opts.refresh(); return status();
  }));
  app.post('/forget', async (request, reply) => guarded(reply, () => {
    const b = request.body as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length !== 3 || !Object.keys(b).every(k => ['target', 'expectedRevision', 'confirmation'].includes(k)) || b.confirmation !== 'forget-local-context' || !Number.isSafeInteger(b.expectedRevision)) return reply.code(400).send({ error: 'forget_confirmation_required' });
    return { ...opts.memory.forget(b.target, b.expectedRevision as number), nextPaused: opts.globalPaused() };
  }));
  app.get('/document', async (request, reply) => guarded(reply, () => {
    const q = request.query as Record<string, string>;
    if (Object.keys(q).length !== 1 || typeof q.taskId !== 'string') throw new ContextMemoryError('invalid_document_link');
    const view = opts.memory.document(q.taskId); return { ...view, enabled: view.enabled && !opts.globalPaused(), available: Boolean(opts.resolveTask) };
  }));
  app.post('/document', async (request, reply) => guarded(reply, () => {
    const p = request.body as Record<string, unknown> | null;
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length !== 4 || Object.keys(p).some(k => !['taskId', 'url', 'expectedRevision', 'confirmation'].includes(k)) || typeof p.taskId !== 'string' || !/^[\w:.-]{1,140}$/.test(p.taskId) || !Number.isSafeInteger(p.expectedRevision) || p.confirmation !== (p.url === null ? 'unlink-document-context' : 'link-document-metadata') || (p.url !== null && !canonicalDocument(p.url))) throw new ContextMemoryError('invalid_document_link');
    if (p.url !== null) {
      if (opts.globalPaused()) return reply.code(423).send({ error: 'next_paused' });
      const status = opts.memory.status();
      if (status.revision !== p.expectedRevision) throw new ContextMemoryError('revision_changed', 409);
      const host = new URL(canonicalDocument(p.url)!.url).hostname;
      if (status.state !== 'ready' || !status.preferences.sources.includes('work-trail') || status.preferences.excludedHosts.some(h => host === h || host.endsWith('.' + h))) throw new ContextMemoryError('context_source_required', 403);
    }
    const task = p.url === null ? null : opts.resolveTask?.(p.taskId) ?? null;
    return { ...opts.memory.linkDocument(p, task), available: Boolean(opts.resolveTask) };
  }));
  // Retention applies even while collection is paused/off; no source read here.
  const expiry = setInterval(() => { try { opts.memory.status(); } catch { /* Fail closed; API exposes unavailable, never repairs/reset data. */ } }, 15 * 60_000);
  expiry.unref(); app.addHook('onClose', async () => { clearInterval(expiry); });
}
