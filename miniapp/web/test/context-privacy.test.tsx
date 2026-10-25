import { act } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import { useLivePlan } from '../src/hooks/useLivePlan';
import { acceptContextPlan, contextChanged, contextFreePlan, contextFreshness, minimumContextRevision } from '../src/utils/contextPrivacy';
import { fixtureHistory, fixtureItem, fixturePlan } from '../src/dev/contextFixtures';
import type { NextPlan } from '../src/types';
const KEY = 'next.plan.v1';
let seen: ReturnType<typeof useLivePlan>;
function Probe() { seen = useLivePlan(); return null; }
const rich = (revision = minimumContextRevision() + 1) => {
  const records = fixtureHistory(revision).events;
  const z = fixtureItem({ title: 'Zeta synthetic task', evidence: { revision, records, influence: 'equal-priority-resume' }, trail: { title: 'Private synthetic visit label', kind: 'Doc', url: 'https://docs.google.com/document/d/SYNTHETIC_DOC_123456789/edit', lastAt: new Date().toISOString(), minutes: 15 } });
  const a = fixtureItem({ id: 'schoology:987654321', title: 'Alpha synthetic task' });
  return fixturePlan({ now: z, next: [a], context: { version: 1, revision, sources: ['schoology'], records, truncated: false }, pickUp: z.trail });
};
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; vi.useFakeTimers(); localStorage.clear(); vi.spyOn(api, 'next').mockResolvedValue(fixturePlan()); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('private context is never a browser cache', () => {
  it('strips facts, source visits and pickup, and restores baseline ordering', () => { const p = rich(), clean = contextFreePlan(p); expect(clean.context).toBeUndefined(); expect(clean.now?.evidence).toBeUndefined(); expect(clean.now?.trail).toBeNull(); expect(clean.pickUp).toBeNull(); expect(clean.now?.title).toBe('Alpha synthetic task'); expect(JSON.stringify(clean)).not.toContain('Private synthetic visit label'); expect(p.now?.evidence).toBeDefined(); });
  it('cleans old cached records before first paint, while offline tasks remain usable', async () => { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), plan: rich() })); vi.mocked(api.next).mockRejectedValue(new Error('offline')); render(<Probe />); expect(seen.plan?.context).toBeUndefined(); expect(seen.plan?.now?.evidence).toBeUndefined(); expect(seen.plan?.pickUp).toBeNull(); expect(localStorage.getItem(KEY)).not.toContain('sourceId'); await flush(); expect(seen.state).toBe('offline'); expect(seen.plan?.now?.title).toBe('Alpha synthetic task'); });
  it('live facts may render but only the non-context plan is saved', async () => { const p = rich(); vi.mocked(api.next).mockResolvedValue(p); render(<Probe />); await flush(); expect(seen.plan?.context).toBeDefined(); const saved = JSON.parse(localStorage.getItem(KEY)!); expect(saved.plan.context).toBeUndefined(); expect(saved.plan.now.evidence).toBeUndefined(); expect(saved.plan.now.trail).toBeNull(); expect(saved.plan.now.title).toBe('Alpha synthetic task'); });
  it('visibility/offline/expired leases remove private display evidence', async () => { vi.mocked(api.next).mockResolvedValue(rich()); render(<Probe />); await flush(); expect(seen.plan?.context).toBeDefined(); vi.mocked(api.next).mockReturnValue(new Promise(() => {})); await flush(31_000); expect(seen.plan?.context).toBeUndefined(); expect(seen.plan?.now?.evidence).toBeUndefined(); expect(seen.plan?.now?.trail).toBeNull(); });
  it('a deletion epoch clears current facts/cache and rejects an older response', async () => { const p = rich(); vi.mocked(api.next).mockResolvedValueOnce(p); render(<Probe />); await flush(); let resolve!: (p: NextPlan) => void; vi.mocked(api.next).mockReturnValueOnce(new Promise(r => { resolve = r; })).mockReturnValue(new Promise(() => {})); const request = seen.load(); await flush(); act(() => contextChanged(p.context!.revision! + 1)); expect(seen.plan?.context).toBeUndefined(); expect(localStorage.getItem(KEY)).toBeNull(); await act(async () => { resolve(p); await request; }); await flush(); expect(seen.plan?.context).toBeUndefined(); expect(seen.plan?.now?.evidence).toBeUndefined(); expect(acceptContextPlan(p).context).toBeUndefined(); });
  it('does not modify source task state while forgetting context', () => { const p = rich(); const clean = contextFreePlan(p); expect(clean.now?.status).toBe('open'); expect(clean.next[0].status).toBe('open'); expect(clean.next[0].url).toBe(p.now?.url); });
  it('unknown or future timestamps never become fresh merely because the flag says so', () => { expect(contextFreshness({ observedAt: null, expiresAt: null })).toBe('unknown'); expect(contextFreshness({ observedAt: new Date(Date.now() + 1000).toISOString(), expiresAt: new Date(Date.now() + 2000).toISOString() })).toBe('unknown'); expect(contextFreshness({ observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now()).toISOString() })).toBe('stale'); });
});
