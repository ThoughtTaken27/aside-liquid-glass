import { flushSync } from 'react-dom';

/** Spatially consistent screen navigation. Next lives left of Home;
 * ordinary destinations live right. Interrupted navigation commits the
 * old update before the new one, then removes its frozen snapshot. */
export type NavDirection = 'push' | 'pop' | 'push-left' | 'pop-left' | 'fade';
interface Transition { ready?: Promise<void>; finished: Promise<void>; skipTransition: () => void }
type ViewTransitionDoc = Document & { startViewTransition?: (cb: () => void) => Transition };
let active: { transition: Transition; commit: () => void } | undefined;

if (typeof document !== 'undefined' && typeof (document as ViewTransitionDoc).startViewTransition === 'function') {
  document.documentElement.dataset.vt = 'on';
}

export function navigate(direction: NavDirection, update: () => void): void {
  const doc = document as ViewTransitionDoc;
  const root = document.documentElement;
  if (active) {
    const old = active;
    active = undefined;
    old.transition.skipTransition();
    old.commit();
    delete root.dataset.nav;
    flushSync(update);
    return;
  }
  if (!doc.startViewTransition || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.visibilityState !== 'visible') {
    update();
    return;
  }
  root.dataset.nav = direction;
  let committed = false;
  const commit = () => { if (!committed) { committed = true; flushSync(update); } };
  try {
    const transition = doc.startViewTransition(commit);
    // A skipped/interrupted snapshot rejects ready, not finished. Consume
    // that expected rejection so rapid Back never raises an unhandled error.
    void transition.ready?.catch(() => undefined);
    const owner = { transition, commit };
    active = owner;
    const cleanup = () => { if (active === owner) { active = undefined; delete root.dataset.nav; } };
    // skipTransition rejects ready on some versions; finished still settles.
    void transition.finished.then(cleanup, cleanup);
  } catch {
    delete root.dataset.nav;
    commit();
  }
}
