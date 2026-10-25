/** Due-date and duration wording for the Next surface. */
// Formatting. Relative where it helps ("tonight", "tomorrow"), absolute
// where relative stops meaning anything.

export function clock(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dayDiff(a: Date, b: Date): number {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(a) - start(b)) / 86_400_000);
}

export function formatDue(iso: string | null, now: Date): string {
  if (!iso) return '';
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return '';
  const days = dayDiff(due, now);
  if (due.getTime() < now.getTime()) {
    return days === 0
      ? `was due at ${clock(due)}`
      : `was due ${due.toLocaleDateString([], { weekday: 'long' })}`;
  }
  if (days === 0)
    return due.getHours() >= 18 ? `due tonight at ${clock(due)}` : `due today at ${clock(due)}`;
  if (days === 1) return `due tomorrow at ${clock(due)}`;
  if (days < 7) return `due ${due.toLocaleDateString([], { weekday: 'short' })} at ${clock(due)}`;
  return `due ${due.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

/** The shortest useful due text, for one-line spots like the home cue. */
export function formatDueShort(iso: string | null, now: Date): string {
  if (!iso) return '';
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return '';
  const days = dayDiff(due, now);
  if (due.getTime() < now.getTime()) return 'past due';
  if (days === 0) return clock(due);
  if (days === 1) return 'tomorrow';
  if (days < 7) return due.toLocaleDateString([], { weekday: 'short' });
  return due.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Joins meta fragments as a sentence ("Chemistry, due Fri at 9:00 AM"). */
export function metaSentence(parts: Array<string | null | undefined | false>): string {
  return parts.filter(Boolean).join(', ');
}

export function formatMinutes(min: number | null): string {
  if (!min || min <= 0) return '';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "3:32 PM" today, "Tue 3:32 PM" earlier in the week, "Sep 20" beyond. */
export function stamp(d: Date, now: Date): string {
  const days = dayDiff(now, d);
  if (days === 0) return clock(d);
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${clock(d)}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Who really sent an email, as the server proved it. */
export function senderLine(sender: { host: string; tier?: string; school?: boolean; schoolDomain?: boolean } | null | undefined): string {
  if (!sender) return 'From school email';
  // Schoology and the district's own tools mail from their own domains.
  if (/(^|\.)schoology\.com$/i.test(sender.host)) return 'Sent through Schoology';
  const tier = sender.tier ?? (sender.school ? 'district' : 'outside');
  if (tier === 'district') return 'From the school, verified';
  if (tier === 'student') return `From a student account, ${sender.host}`;
  // A school address Gmail could not confirm: say exactly that, not "outside".
  if (sender.schoolDomain === true) return `${sender.host} address, sender not confirmed`;
  return `From outside the school, ${sender.host}`;
}

/** The reject choice, in plain words for where the item came from:
 * his own task is removed, his own project step is skipped, and anything a
 * source suggested is "Not for me". */
export function skipLabel(item: { source: string }): string {
  return item.source === 'manual' ? 'Remove' : item.source === 'project' ? 'Skip step' : 'Not for me';
}
