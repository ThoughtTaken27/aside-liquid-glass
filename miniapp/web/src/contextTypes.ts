export type ContextSource = 'schoology' | 'work-trail';
export interface ContextRecord {
  taskId: string; source: ContextSource; sourceId: string;
  kind: 'source-status' | 'foreground-activity';
  observedAt: string | null; expiresAt: string | null;
  freshness: 'fresh' | 'stale' | 'unknown';
  confidence: 'structured-source' | 'exact-identity' | 'unknown';
  value?: 'reported-open' | 'reported-complete'; minutes?: number;
}
export interface ContextEnvelope { version: 1; revision?: number; sources: ContextSource[]; records: ContextRecord[]; truncated: boolean }
export interface TaskEvidence { revision: number; records: ContextRecord[]; influence: 'equal-priority-resume' | null }
export interface MemoryPreferences { enabled: boolean; sources: ContextSource[]; pausedUntil: string | 'until-resumed' | null; retentionDays: 7 | 14 | 30; excludedHosts: string[] }
export interface MemoryStatus {
  revision: number; preferences: MemoryPreferences; state: 'off' | 'paused' | 'ready'; processing: 'local-factual'; nextPaused?: boolean;
  count: number; documentCount?: number; storageBytes: number; firstEventAt: string | null; averageDailyBytes: number | null; capped: boolean;
  sources: Array<{ id: ContextSource; label: string; enabled: boolean; count: number; lastObservedAt: string | null }>;
}
export interface MemoryEvent extends ContextRecord { id: string; title: string; url: string | null; space: 'school' | 'personal'; observedAt: string }
export interface MemoryWindow { id: string; from: string; to: string; title: string; summary: string; evidence: MemoryEvent[] }
export interface MemoryHistory { revision: number; events: MemoryEvent[]; windows: MemoryWindow[]; total: number; more: boolean; queryKind: 'chronological' | 'lexical' }
export type ForgetTarget = { kind: 'all' | 'ten-minutes' | 'hour' | 'today' } | { kind: 'source'; source: ContextSource } | { kind: 'item'; taskId: string };
export interface HistoryQuery { space?: 'school' | 'personal'; day?: string; q?: string; source?: ContextSource; offset?: number; limit?: number; window?: 'ten-minutes' | 'six-hours' }

export interface DocumentBinding { taskId: string; title: string; space: 'school' | 'personal'; sourceId: string; url: string; originURL: string | null; linkedAt: string }
export interface DocumentView { taskId: string; revision: number; enabled: boolean; available: boolean; binding: DocumentBinding | null }
