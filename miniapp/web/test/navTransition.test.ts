import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '../src/utils/navTransition';

afterEach(() => { vi.restoreAllMocks(); delete document.documentElement.dataset.nav; });
function setup() {
  let cb: () => void = () => {};
  let finish = () => {};
  const skipTransition = vi.fn();
  const finished = new Promise<void>(resolve => { finish = resolve; });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: vi.fn((callback: () => void) => { cb = callback; return { finished, skipTransition }; }) });
  return { commit: () => cb(), finish: async () => { finish(); await finished; }, skipTransition };
}

describe('interruptible page transitions', () => {
  it('commits a pending open before a quick Back, never reopens it later', async () => {
    const t = setup(); const calls: string[] = [];
    navigate('push-left', () => calls.push('open'));
    expect(document.documentElement.dataset.nav).toBe('push-left');
    navigate('pop-left', () => calls.push('back'));
    expect(t.skipTransition).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['open','back']);
    t.commit(); expect(calls).toEqual(['open','back']);
    await t.finish(); expect(document.documentElement.dataset.nav).toBeUndefined();
  });
  it('commits an ordinary push once and cleans up after settling', async () => {
    const t = setup(); const update = vi.fn();
    navigate('push', update); t.commit(); t.commit();
    expect(update).toHaveBeenCalledTimes(1); await t.finish();
    expect(document.documentElement.dataset.nav).toBeUndefined();
  });
  it('keeps navigation functional when the transition API throws', () => {
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: () => { throw new Error('unsupported'); } });
    const update = vi.fn(); navigate('pop', update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.nav).toBeUndefined();
  });
});
