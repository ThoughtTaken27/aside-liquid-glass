import { describe, expect, it } from 'vitest';
import { extractPairingKey } from './PairPrompt';

// A 32-char base64url code, the shape PairingCodeStore.issues.
const CODE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

describe('extractPairingKey', () => {
  it('takes the code out of a full pairing link', () => {
    expect(extractPairingKey(`https://mac.tail1234.ts.net/app#pair=${CODE}`)).toBe(CODE);
  });

  it('accepts the code on its own', () => {
    expect(extractPairingKey(CODE)).toBe(CODE);
  });

  it('accepts a query-string form as well as a fragment', () => {
    expect(extractPairingKey(`https://mac.ts.net/app?pair=${CODE}`)).toBe(CODE);
  });

  // Copying off a terminal or out of a chat message routinely brings
  // whitespace with it, and a phone keyboard adds a trailing space of its own.
  it('ignores surrounding whitespace', () => {
    expect(extractPairingKey(`   ${CODE}\n`)).toBe(CODE);
  });

  it('returns null for text with no code in it', () => {
    expect(extractPairingKey('https://mac.ts.net/app')).toBeNull();
    expect(extractPairingKey('')).toBeNull();
    expect(extractPairingKey('   ')).toBeNull();
  });

  it('rejects codes that are too short to be real', () => {
    expect(extractPairingKey('abc123')).toBeNull();
  });
});
