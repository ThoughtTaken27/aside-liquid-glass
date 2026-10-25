/** Read-only status transitions, not polling a model or spawning the CLI. */
import type { PushNotice } from './push.js';
export interface PushSession { id: string; status: string; title: string; updatedAt: number }
interface Tracked { status: string; since: number; progressSent: boolean; updatedAt: number; phase?: string; progressAt?: number }
/**
 * Live status cadence. The first update waits out quick replies, later ones
 * follow the phase but never faster than one per 15 s, and a heartbeat
 * every 4 min tells the phone the task is still alive.
 */
export const LIVE_FIRST_MS = 10_000;
export const LIVE_STEP_MS = 15_000;
export const LIVE_HEARTBEAT_MS = 240_000;
export class PushMonitor {
  private tracked = new Map<string, Tracked>();
  private busy = false;
  private baselineAt: number | undefined;
  constructor(private options: { enabled: () => boolean; sessions: () => Promise<PushSession[] | null>; send: (notice: PushNotice) => Promise<unknown>; detail?: (id: string, kind: PushNotice['kind']) => Promise<string>; phase?: (id: string) => Promise<string | null>; finalAnswerAt?: (id: string) => Promise<number | null>; muted?: (id: string) => boolean; now?: () => number }) {}
  /** Local runner events preserve even turns shorter than the scan interval. */
  begin(id: string, startedAt: number) { this.tracked.set(id, { status: 'running', since: startedAt, progressSent: false, updatedAt: startedAt }); }
  async tick() {
    if (this.busy || !this.options.enabled()) { if (!this.options.enabled()) { this.tracked.clear(); this.baselineAt = undefined; } return; }
    this.busy = true;
    try {
      const rows = await this.options.sessions(); if (!rows) return;
      const now = this.options.now?.() ?? Date.now();
      const firstScan = this.baselineAt === undefined;
      this.baselineAt ??= now;
      const seen = new Set<string>();
      for (const row of rows) {
        seen.add(row.id);
        const prior = this.tracked.get(row.id);
        const next: Tracked = prior ?? { status: row.status, since: now, progressSent: false, updatedAt: row.updatedAt };
        if (row.status === 'running' && prior?.status !== 'running') { next.since = now; next.progressSent = false; next.phase = undefined; next.progressAt = undefined; }
        let kind: PushNotice['kind'] | undefined;
        let finalAt: number | null | undefined;
        // Baseline existing tasks on startup, but never replay old completions.
        if (prior?.status === 'running' && row.status !== 'running') {
          if (row.status === 'suspended') kind = 'needs-input';
          else if (row.status === 'idle' || row.status === 'completed') kind = 'ready';
          else if (row.status === 'error' || row.status === 'failed') kind = 'error';
          // interrupted/stopped is the user's own action, not a completion.
        } else if (row.status === 'running' && now - next.since >= LIVE_FIRST_MS) {
          const phase = (await this.options.phase?.(row.id).catch(() => null)) || 'Working';
          const since = now - (next.progressAt ?? 0);
          if (!next.progressSent || (phase !== next.phase && since >= LIVE_STEP_MS) || since >= LIVE_HEARTBEAT_MS) {
            kind = 'progress'; next.progressSent = true; next.phase = phase; next.progressAt = now;
          }
        }
        // A Mac turn can start and finish between two scans. A newer
        // timestamped final answer proves completion; read marks do not.
        if (!kind && !firstScan && (row.status === 'idle' || row.status === 'completed') && row.updatedAt > (prior?.updatedAt ?? this.baselineAt)) {
          finalAt = await this.options.finalAnswerAt?.(row.id).catch(() => null);
          if (finalAt != null && finalAt > Math.max(prior?.updatedAt ?? 0, this.baselineAt)) kind = 'ready';
        }
        if (kind === 'ready' && finalAt === undefined) finalAt = await this.options.finalAnswerAt?.(row.id).catch(() => null);
        next.status = row.status; next.updatedAt = Math.max(row.updatedAt, finalAt ?? 0);
        if (this.tracked.get(row.id) === prior) this.tracked.set(row.id, next);
        if (kind && !this.options.muted?.(row.id)) {
          if (kind === 'progress') await this.options.send({ sessionId: row.id, title: row.title, kind, phase: next.phase, startedAt: next.since });
          else {
            const summary = await this.options.detail?.(row.id, kind).catch(() => '') ?? '';
            await this.options.send({ sessionId: row.id, title: row.title, kind, summary });
          }
        }
      }
      for (const [id, tracked] of this.tracked) if (!seen.has(id) && tracked.since < now) this.tracked.delete(id);
    } finally { this.busy = false; }
  }
}
