import { describe, expect, it } from 'vitest';
import { SYNTH_HOST, synthUrl } from '../src/voice/tts.js';

describe('Edge read-aloud endpoint', () => {
  it('synthesizes through api.msedgeservices.com, not the retired speech.platform.bing.com', () => {
    const url = new URL(synthUrl('abc123', 'GEC'));
    expect(SYNTH_HOST).toBe('api.msedgeservices.com');
    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('api.msedgeservices.com');
    expect(url.pathname).toBe('/tts/cognitiveservices/websocket/v1');
    expect(url.searchParams.get('Ocp-Apim-Subscription-Key')).toMatch(/^[0-9A-F]{32}$/);
    expect(url.searchParams.get('ConnectionId')).toBe('abc123');
    expect(url.searchParams.get('Sec-MS-GEC')).toBe('GEC');
    expect(url.searchParams.has('TrustedClientToken')).toBe(false);
  });
});
