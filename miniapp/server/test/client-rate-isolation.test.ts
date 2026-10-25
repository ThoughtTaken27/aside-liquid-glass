import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/app.js';
import { mintToken } from '../src/auth.js';
import { loadConfig, loadOrCreateJwtSecret } from '../src/config.js';
import { makeTestEnv, OWNER_ID, type TestEnv } from './helpers.js';
let env: TestEnv, app: FastifyInstance, secret: string;
beforeEach(async () => { env = makeTestEnv(); const config = loadConfig(); secret = loadOrCreateJwtSecret(config.secretPath); ({ app } = await buildServer(config, { jwtSecret: secret })); await app.ready(); });
afterEach(async () => { await app.close(); env.cleanup(); });
const device = (sub: string) => ({ authorization: `Bearer ${mintToken(secret, { uid: OWNER_ID, sub })}` });
describe('loopback transport is not a single client quota', () => {
 it('anonymous exhaustion cannot deny a signed phone, health, or the app shell', async () => {
  let code = 0; for (let i = 0; i < 125; i++) code = (await app.inject({ url: '/api/status' })).statusCode;
  expect(code).toBe(429);
  expect((await app.inject({ url: '/api/status', headers: device('phone') })).statusCode).toBe(200);
  expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
  expect((await app.inject({ url: '/app' })).statusCode).not.toBe(429);
 });
 it('a signed desktop quota cannot exhaust a separately signed phone', async () => {
  const desk = device('desk'); let code = 0;
  for (let i = 0; i < 601; i++) code = (await app.inject({ url: '/api/status', headers: desk })).statusCode;
  expect(code).toBe(429);
  expect((await app.inject({ url: '/api/status', headers: device('phone') })).statusCode).toBe(200);
 });
 it('rotating junk bearer strings and forwarding headers never creates fresh quotas', async () => {
  let code = 0; for (let i = 0; i < 125; i++) code = (await app.inject({ url: '/api/status', headers: { authorization: `Bearer forged-${i}`, 'x-forwarded-for': `203.0.113.${i}` } })).statusCode;
  expect(code).toBe(429);
 });
 it('a cookie-only installed device has the same signed isolation as a bearer', async () => {
  for (let i = 0; i < 125; i++) await app.inject({ url: '/api/status' });
  const token = mintToken(secret, { uid: OWNER_ID, sub: 'cookie-phone' });
  expect((await app.inject({ url: '/api/status', headers: { cookie: `aside_session=${token}` } })).statusCode).toBe(200);
 });
});
