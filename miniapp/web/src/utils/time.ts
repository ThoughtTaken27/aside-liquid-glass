/** Time formatting for the session list and the work fold. */

/**
 * "13 hours ago" -- spelled out, as the sidepanel's session cards do,
 * rather than the abbreviated "13h ago".
 */
export function relativeTime(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 45) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');

  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');

  const days = Math.round(hours / 24);
  if (days < 7) return plural(days, 'day');

  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

/**
 * "39m 8s" -- the exact form in the sidepanel's `Worked for …` row, which
 * always keeps the seconds component.
 */
export function workedFor(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * The bucket a chat belongs to in the history list.
 *
 * The list used to be one undifferentiated run of rows, which is why it
 * read as a pile rather than as history: with only "3 days ago" on each
 * row there is nothing to scan by, and the eye has to read every line to
 * find where this week ends and last month begins.
 *
 * The bands are Claude's and, before that, every mail client's, because
 * they match how people actually search their own past: today, yesterday,
 * this week, this month, then by month.
 *
 * Pure and exported so it can be tested against fixed clocks rather than
 * against whatever "now" happens to be when the suite runs.
 */
export function dayBucket(ms: number, now = Date.now()): string {
  const then = new Date(ms);
  const days = Math.floor(
    (startOfDay(new Date(now)) - startOfDay(then)) / 86_400_000,
  );

  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';

  // Older than a month: label by month, and add the year once it is not
  // the current one, so "March" cannot silently mean either of two Marches.
  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  return then.toLocaleDateString(undefined, {
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * The short stamp on a history row: "2:32 PM" today, "Mon" within the
 * week, "12 Mar" beyond it.
 *
 * `relativeTime`'s spelled-out form ("13 hours ago") is right in a work
 * fold, where the duration is the point. In a dense list it is the longest
 * thing on the row, and it crowds the title -- the thing actually being
 * scanned -- with information the group heading has already given.
 */
export function listTime(ms: number, now = Date.now()): string {
  const then = new Date(ms);
  const days = Math.floor(
    (startOfDay(new Date(now)) - startOfDay(then)) / 86_400_000,
  );

  if (days <= 0) {
    return then.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  if (days < 7) return then.toLocaleDateString(undefined, { weekday: 'short' });
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
