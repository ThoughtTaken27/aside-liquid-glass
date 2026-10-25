/**
 * The pause switch. One flag on disk that every agent-starting path checks
 * before it does anything: while paused, Next still reads and ranks (that
 * is arithmetic on files already here), but no new hand-off, inspection or
 * draft starts. A missing or unreadable file means "not paused", so a
 * corrupt file can never wedge the app; the switch is set explicitly.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface NextControl {
  paused: boolean;
  pausedAt: string | null;
  reason: string | null;
}

const OFF: NextControl = { paused: false, pausedAt: null, reason: null };
const MAX_REASON = 200;

function cleanReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u061C\uFEFF\u00AD]/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REASON);
  return s || null;
}

export class ControlStore {
  constructor(private readonly file: string) {}

  read(): NextControl {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<NextControl>;
      if (!v || typeof v !== 'object' || v.paused !== true) return { ...OFF };
      return {
        paused: true,
        pausedAt: typeof v.pausedAt === 'string' && Number.isFinite(Date.parse(v.pausedAt)) ? v.pausedAt : null,
        reason: cleanReason(v.reason),
      };
    } catch {
      return { ...OFF };
    }
  }

  set(paused: boolean, reason: string | null, now = new Date()): NextControl {
    const next: NextControl = paused
      ? { paused: true, pausedAt: now.toISOString(), reason: cleanReason(reason) }
      : { ...OFF };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return next;
  }
}
