import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { bearerFrom, cookieFrom, verifyToken } from './auth.js';

/** Forwarded addresses and unsigned strings never create a quota identity. */
export function clientRateKey(request: FastifyRequest, secret: string, ownerId: number): string {
  const path = request.url.split('?')[0];
  const scope = path === '/api/health' ? 'health' : path.startsWith('/api/') ? 'api' : 'assets';
  const token = bearerFrom(request.headers.authorization) ?? cookieFrom(request.headers.cookie);
  if (token && token.length <= 8192) {
    try {
      verifyToken(token, secret, ownerId);
      // Never place a credential itself in limiter state or logs.
      return `owner:${createHash('sha256').update(token).digest('base64url')}:${scope}`;
    } catch { /* Expired, forged and revoked tokens share the anonymous socket bucket. */ }
  }
  return `anonymous:${request.raw.socket?.remoteAddress || 'unknown'}:${scope}`;
}

/** Finite per-device headroom; explicit auth/write route limits still override this. */
export const clientRateMax = (_request: FastifyRequest, key: string): number =>
  key.startsWith('owner:') ? 600 : 120;
