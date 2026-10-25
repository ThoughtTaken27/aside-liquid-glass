import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { voicePairPage, VOICE_PAIR_CSP } from '../src/voice/pair-page.js';
import { buildPairServer } from '../src/pair.js';

describe('private Mac voice pairing page', () => {
  it('only interpolates an eight-digit code and integer expiry', () => {
    expect(voicePairPage('00000000', 1000)).toContain('0000 0000');
    for (const bad of ['</script>', '1234567', '123456789', '<img src=x>', '1234 5678']) expect(() => voicePairPage(bad)).toThrow();
    expect(() => voicePairPage('00000000', NaN)).toThrow();
  });
  it('uses only the exact hashed script, without external requests or embeddable frames', () => {
    const html = voicePairPage('00000000', 1000); const code = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    expect(VOICE_PAIR_CSP).toContain(`script-src 'sha256-${createHash('sha256').update(code).digest('base64')}'`);
    expect(VOICE_PAIR_CSP).toContain("connect-src 'none'"); expect(VOICE_PAIR_CSP).toContain("frame-ancestors 'none'");
    expect(html).not.toMatch(/<script[^>]+src|<link|<img|fetch\(|XMLHttpRequest|https?:\/\//);
  });
  it('does not announce a countdown every second and explains the activation boundary', () => {
    const html = voicePairPage('00000000'); expect(html).toContain('aria-live="off"'); expect(html).toContain('Pairing does not turn on the microphone'); expect(html).toContain('default assistant'); expect(html).toContain('screen control'); expect(html).toContain('prefers-reduced-motion');
  });
  it('retains loopback and exact-host checks and private response headers', async () => {
    let issued = 0; const app = buildPairServer({ appPort: 9000, issuePairingCode: () => 'fixture', issueVoiceCode: () => { issued++; return '00000000'; } });
    try {
      const external = await app.inject({ url: '/voice', remoteAddress: '192.0.2.10', headers: { host: 'localhost:9001' } }); expect(external.statusCode).toBe(403);
      const rebound = await app.inject({ url: '/voice', remoteAddress: '127.0.0.1', headers: { host: 'evil.example:9001' } }); expect(rebound.statusCode).toBe(403); expect(issued).toBe(0);
      const good = await app.inject({ url: '/voice', remoteAddress: '127.0.0.1', headers: { host: 'localhost:9001' } });
      expect(good.statusCode).toBe(200); expect(issued).toBe(1); expect(good.headers['cache-control']).toBe('no-store'); expect(good.headers['content-security-policy']).toBe(VOICE_PAIR_CSP); expect(good.headers['x-frame-options']).toBe('DENY'); expect(good.headers['referrer-policy']).toBe('no-referrer');
    } finally { await app.close(); }
  });
});
