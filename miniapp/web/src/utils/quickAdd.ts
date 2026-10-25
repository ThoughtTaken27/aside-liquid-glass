/**
 * Quick add: "Email Mr. Boyd tomorrow 20m". Plain parsing, no model.
 * Shared by the phone and the Mac so both understand the same phrases.
 */

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');


const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function parseQuickAdd(text: string, now = new Date()): { title: string; due: string | null; estMinutes: number | null; dueLabel: string | null } {
  let t = ` ${text.trim()} `;
  let due: Date | null = null;
  let dueLabel: string | null = null;
  let est: number | null = null;
  const dur = /\s(\d{1,2})\s?h(?:ours?|rs?)?(?:\s?(\d{1,2})\s?m(?:in)?)?\s|\s(\d{1,3})\s?m(?:ins?|inutes?)?\s/i.exec(t);
  if (dur) {
    est = dur[3] ? Number(dur[3]) : Number(dur[1]) * 60 + Number(dur[2] ?? 0);
    t = t.replace(dur[0], ' ');
  }
  const day = (n: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + n);
    return d;
  };
  const rel = /\s(today|tonight|tomorrow|tmrw|(?:next\s)?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|urday|sday)?)\s/i.exec(t);
  if (rel) {
    const w = rel[1].toLowerCase();
    if (w === 'today' || w === 'tonight') (due = day(0)), (dueLabel = w === 'tonight' ? 'Tonight' : 'Today');
    else if (w === 'tomorrow' || w === 'tmrw') (due = day(1)), (dueLabel = 'Tomorrow');
    else {
      const idx = DAYS.findIndex((d) => d.startsWith(rel[2].toLowerCase().slice(0, 3)));
      let n = (idx - now.getDay() + 7) % 7 || 7;
      if (w.startsWith('next ')) n += n < 7 ? 7 : 0;
      due = day(n);
      dueLabel = cap(DAYS[idx]);
    }
    t = t.replace(rel[0], ' ');
  }
  const ymd = due ? `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}` : null;
  return { title: t.replace(/\s+/g, ' ').trim(), due: ymd, estMinutes: est, dueLabel };
}

