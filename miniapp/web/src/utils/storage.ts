/**
 * `localStorage`, minus the ways it throws.
 *
 * Reading `window.localStorage` is not a safe operation. It throws rather
 * than returning null in three situations this app actually meets:
 *
 *  - a browser with cookies/site-data blocked, which is a setting a real
 *    person turns on and forgets about,
 *  - a WebView that never provisioned a storage partition, which is what
 *    the jsdom test environment reproduces and what some embedded webviews
 *    do,
 *  - a quota exception on write, which Safari raises in private mode.
 *
 * `standalone.ts` already wrapped every one of its calls for exactly this
 * reason. The rest of the app did not, and two of the unguarded reads were
 * `useState` initialisers in `App.tsx` -- a throw there happens during the
 * first render of the root component, so it does not degrade a feature, it
 * takes down the whole app before anything paints. `SessionList`'s
 * `readStoredView()` had the same shape and is what surfaced this: it threw
 * in the test environment and took the session list with it.
 *
 * Everything here fails soft. A read that cannot happen returns null, and
 * the caller falls back to its default; a write that cannot happen is
 * dropped. The cost of that is a preference not surviving a restart, which
 * is the correct thing to trade for the app rendering at all.
 */

/**
 * The backing store, or null when it is unusable.
 *
 * Resolved on every call rather than cached at module load: a module-level
 * probe would run before the test environment installs its own storage, and
 * would pin the wrong answer for the life of the page.
 */
function store(): Storage | null {
  try {
    // The property access itself is what throws when site data is blocked,
    // so it has to be inside the try -- not just the get/set that follows.
    const s = globalThis.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

/** Read a key, or null if it is missing or storage is unavailable. */
export function readLocal(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Write a key. Silently does nothing when storage is unavailable or full. */
export function writeLocal(key: string, value: string): void {
  try {
    store()?.setItem(key, value);
  } catch {
    /* preference will not survive a restart; the app still works */
  }
}

/** Delete a key. Silently does nothing when storage is unavailable. */
export function removeLocal(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    /* nothing to do */
  }
}
