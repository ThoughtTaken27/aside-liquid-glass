/**
 * When is something on Next worth a ping? Interruptions cost the most when
 * he is busy, so the bar is high and plain code owns it:
 *
 *   eligible  new since the last look, open, not on trial, not flagged,
 *             due within 36 hours and not long past
 *   pressing  Jev scores how soon it needs him (one request per batch);
 *             only the top level or near it passes
 *   quiet     never during school hours on school days (7:00-3:15) or at
 *             night (10:30 PM-7:00 AM); held items go out together after
 *   cap       at most 3 messages a day; the first run only takes stock
 *
 * The message goes through the existing Telegram bot and says only titles
 * and times. It never carries a link or button that acts.
 */
import fs from 'node:fs';
import { score, type Jev } from './jev.js';
import type { NextItem } from './next.js';

export interface NotifyState {
  seen: Record<string, number>;
  held: string[];
  sent: Array<{ at: number; ids: string[] }>;
  primed: boolean;
}

/**
 * Urgency alone can't tell a college deadline from a library book (both
 * scored 2.0 in testing), so stakes are asked in the same call and code
 * combines them. Tested: the two that mattered 0.82-0.84, the rest <= 0.63.
 */
export const PING_AT = 0.75;
export function pressing(urgency: number, stakes: number): number {
  return 0.55 * (urgency / 3) + 0.45 * (stakes / 3);
}
const DAY = 86_400_000;

export function quiet(d: Date): boolean {
  const mins = d.getHours() * 60 + d.getMinutes();
  if (mins >= 22 * 60 + 30 || mins < 7 * 60) return true;
  const weekday = d.getDay() >= 1 && d.getDay() <= 5;
  const schoolYear = d.getMonth() >= 7 || d.getMonth() <= 4; // Aug-May
  return weekday && schoolYear && mins >= 7 * 60 && mins < 15 * 60 + 15;
}

export function eligible(it: NextItem, now: Date): boolean {
  if (it.status !== 'open' || it.trial || it.flag || !it.dueISO) return false;
  const due = Date.parse(it.dueISO);
  return due - now.getTime() <= 36 * 3_600_000 && now.getTime() - due <= 6 * 3_600_000;
}

function when(iso: string, now: Date): string {
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / DAY);
  if (d.getTime() < now.getTime()) return `was due ${t}`;
  return days <= 0 ? `due ${t} today` : days === 1 ? `due ${t} tomorrow` : `due ${d.toLocaleDateString('en-US', { weekday: 'long' })}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface NextNotifyOptions {
  jev: Jev;
  statePath: string;
  items: () => NextItem[];
  send: (html: string) => Promise<void>;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

export class NextNotify {
  private st: NotifyState;
  private busy = false;

  constructor(private readonly o: NextNotifyOptions) {
    try {
      this.st = { seen: {}, held: [], sent: [], primed: false, ...JSON.parse(fs.readFileSync(o.statePath, 'utf8')) };
    } catch {
      this.st = { seen: {}, held: [], sent: [], primed: false };
    }
  }

  state(): NotifyState {
    return this.st;
  }

  private save(): void {
    const tmp = `${this.o.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.st), { mode: 0o600 });
    fs.renameSync(tmp, this.o.statePath);
  }

  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.pass();
    } finally {
      this.busy = false;
    }
  }

  private async pass(): Promise<void> {
    const now = this.o.now?.() ?? new Date();
    const t = now.getTime();
    const items = this.o.items();
    const byId = new Map(items.map((i) => [i.id, i]));
    const fresh = items.filter((i) => !(i.id in this.st.seen));
    for (const i of fresh) this.st.seen[i.id] = t;
    for (const [id, at] of Object.entries(this.st.seen)) if (t - at > 21 * DAY) delete this.st.seen[id];
    this.st.sent = this.st.sent.filter((s) => t - s.at < DAY);

    // First run: take stock of what's already there; ping nothing.
    if (!this.st.primed) {
      this.st.primed = true;
      this.save();
      return;
    }

    const cands = fresh.filter((i) => eligible(i, now));
    if (cands.length) {
      const state = [
        "New items on a high school junior's to-do list. Current time: " + now.toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' }) + '.',
        ...cands.slice(0, 8).map((it, k) => `Item ${k + 1}: "${it.title.slice(0, 140)}" (${it.context.slice(0, 60)}, ${when(it.dueISO!, now)})`),
      ].join('\n');
      const qs: Record<string, { type: 'score'; instructions: string; criteria: string[] }> = {};
      cands.slice(0, 8).forEach((_, k) => {
        qs[`s${k + 1}`] = {
          type: 'score',
          instructions: `What happens if the student misses item ${k + 1}?`,
          criteria: [
            'Nothing much, or it is optional',
            'A small cost: a minor grade, a fine, or mild embarrassment',
            'A real cost: a meaningful grade, a commitment to others, or a missed opportunity',
            'A major cost: a big grade, a college or scholarship deadline, or something that cannot be undone',
          ],
        };
        qs[`i${k + 1}`] = {
          type: 'score',
          instructions: `How soon does item ${k + 1} need the student's attention?`,
          criteria: [
            'It can wait several days, or is just information',
            'Sometime this week is fine',
            'He should handle it today or tomorrow',
            'Urgent: it will be missed or cost him if he does not act within a few hours',
          ],
        };
      });
      const r = await this.o.jev.ask({ state, questions: qs, tier: 'background', feature: 'next.notify', ttlMs: 0 });
      if (r.ok) {
        cands.slice(0, 8).forEach((it, k) => {
          const u = score(r.answers, `i${k + 1}`);
          const st = score(r.answers, `s${k + 1}`);
          if (u && st && pressing(u.score, st.score) >= PING_AT && !this.st.held.includes(it.id)) this.st.held.push(it.id);
        });
      } else {
        this.o.log?.('next notify: jev unavailable, nothing held', r.why);
      }
    }

    // Drop held items he already dealt with, or that aren't pressing any more.
    this.st.held = this.st.held.filter((id) => {
      const it = byId.get(id);
      return it ? eligible(it, now) : false;
    });

    if (this.st.held.length && !quiet(now) && this.st.sent.length < 3) {
      const list = this.st.held.map((id) => byId.get(id)!).slice(0, 3);
      const lines =
        list.length === 1
          ? [`<b>Next:</b> ${esc(list[0].title)}, ${when(list[0].dueISO!, now)}.`]
          : [`<b>Next: ${list.length} things need you soon</b>`, ...list.map((it) => `• ${esc(it.title)}, ${when(it.dueISO!, now)}`)];
      try {
        await this.o.send(lines.join('\n'));
        this.st.sent.push({ at: t, ids: list.map((x) => x.id) });
        this.st.held = this.st.held.filter((id) => !list.some((x) => x.id === id));
      } catch (err) {
        this.o.log?.('next notify: send failed', err);
      }
    }
    this.save();
  }
}
