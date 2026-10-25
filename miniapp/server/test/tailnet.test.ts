import { afterEach, describe, expect, it } from 'vitest';
import { tailnetHost } from '../src/tailnet.js';

afterEach(() => {
  delete process.env.ASIDE_TAILNET_HOST;
});

describe('tailnet hostname override', () => {
  it('normalizes a configured MagicDNS origin without exposing a path', () => {
    process.env.ASIDE_TAILNET_HOST = 'https://mac.example.ts.net/';
    expect(tailnetHost()).toBe('mac.example.ts.net');
  });

  it('ignores an empty override', () => {
    process.env.ASIDE_TAILNET_HOST = '   ';
    expect(tailnetHost()).not.toBe('');
  });
});
