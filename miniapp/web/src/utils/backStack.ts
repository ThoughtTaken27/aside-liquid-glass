import { useId, useLayoutEffect } from 'react';

export interface BackLayer { key: string; back: () => void }
export interface BackHistory {
  state: unknown;
  replaceState: (state: unknown, unused: string) => void;
  pushState: (state: unknown, unused: string) => void;
  go: (delta: number) => void;
}
interface Stamp { epoch: string; keys: string[] }
const FIELD = '__asideBack';
const stampOf = (state: unknown): Stamp | undefined =>
  state && typeof state === 'object' ? (state as Record<string, Stamp>)[FIELD] : undefined;

/** A single owner for same-document history. State stores opaque layer IDs,
 * never conversation content. UI state remains the source of truth; browser
 * Back invokes the same close action as an in-app Back button. */
export class BackStackController {
  private epoch = `aside-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private path: BackLayer[] = [];
  private desired: BackLayer[] = [];
  private suppressed = new Set<string>();
  private travelling = false;
  constructor(private history: BackHistory) {
    this.write([], false);
  }
  private write(keys: string[], push: boolean) {
    const state = this.history.state;
    const keep = state && typeof state === 'object' ? state : {};
    const next = { ...keep, [FIELD]: { epoch: this.epoch, keys } };
    if (push) this.history.pushState(next, '');
    else this.history.replaceState(next, '');
  }
  setLayers(layers: BackLayer[]) {
    this.desired = layers;
    const keys = new Set(layers.map(l => l.key));
    for (const key of this.suppressed) if (!keys.has(key)) this.suppressed.delete(key);
    // Keep callbacks fresh even while a sheet is animating out.
    this.path = this.path.map(l => layers.find(n => n.key === l.key) ?? l);
    this.reconcile();
  }
  private reconcile() {
    if (this.travelling) return;
    const next = this.desired.filter(l => !this.suppressed.has(l.key));
    let common = 0;
    while (common < this.path.length && common < next.length && this.path[common].key === next[common].key) common++;
    // Same-depth replacement (e.g. item -> draft, picker -> Settings) is a
    // replacement, not another Back stop. Longer stacks still add entries.
    if (common < this.path.length && next.length >= this.path.length) {
      this.path = next.slice(0, this.path.length);
      this.write(this.path.map(l => l.key), false);
    } else if (this.path.length > common) {
      this.travelling = true;
      this.history.go(common - this.path.length);
      return;
    }
    for (let i = this.path.length; i < next.length; i++) {
      this.path.push(next[i]);
      this.write(this.path.map(l => l.key), true);
    }
  }
  pop(state: unknown) {
    const stamp = stampOf(state);
    const keys = stamp?.epoch === this.epoch ? stamp.keys : [];
    let common = 0;
    while (common < this.path.length && common < keys.length && this.path[common].key === keys[common]) common++;
    const removed = this.path.slice(common).reverse();
    this.path = this.path.slice(0, common);
    this.travelling = false;
    // A manual dismissal may have requested go(-1) while the user also
    // swipes Back. Skip only layers already absent from UI, not the whole
    // pop: a deeper native jump must still close the remaining page.
    const visible = new Set(this.desired.map(l => l.key));
    for (const layer of removed) {
      if (!visible.has(layer.key) || this.suppressed.has(layer.key)) continue;
      this.suppressed.add(layer.key);
      layer.back();
    }
    // A discarded Forward entry must not revive a phantom page; no restore
    // callbacks or drafts are stored in History. Normalize it to live UI.
    this.write(this.path.map(l => l.key), false);
    this.reconcile();
  }
  dismissTop(layers: BackLayer[] = this.desired) {
    const layer = layers.filter(l => !this.suppressed.has(l.key)).at(-1);
    if (!layer || this.suppressed.has(layer.key)) return;
    this.suppressed.add(layer.key);
    layer.back();
  }
  get depth() { return this.path.length; }
}

const groups = new Map<string, { priority: number; order: number; layers: BackLayer[] }>();
let order = 0;
let controller: BackStackController | undefined;
let queued = false;
const visibleLayers = () => [...groups.values()].sort((a, b) => a.priority - b.priority || a.order - b.order).flatMap(g => g.layers);
function schedule() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    if (!controller) {
      if (!groups.size) return;
      controller = new BackStackController(window.history);
      window.addEventListener('popstate', event => controller?.pop(event.state));
      window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && controller && visibleLayers().length) {
          event.preventDefault();
          event.stopImmediatePropagation();
          controller.dismissTop(visibleLayers());
        }
      }, true);
    }
    const layers = visibleLayers();
    controller.setLayers(layers);
  });
}

/** Register visible navigation stops, in outer-to-inner order. Priority:
 * app 0, nested destinations 20/40, sheets 100, fullscreen 500, images 1000.
 * Layout effects + a microtask coalesce sibling swaps and StrictMode mounts. */
export function useBackStack(layers: BackLayer[], priority = 0) {
  const id = useId();
  useLayoutEffect(() => {
    const old = groups.get(id);
    groups.set(id, { priority, order: old?.order ?? order++, layers: layers.map(l => ({ ...l, key: `${id}:${l.key}` })) });
    schedule();
  });
  useLayoutEffect(() => () => { groups.delete(id); schedule(); }, [id]);
}
