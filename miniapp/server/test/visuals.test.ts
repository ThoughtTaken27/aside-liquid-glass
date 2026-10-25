import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VisualStore, VISUAL_CSP, VISUAL_MAX_BYTES } from '../src/visuals.js';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'visuals-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('VisualStore', () => {
  it('round-trips a page under a stable, keyed id', () => {
    const store = new VisualStore(tmp(), 'secret-a');
    const id = store.put('<p>hi</p>');
    expect(id).toMatch(/^[a-f0-9]{48}$/);
    expect(store.put('<p>hi</p>')).toBe(id);
    expect(store.get(id)).toBe('<p>hi</p>');
    // A different secret cannot predict the id.
    expect(new VisualStore(tmp(), 'secret-b').idFor('<p>hi</p>')).not.toBe(id);
  });

  it('refuses traversal, unknown ids, empty and oversized pages', () => {
    const store = new VisualStore(tmp(), 'k');
    expect(store.get('../../etc/passwd')).toBeNull();
    expect(store.get('a'.repeat(48))).toBeNull();
    expect(() => store.put('   ')).toThrow(RangeError);
    expect(() => store.put('x'.repeat(VISUAL_MAX_BYTES + 1))).toThrow(RangeError);
  });

  it('prunes the oldest pages past its cap', () => {
    const dir = tmp();
    const store = new VisualStore(dir, 'k', 3);
    const ids = ['a', 'b', 'c', 'd', 'e'].map((x, i) => {
      const id = store.put(`<p>${x}</p>`);
      const t = new Date(Date.now() - (10 - i) * 1000);
      fs.utimesSync(path.join(dir, `${id}.html`), t, t);
      return id;
    });
    store.put('<p>f</p>');
    expect(fs.readdirSync(dir).length).toBe(3);
    expect(store.get(ids[0])).toBeNull();
    expect(store.get(ids[4])).toBe('<p>e</p>');
  });
});

describe('VISUAL_CSP', () => {
  it('sandboxes into an opaque origin and only frames under this app', () => {
    expect(VISUAL_CSP).toMatch(/^sandbox allow-scripts/);
    expect(VISUAL_CSP).not.toMatch(/allow-same-origin/);
    expect(VISUAL_CSP).toContain("frame-ancestors 'self'");
    expect(VISUAL_CSP).toContain("default-src 'none'");
  });
});

 it('blocks external resource loads, fetch connections and popup escapes (not self-navigation)', () => {
  expect(VISUAL_CSP).toContain("connect-src 'none'");
  expect(VISUAL_CSP).toContain("script-src 'unsafe-inline'");
  expect(VISUAL_CSP).not.toMatch(/https:|allow-popups|unsafe-eval/);
  expect(VISUAL_CSP).toContain('img-src data: blob:');
 });
