/** Small, deterministic wording for projects and the activity log. */

export function hm(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return '0 min';
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Hours with one decimal, for totals: "11.5 h". */
export function hours(min: number): string {
  const h = min / 60;
  return `${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10} h`;
}

function localDate(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today", "Tomorrow", "Sat", or "Sat, Oct 3" beyond a week. */
export function dayLabel(day: string, now: Date): string {
  const d = localDate(day);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (sameDay(d, now)) return 'Today';
  if (sameDay(d, tomorrow)) return 'Tomorrow';
  const diff = Math.round((d.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  if (diff > 0 && diff < 7) return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function shortDay(dayOrIso: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dayOrIso) ? localDate(dayOrIso) : new Date(dayOrIso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function isWeekendDay(day: string): boolean {
  const w = localDate(day).getDay();
  return w === 0 || w === 6;
}

export const HEALTH_WORD: Record<string, string> = {
  'on-track': 'On track',
  tight: 'Tight',
  'at-risk': 'At risk',
  done: 'Done',
  empty: 'No steps yet',
};

export const ACTOR_WORD: Record<string, string> = {
  you: 'You',
  sorter: 'Mail check',
  drafter: 'Reply draft',
  planner: 'Plan',
  inspector: 'Progress check',
  agent: 'Helper',
  system: 'Next',
};
