/**
 * Session tokens. A validated initData launch mints a 24h HS256 JWT; every
 * other REST route and the WebSocket require it.
 */
import jwt from 'jsonwebtoken';

export const TOKEN_TTL_SECONDS = 24 * 60 * 60;

export interface SessionClaims {
  sub: string;
  uid: number;
  name?: string;
}

export function mintToken(
  secret: string,
  claims: SessionClaims,
  ttlSeconds = TOKEN_TTL_SECONDS,
): string {
  return jwt.sign({ uid: claims.uid, name: claims.name }, secret, {
    algorithm: 'HS256',
    subject: claims.sub,
    expiresIn: ttlSeconds,
  });
}

export type TokenFailure = 'missing' | 'invalid' | 'expired' | 'forbidden';

export class TokenError extends Error {
  constructor(readonly code: TokenFailure) {
    super(code);
    this.name = 'TokenError';
  }
}

/**
 * Verify a bearer token and re-check the allowlist, so revoking the owner
 * id in config takes effect without waiting for tokens to expire.
 */
export function verifyToken(
  token: string | undefined,
  secret: string,
  allowedUserId: number,
): SessionClaims {
  if (!token) throw new TokenError('missing');
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as
      jwt.JwtPayload;
  } catch (err) {
    if ((err as Error).name === 'TokenExpiredError') {
      throw new TokenError('expired');
    }
    throw new TokenError('invalid');
  }
  const uid = Number(payload.uid);
  if (!Number.isFinite(uid)) throw new TokenError('invalid');
  if (uid !== allowedUserId) throw new TokenError('forbidden');
  return { sub: String(payload.sub || uid), uid, name: payload.name as string };
}

/** Pull a bearer token out of an Authorization header. */
export function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

/*
 * ---------------------------------------------------------------------------
 * Durable sessions for the installed app
 * ---------------------------------------------------------------------------
 *
 * The standalone app originally kept its only copy of the token in
 * `localStorage`. That is a single point of failure with no recovery path:
 * Android Chrome evicts storage for origins it has not marked persistent,
 * and a QR scanned in one browser stores the token somewhere the installed
 * app cannot read. Either way the app's only move was to ask for a new
 * pairing link, which is what made re-pairing feel constant.
 *
 * A cookie fixes both. It is written by the server rather than by script,
 * it is not reachable from JS at all (so it cannot be cleared by a stray
 * `localStorage.clear()`), it rides on the WebSocket upgrade for free, and
 * it is scoped to the origin instead of to whatever browser happened to
 * open the link. The token stays the second lock on a door already inside
 * the tailnet, so a long lifetime here is the right trade.
 */

export const SESSION_COOKIE = 'aside_session';

/** 90 days, matching the pairing token the installed app was promised. */
export const LONG_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Re-issue once a session drops under 60 days left.
 *
 * The point is that regular use should silently renew: open the app inside
 * any 30-day window and the clock resets, so an actively used phone never
 * reaches an expiry it could be surprised by. A phone left in a drawer for
 * three months still ages out, which is the property that made the finite
 * TTL worth having.
 */
export const REFRESH_BELOW_SECONDS = 60 * 24 * 60 * 60;

/** Read one cookie out of a raw Cookie header. */
export function cookieFrom(
  header: string | undefined,
  name: string = SESSION_COOKIE,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return undefined;
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed value is treated as absent rather than throwing on a
      // request that might otherwise have authenticated by bearer.
      return undefined;
    }
  }
  return undefined;
}

/**
 * Build the Set-Cookie value for a session token.
 *
 * `Secure` is conditional rather than always-on because the same server is
 * reached two ways: over Tailscale HTTPS from the phone, and over plain
 * loopback while testing on the Mac. Marking the loopback cookie Secure
 * would leave a cookie the client refuses to send back.
 */
export function sessionCookie(
  token: string,
  ttlSeconds: number = LONG_TOKEN_TTL_SECONDS,
  secure = true,
): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    // Lax rather than Strict: the app is opened by a launch navigation from
    // the home screen, and Strict withholds the cookie on exactly that hop.
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttlSeconds)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Set-Cookie value that deletes the session cookie. */
export function clearSessionCookie(secure = true): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Seconds of life left in a token, without verifying it.
 *
 * Used only to decide whether to renew; anything that grants access still
 * goes through `verifyToken`, so an unverified read is safe here.
 */
export function secondsRemaining(token: string | undefined): number {
  if (!token) return 0;
  try {
    const decoded = jwt.decode(token) as jwt.JwtPayload | null;
    if (!decoded || typeof decoded.exp !== 'number') return 0;
    return Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
  } catch {
    return 0;
  }
}
