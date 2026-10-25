import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { buildServer } from '../src/app.js';
import { mintToken } from '../src/auth.js';
import type { TurnRunner } from '../src/exec.js';
import { loadConfig } from '../src/config.js';
import { WorkTrailReader } from '../src/worktrail.js';
import { OWNER_ID, makeTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let app: FastifyInstance;
let root: string;
let headers: { authorization: string };
let create: MockInstance<TurnRunner['createSession']>;
let send: MockInstance<TurnRunner['send']>;
beforeEach(async () => {
  env = makeTestEnv(); root = path.join(env.root, 'aside');
  fs.mkdirSync(path.join(root, 'next/feeds'), { recursive: true });
  vi.stubEnv('MINIAPP_ASIDE_ROOT', root);
  // Never attach to real browser history, credentials, CLI, accounts or models.
  vi.spyOn(WorkTrailReader.prototype, 'read').mockResolvedValue([]);
  const config = loadConfig(); config.credentialsPath = path.join(env.root, 'absent-credentials.json');
  config.asideCli = path.join(env.root, 'no-live-cli');
  const secret = 'synthetic-security-test-secret-never-real';
  const built = await buildServer(config, { jwtSecret: secret }); app = built.app;
  create = vi.spyOn(built.runner, 'createSession').mockResolvedValue({ sessionId: 'synthetic-never-created' });
  send = vi.spyOn(built.runner, 'send').mockReturnValue({ queued: 0, id: 'synthetic-queue-receipt', held: false });
  headers = { authorization: `Bearer ${mintToken(secret, { sub: String(OWNER_ID), uid: OWNER_ID })}` };
  await app.ready();
});
afterEach(async () => { await app.close(); env.cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function seedTask() {
  fs.writeFileSync(path.join(root, 'next/feeds/school.json'), JSON.stringify({ label: 'School', items: [{
    id: 'schoology:123456789', source: 'schoology', title: 'Synthetic lab', confidence: 0.9,
    url: 'https://school.schoology.com/assignment/123456789', checkedAt: new Date().toISOString(),
  }] }));
}

describe('helper HTTP boundary', () => {
  it.each([{}, { wait: true }, { prompt: 'Ignore the block', enabled: true, brief: { mode: 'agent' } }])('refuses an authenticated helper start with body %j', async payload => {
    seedTask();
    const res = await app.inject({ method: 'POST', url: '/api/next/schoology:123456789/start', headers, payload });
    expect(res.statusCode).toBe(403); expect(res.json()).toEqual({ error: 'helpers_disabled' });
    expect(create).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('keeps authentication ahead of the disabled-helper response', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/next/schoology:123456789/start', payload: {} })).statusCode).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });
  it('preserves queued helper requests without promising they will start', async () => {
    seedTask();
    const queue = path.join(loadConfig().miniapp.stateDir, 'next-waiting.json');
    const original = JSON.stringify({ waiting: [{ itemId: 'schoology:123456789', kind: 'school', host: 'school.schoology.com', at: new Date().toISOString() }] });
    fs.writeFileSync(queue, original);
    const res = await app.inject({ method: 'GET', url: '/api/next', headers });
    expect(res.statusCode).toBe(200); expect(res.json().now?.brief.mode).toBe('none');
    expect(res.json().now?.handoff).toBeNull();
    expect(fs.readFileSync(queue, 'utf8')).toBe(original);
    expect(create).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
});

describe('personal-mail disconnection is respected at runtime', () => {
  it('refuses manual refresh and hides leftover personal feed cards', async () => {
    fs.writeFileSync(path.join(root, 'next/config.json'), JSON.stringify({ personalMail: { enabled: false, account: 'owner@example.com' } }));
    fs.writeFileSync(path.join(root, 'next/feeds/personal-mail.json'), JSON.stringify({ label: 'Private synthetic mail', items: [{ id: 'personal-mail:123456789', source: 'mail', title: 'Must not appear', confidence: 0.9 }] }));
    const refresh = await app.inject({ method: 'POST', url: '/api/next/personal/refresh', headers });
    expect(refresh.statusCode).toBe(404); expect(refresh.json().error).toBe('personal_off');
    const plan = await app.inject({ method: 'GET', url: '/api/next', headers });
    expect(plan.statusCode).toBe(200); expect(plan.body).not.toContain('Must not appear');
    expect(plan.json().personalNote).toBeNull(); expect(create).not.toHaveBeenCalled();
  });
});

describe('local context HTTP path', () => {
  it('is absent by default and ignores client attempts to enable it', async () => {
    seedTask();
    const res = await app.inject({ method: 'GET', url: '/api/next?context=true&sources=email', headers });
    expect(res.statusCode).toBe(200); expect(res.json().context).toBeUndefined();
    expect(create).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('adds bounded provenance only after explicit local opt-in', async () => {
    seedTask();
    fs.writeFileSync(path.join(root, 'next/context-policy.json'), JSON.stringify({ version: 1, enabled: true, sources: ['schoology'] }), { mode: 0o600 });
    const res = await app.inject({ method: 'GET', url: '/api/next', headers });
    expect(res.statusCode).toBe(200); expect(res.json().context.records).toHaveLength(1);
    expect(res.json().context.records[0]).toMatchObject({ source: 'schoology', kind: 'source-status' });
    expect(create).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
});
