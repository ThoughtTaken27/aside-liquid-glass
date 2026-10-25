/**
 * CaptureGate: the only thing standing between a looping Watch Mode client
 * and a 139MB process spawned every couple of seconds forever.
 *
 * These did not exist when the gate was written, which is how the
 * record-on-success bug (a failed capture left no floor) survived review.
 * The clock is injected so none of this sleeps.
 */
import { describe, expect, it } from 'vitest';
import {
  BrowserError,
  CAPTURE_TAB_FLOOR_MS,
  CAPTURE_WINDOW_MAX,
  CAPTURE_WINDOW_MS,
  CaptureGate,
} from '../src/browser.js';

/** A clock the test drives by hand. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const ok = async () => 'captured';
const boom = async () => {
  throw new Error('screenshot failed');
};

describe('CaptureGate', () => {
  it('allows the first capture of a tab', async () => {
    const c = clock();
    const gate = new CaptureGate(c.now);
    await expect(gate.run('tab-a', ok)).resolves.toBe('captured');
  });

  it('holds a per-tab floor between captures', async () => {
    const c = clock();
    const gate = new CaptureGate(c.now);
    await gate.run('tab-a', ok);

    c.advance(CAPTURE_TAB_FLOOR_MS - 1);
    await expect(gate.run('tab-a', ok)).rejects.toMatchObject({
      code: 'rate_limited',
    });

    c.advance(1);
    await expect(gate.run('tab-a', ok)).resolves.toBe('captured');
  });

  it('scopes the floor to one tab', async () => {
    const c = clock();
    const gate = new CaptureGate(c.now);
    await gate.run('tab-a', ok);
    await expect(gate.run('tab-b', ok)).resolves.toBe('captured');
  });

  /**
   * The regression this file exists for. The floor used to be recorded only
   * after a successful capture, so a tab that kept failing could be retried
   * as fast as the client asked -- exactly when a retry storm happens.
   */
  it('holds the floor after a FAILED capture', async () => {
    const c = clock();
    const gate = new CaptureGate(c.now);

    await expect(gate.run('tab-a', boom)).rejects.toThrow('screenshot failed');

    c.advance(CAPTURE_TAB_FLOOR_MS - 1);
    await expect(gate.run('tab-a', ok)).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('releases the concurrency slot after a failure', async () => {
    const c = clock();
    const gate = new CaptureGate(c.now);
    await expect(gate.run('tab-a', boom)).rejects.toThrow();

    c.advance(CAPTURE_TAB_FLOOR_MS);
    // Would throw capture_busy instead if inFlight leaked on the throw path.
    await expect(gate.run('tab-a', ok)).resolves.toBe('captured');
  });

  it('refuses a concurrent capture', async () => {
    const c = clock();
    const gate = new CaptureGate(c.now);

    let release: (v: string) => void = () => {};
    const slow = gate.run('tab-a', () => new Promise<string>((r) => (release = r)));

    await expect(gate.run('tab-b', ok)).rejects.toMatchObject({
      code: 'capture_busy',
    });

    release('done');
    await expect(slow).resolves.toBe('done');
  });

  /**
   * The server-side ceiling. Before this, the only per-turn limit lived in
   * WatchMode.tsx, so nothing bounded a client that was buggy, backgrounded,
   * or just left open.
   */
  it('caps captures across all tabs in a rolling window', async () => {
    const c = clock();
    const gate = new CaptureGate(c.now);

    for (let i = 0; i < CAPTURE_WINDOW_MAX; i += 1) {
      // A distinct tab each time, so the per-tab floor never fires and the
      // window ceiling is the only thing that can stop this.
      await expect(gate.run(`tab-${i}`, ok)).resolves.toBe('captured');
      c.advance(10);
    }

    await expect(gate.run('tab-overflow', ok)).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('lets the window drain and then allows captures again', async () => {
    const c = clock();
    const gate = new CaptureGate(c.now);

    for (let i = 0; i < CAPTURE_WINDOW_MAX; i += 1) {
      await gate.run(`tab-${i}`, ok);
      c.advance(10);
    }
    await expect(gate.run('tab-next', ok)).rejects.toMatchObject({
      code: 'rate_limited',
    });

    c.advance(CAPTURE_WINDOW_MS);
    await expect(gate.run('tab-next', ok)).resolves.toBe('captured');
  });

  it("does not let a failed capture escape the window's accounting", async () => {
    const c = clock();
    const gate = new CaptureGate(c.now);

    for (let i = 0; i < CAPTURE_WINDOW_MAX; i += 1) {
      await gate.run(`tab-${i}`, boom).catch(() => undefined);
      c.advance(10);
    }

    await expect(gate.run('tab-overflow', ok)).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('reports rate limiting as a BrowserError', async () => {
    const c = clock();
    const gate = new CaptureGate(c.now);
    await gate.run('tab-a', ok);
    await expect(gate.run('tab-a', ok)).rejects.toBeInstanceOf(BrowserError);
  });
});
