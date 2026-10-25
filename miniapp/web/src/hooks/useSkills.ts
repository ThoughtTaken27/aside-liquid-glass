import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api';
import type { SkillItem } from '../utils/slash';

/**
 * The "/" menu's skill list: instant, current, and resilient.
 *
 *  - Instant: the last list is kept in localStorage, so the menu opens
 *    fully populated even on a cold start or with the Mac asleep.
 *  - Current: every open of the menu (and every return to the app) asks
 *    the Mac whether its catalog moved, sending the version it holds. An
 *    unchanged catalog answers in a few bytes; a skill added on the Mac
 *    appears the next time the menu opens.
 *  - Resilient: a failed check keeps the saved list on screen, marks it
 *    `offline`, and retries with backoff while the menu is open. A corrupt
 *    or old-format cache is discarded rather than trusted.
 */

const KEY = 'aside.skills.v1';
const FRESH_MS = 10_000;

export type SkillsStatus = 'idle' | 'loading' | 'ready' | 'offline';

interface State {
  skills: SkillItem[];
  version: string | null;
  status: SkillsStatus;
}

function readCache(): State {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as {
      version?: unknown;
      skills?: unknown;
    } | null;
    if (
      raw &&
      typeof raw.version === 'string' &&
      Array.isArray(raw.skills) &&
      raw.skills.every(
        (s: SkillItem) => s && typeof s.name === 'string' && typeof s.path === 'string' && typeof s.id === 'string',
      )
    ) {
      return { skills: raw.skills as SkillItem[], version: raw.version, status: 'idle' };
    }
  } catch {
    /* fall through to empty */
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: run memory-only */
  }
  return { skills: [], version: null, status: 'idle' };
}

let state: State | null = null;
const listeners = new Set<() => void>();
let checkedAt = 0;
let inflight: Promise<void> | null = null;
let retryTimer: number | undefined;
let retryDelay = 2_000;
let wanted = 0;

function current(): State {
  if (!state) state = readCache();
  return state;
}

function set(next: Partial<State>) {
  state = { ...current(), ...next };
  for (const l of listeners) l();
}

function scheduleRetry() {
  if (retryTimer !== undefined || wanted === 0) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined;
    void refreshSkills(true);
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30_000);
}

export function refreshSkills(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && Date.now() - checkedAt < FRESH_MS && current().status === 'ready') {
    return Promise.resolve();
  }
  const { version, skills } = current();
  if (!skills.length) set({ status: 'loading' });
  inflight = api
    .skills(version ?? undefined)
    .then((res) => {
      checkedAt = Date.now();
      retryDelay = 2_000;
      if ('unchanged' in res && res.unchanged) {
        set({ status: 'ready' });
        return;
      }
      if (!('skills' in res) || !Array.isArray(res.skills)) throw new Error('bad_payload');
      set({ skills: res.skills, version: res.stale ? null : res.version, status: 'ready' });
      try {
        localStorage.setItem(KEY, JSON.stringify({ version: res.version, skills: res.skills }));
      } catch {
        /* quota or private mode: the in-memory copy still works */
      }
    })
    .catch(() => {
      set({ status: 'offline' });
      scheduleRetry();
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Subscribe to the list. `active` is whether the menu is open: opening it
 * triggers a version check, and retries only run while someone is looking.
 */
export function useSkills(active: boolean): State {
  const snap = useSyncExternalStore(subscribe, current);
  useEffect(() => {
    if (!active) return undefined;
    wanted++;
    void refreshSkills();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshSkills(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      wanted--;
      if (wanted === 0 && retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [active]);
  return snap;
}

/** Warm the list after first paint so the first "/" is instant. */
export function warmSkills(): void {
  void refreshSkills();
}
