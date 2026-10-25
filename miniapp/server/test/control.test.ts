import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlStore } from '../src/control.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-control-'));
  file = path.join(dir, 'state', 'control.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('ControlStore', () => {
  it('defaults to not paused when the file is missing', () => {
    expect(new ControlStore(file).read()).toEqual({ paused: false, pausedAt: null, reason: null });
  });

  it('pauses and resumes, persisting to disk 0600', () => {
    const c = new ControlStore(file);
    const now = new Date('2026-09-25T17:00:00Z');
    expect(c.set(true, 'odd email', now)).toEqual({ paused: true, pausedAt: now.toISOString(), reason: 'odd email' });
    expect(new ControlStore(file).read()).toEqual({ paused: true, pausedAt: now.toISOString(), reason: 'odd email' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(c.set(false, 'ignored')).toEqual({ paused: false, pausedAt: null, reason: null });
    expect(c.read().paused).toBe(false);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('treats a corrupt or odd file as not paused', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const c = new ControlStore(file);
    fs.writeFileSync(file, '{not json');
    expect(c.read().paused).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ paused: 'yes' }));
    expect(c.read().paused).toBe(false);
    fs.writeFileSync(file, 'null');
    expect(c.read().paused).toBe(false);
  });

  it('sanitises and caps the reason and drops a bad timestamp', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ paused: true, pausedAt: 'yesterday', reason: `a\u202Eb\u200B\n${'x'.repeat(500)}` }));
    const r = new ControlStore(file).read();
    expect(r.paused).toBe(true);
    expect(r.pausedAt).toBeNull();
    expect(r.reason?.startsWith('ab x')).toBe(true);
    expect(r.reason?.length).toBeLessThanOrEqual(200);
  });
});
