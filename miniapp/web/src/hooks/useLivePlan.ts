/**
 * The plan, kept alive on its own.
 *
 * - Opens instantly from the last plan this device saw (localStorage), then
 *   refreshes. A cold start never shows a blank spinner if it has seen a plan.
 * - One request at a time: overlapping loads share the same promise.
 * - A request that hangs is abandoned after 15s instead of blocking forever.
 * - On failure it retries on its own (2s, 4s, 8s ... up to 60s) instead of
 *   waiting a full minute, and says it is showing saved data meanwhile.
 * - Polls only while the page is visible. Coming back to the tab, the
 *   network coming back, or the page being restored from the back/forward
 *   cache all refresh right away.
 * - A refresh that changes nothing does not re-render anything.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { NextPlan } from '../types';
import { acceptContextPlan, contextEpoch, contextFreePlan, onContextChanged } from '../utils/contextPrivacy';

const CACHE_KEY = 'next.plan.v1';
const REFRESH_MS = 60_000;
const TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_CACHE_CHARS = 600_000;

export type LiveState = 'live' | 'saved' | 'offline';

type Cached = { at: number; plan: NextPlan };

function readCache(): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    if (raw.length > MAX_CACHE_CHARS) { localStorage.removeItem(CACHE_KEY); return null; }
    const c = JSON.parse(raw) as Cached;
    if (!c || !c.plan || typeof c.at !== 'number') return null;
    const sanitized = { ...c, plan: contextFreePlan(c.plan) };
    localStorage.setItem(CACHE_KEY, JSON.stringify(sanitized));
    return sanitized;
  } catch {
    return null;
  }
}

/** Everything except the timestamp the server stamps on every response. */
export function planFingerprint(p: NextPlan): string {
  return JSON.stringify(p, (k, v) => (k === 'generatedAt' ? undefined : v));
}

export function backoffMs(failures: number): number {
  return Math.min(2_000 * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function useLivePlan() {
  const [initial] = useState(readCache);
  const [plan, setPlanState] = useState<NextPlan | null>(initial?.plan ?? null);
  const [state, setState] = useState<LiveState>(initial ? 'saved' : 'live');
  const [savedAt, setSavedAt] = useState<number | null>(initial?.at ?? null);
  const [error, setError] = useState<string | null>(null);
  const [contextLeaseAt, setContextLeaseAt] = useState(0);
  const stateRef = useRef<LiveState>(initial ? 'saved' : 'live');

  const print = useRef<string>(initial ? planFingerprint(initial.plan) : '');
  const inflight = useRef<Promise<void> | null>(null);
  const failures = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const lastOk = useRef(0);
  const alive = useRef(true);
  const hasContext = useRef(false);

  /** Adopt a plan from anywhere (a refresh or a mutation's response). */
  const setPlan = useCallback((incoming: NextPlan) => {
    const p = acceptContextPlan(incoming);
    const present = Boolean(p.context || [p.now, ...p.next, ...p.later].some(it => it?.evidence));
    if (present) setContextLeaseAt(Date.now());
    else if (hasContext.current) setContextLeaseAt(0);
    hasContext.current = present;
    const f = planFingerprint(p);
    lastOk.current = Date.now();
    failures.current = 0;
    if (stateRef.current !== 'live') {
      stateRef.current = 'live';
      setState('live');
      setError(null);
    }
    if (f === print.current) return;
    print.current = f;
    setPlanState(p);
    try {
      const raw = JSON.stringify({ at: Date.now(), plan: contextFreePlan(p) } satisfies Cached);
      if (raw.length < MAX_CACHE_CHARS) localStorage.setItem(CACHE_KEY, raw);
    } catch {
      /* storage full or blocked: the live plan still works */
    }
    setSavedAt(Date.now());
  }, []);

  const schedule = useCallback((ms: number) => {
    window.clearTimeout(timer.current);
    if (document.visibilityState !== 'visible') return; // resumes on visible
    timer.current = window.setTimeout(() => void loadRef.current(), ms);
  }, []);

  const load = useCallback((): Promise<void> => {
    if (inflight.current) return inflight.current;
    const epoch = contextEpoch();
    const run = (async () => {
      try {
        const p = await withTimeout(api.next(), TIMEOUT_MS);
        if (!alive.current || epoch !== contextEpoch()) return;
        setPlan(p);
        schedule(p.context ? 15_000 : REFRESH_MS);
      } catch {
        if (!alive.current) return;
        failures.current += 1;
        if (stateRef.current !== 'offline') {
          stateRef.current = 'offline';
          setState('offline');
          setError('Could not reach your Mac.');
        }
        schedule(backoffMs(failures.current));
      } finally {
        inflight.current = null;
        if (alive.current && epoch !== contextEpoch()) schedule(0);
      }
    })();
    inflight.current = run;
    return run;
  }, [schedule, setPlan]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    alive.current = true;
    void load();
    const wake = () => {
      if (document.visibilityState !== 'visible') {
        window.clearTimeout(timer.current);
        return;
      }
      // Back in view: refresh now unless the last good answer is very fresh.
      if (Date.now() - lastOk.current > 10_000) void load();
      else schedule(REFRESH_MS);
    };
    const online = () => {
      failures.current = 0;
      void load();
    };
    const shown = (e: PageTransitionEvent) => e.persisted && void load();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', online);
    window.addEventListener('pageshow', shown);
    const unsubscribe = onContextChanged(() => {
      setPlanState(p => p ? contextFreePlan(p) : null);
      print.current = '';
      void load();
    });
    const privacyClock = window.setInterval(() => {
      if (hasContext.current && (document.visibilityState !== 'visible' || Date.now() - lastOk.current > 30_000 || navigator.onLine === false)) setContextLeaseAt(0);
    }, 1000);
    return () => {
      unsubscribe(); window.clearInterval(privacyClock);
      alive.current = false;
      window.clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', online);
      window.removeEventListener('pageshow', shown);
    };
  }, [load, schedule]);

  const visiblePlan = plan && (state !== 'live' || contextLeaseAt === 0 || Date.now() - contextLeaseAt > 30_000 || navigator.onLine === false) ? contextFreePlan(plan) : plan;
  return { plan: visiblePlan, setPlan, load, state, savedAt, error };
}
