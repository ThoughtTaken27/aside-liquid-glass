import { describe, expect, it, vi } from 'vitest';
import { BackStackController, type BackHistory, type BackLayer } from '../src/utils/backStack';

function fixture() {
  const entries: unknown[] = [{ otherAppData: true }];
  let index = 0;
  const go = vi.fn();
  const history: BackHistory = {
    get state() { return entries[index]; },
    replaceState(s) { entries[index] = s; },
    pushState(s) { entries.splice(index + 1); entries.push(s); index++; },
    go,
  };
  const controller = new BackStackController(history);
  const move = (delta = -1) => { index += delta; controller.pop(entries[index]); };
  const layer = (key: string): BackLayer => ({ key, back: vi.fn() });
  return { entries, controller, go, move, layer, history };
}

describe('layered browser Back', () => {
  it('does not add a trap entry at Home', () => {
    const f = fixture(); f.controller.setLayers([]);
    expect(f.entries).toHaveLength(1);
    expect(f.history.state).toMatchObject({ otherAppData: true });
    expect(f.controller.depth).toBe(0);
  });
  it('pushes a stop per layer and only closes the deepest one', () => {
    const f = fixture(); const a = f.layer('next'), b = f.layer('item');
    f.controller.setLayers([a, b]); f.move();
    expect(b.back).toHaveBeenCalledTimes(1); expect(a.back).not.toHaveBeenCalled();
    expect(f.controller.depth).toBe(1);
    // The exiting sheet may stay mounted while animating: do not re-push.
    f.controller.setLayers([a, b]); expect(f.entries).toHaveLength(3);
    f.controller.setLayers([a]); f.move(); expect(a.back).toHaveBeenCalledTimes(1);
  });
  it('pops manual dismissal without calling the same close action twice', () => {
    const f = fixture(); const a = f.layer('page'), b = f.layer('sheet');
    f.controller.setLayers([a,b]); f.controller.setLayers([a]);
    expect(f.go).toHaveBeenCalledWith(-1); f.move();
    expect(a.back).not.toHaveBeenCalled(); expect(b.back).not.toHaveBeenCalled();
    expect(f.controller.depth).toBe(1);
  });
  it('collapses a nested settings stack deepest-first on a history jump', () => {
    const f = fixture(); const calls: string[] = [];
    const layers = ['settings','memory','file'].map(key => ({ key, back: () => calls.push(key) }));
    f.controller.setLayers(layers); f.move(-2);
    expect(calls).toEqual(['file','memory']); expect(f.controller.depth).toBe(1);
  });
  it('replaces siblings rather than leaving a phantom item behind', () => {
    const f = fixture(); const a = f.layer('next'), b = f.layer('item'), c = f.layer('draft');
    f.controller.setLayers([a,b]); f.controller.setLayers([a,c]);
    expect(f.entries).toHaveLength(3); f.move();
    expect(c.back).toHaveBeenCalledTimes(1); expect(b.back).not.toHaveBeenCalled();
  });
  it('uses updated callbacks when local page state changes', () => {
    const f = fixture(); const a = f.layer('sheet'), b = f.layer('provider');
    f.controller.setLayers([a,b]); const back = vi.fn();
    f.controller.setLayers([a, {key:b.key,back}]); f.move();
    expect(back).toHaveBeenCalledTimes(1); expect(b.back).not.toHaveBeenCalled();
  });
  it('handles a new page opened while manual history traversal is pending', () => {
    const f = fixture(); const a = f.layer('page'), b = f.layer('sheet'), c = f.layer('new-sheet');
    f.controller.setLayers([a,b]); f.controller.setLayers([a]); f.controller.setLayers([a,c]); f.move();
    expect(f.controller.depth).toBe(2); expect(c.back).not.toHaveBeenCalled();
    f.move(); expect(c.back).toHaveBeenCalledTimes(1);
  });
  it('can open the same layer again after a completed native dismissal', () => {
    const f = fixture(); const a = f.layer('next');
    f.controller.setLayers([a]); f.move(); f.controller.setLayers([]);
    f.controller.setLayers([a]); expect(f.controller.depth).toBe(1);
    f.move(); expect(a.back).toHaveBeenCalledTimes(2);
  });
  it('does not resurrect closed UI through browser Forward', () => {
    const f = fixture(); const a = f.layer('next');
    f.controller.setLayers([a]); f.move(); f.controller.setLayers([]); f.move(1);
    expect(f.controller.depth).toBe(0); expect(a.back).toHaveBeenCalledTimes(1);
  });
});


describe('asynchronous and interrupted Back', () => {
  it('does not echo or re-push a native Back before React delivers the new layers', () => {
    const f = fixture(); const page = f.layer('page');
    f.controller.setLayers([page]); f.move();
    expect(page.back).toHaveBeenCalledTimes(1);
    expect(f.controller.depth).toBe(0);
    expect(f.go).not.toHaveBeenCalled();
    f.controller.setLayers([page]); // a stale render while the transition snapshots
    expect(f.controller.depth).toBe(0);
    expect(f.entries).toHaveLength(2);
    f.controller.setLayers([]);
    expect(page.back).toHaveBeenCalledTimes(1);
    expect(f.go).not.toHaveBeenCalled();
  });
  it('still closes the page if a native jump outruns a manual sheet dismissal', () => {
    const f = fixture(); const page = f.layer('page'), sheet = f.layer('sheet');
    f.controller.setLayers([page,sheet]); f.controller.setLayers([page]);
    expect(f.go).toHaveBeenCalledWith(-1);
    f.move(-2);
    expect(sheet.back).not.toHaveBeenCalled();
    expect(page.back).toHaveBeenCalledTimes(1);
    expect(f.controller.depth).toBe(0);
    f.controller.setLayers([]);
    expect(f.go).toHaveBeenCalledTimes(1);
  });
  it('handles two fast native Backs before either UI update completes', () => {
    const f = fixture(); const page = f.layer('page'), sheet = f.layer('sheet');
    f.controller.setLayers([page,sheet]); f.move(); f.move();
    expect(sheet.back).toHaveBeenCalledTimes(1);
    expect(page.back).toHaveBeenCalledTimes(1);
    expect(f.controller.depth).toBe(0);
    f.controller.setLayers([]);
    expect(f.go).not.toHaveBeenCalled();
  });
});
