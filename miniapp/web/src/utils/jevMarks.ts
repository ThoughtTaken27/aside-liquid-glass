/**
 * Plain wording for what Next's second look (Jev) found about an item.
 * Shared by the phone sheet, the rows, and the Mac inspector so they never
 * disagree.
 */
import type { NextItem } from '../types';

const SOURCE_WORD: Record<string, string> = {
  schoology: 'Schoology',
  'school-mail': 'school email',
  mail: 'Gmail',
  manual: 'your list',
  project: 'a project',
  calendar: 'your calendar',
};

export function flagLine(item: Pick<NextItem, 'flag' | 'flagReason' | 'source'>): string | null {
  if (!item.flag) return null;
  if (item.source === 'schoology')
    return `This Schoology text looks like it's trying to instruct an AI (${item.flagReason ?? 'Jev check'}). Next's helpers won't read it.`;
  return `This email looks suspicious: ${item.flagReason ?? 'check the sender in Gmail yourself'}. Next won't touch it.`;
}

function shortDay(iso: string, now: Date): string {
  const d = new Date(iso);
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long' });
}

export function doneHintLine(item: Pick<NextItem, 'doneHint'>, now = new Date()): string | null {
  const h = item.doneHint;
  if (!h) return null;
  // Oct 21: from Aside's Context Awareness, the sentence its screen summary wrote, not an email.
  if (h.via === 'screen') return `Aside saw this on your screen ${shortDay(h.at, now)}: “${h.subject}”`;
  return `An email ${shortDay(h.at, now)} reads like it's already done: “${h.subject}”.`;
}

export function alsoLine(item: Pick<NextItem, 'alsoFrom'>): string | null {
  const a = item.alsoFrom ?? [];
  if (!a.length) return null;
  const where = [...new Set(a.map((x) => SOURCE_WORD[x.source] ?? x.source))].join(' and ');
  return `Also came in by ${where}${a.length === 1 ? `: “${a[0].title}”` : ` (${a.length} copies)`}. Shown once.`;
}

/** "About 45 min" or "About 45 min, a guess". */
export function estLabel(item: Pick<NextItem, 'estBy'>, est: string): string {
  return item.estBy === 'jev' ? `About ${est}, a guess` : `About ${est}`;
}
