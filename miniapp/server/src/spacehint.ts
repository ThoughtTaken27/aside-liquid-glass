/**
 * "Which space does this new task belong in?" Plain word rules first (his
 * real class names included); Jev only when the rules can't tell. The answer
 * only preselects a chip in the add form. He can always change it.
 */
import { choice, type Jev } from './jev.js';
import type { NextSpace } from './next.js';

const SCHOOL = /\b(mr|mrs|ms|dr)\.?\s+[a-z]|\b(homework|hw|quiz|test|exam|worksheet|chapter|ch\.?\s?\d|unit\s?\d|schoology|syllabus|study guide|midterm|finals?|annotat\w*|apush|frqs?|mcqs?|vocab|reading log|extra credit|makeup|retake|period \d|teacher|counselor)\b/i;
const PERSONAL = /\b(mom|mum|dad|parents?|family|brother|sister|grandma|grandpa|dentist|doctor|haircut|groceries|grocery|amazon|bank|gym|workout|birthday|laundry|dmv|passport|flight|temple|church|common app|college app\w*|personal statement|scholarship|fafsa|css profile)\b/i;

export interface SpaceHint {
  space: NextSpace;
  by: 'rules' | 'jev';
  p: number;
}

export function ruleSpace(title: string, courses: string[] = []): SpaceHint | null {
  const t = ` ${title.toLowerCase()} `;
  const course = courses.some((c) => {
    const w = c.toLowerCase().replace(/\bhnrs\b/, 'honors').split(/\s+/).filter((x) => x.length > 3 && !/^(honors|ap)$/.test(x));
    return w.some((x) => t.includes(` ${x} `) || t.includes(` ${x}`));
  });
  const s = SCHOOL.test(title) || course;
  const p = PERSONAL.test(title);
  if (s && !p) return { space: 'school', by: 'rules', p: 1 };
  if (p && !s) return { space: 'personal', by: 'rules', p: 1 };
  return null;
}

export interface SpaceContext {
  school: string[];
  personal: string[];
}

export async function suggestSpace(title: string, courses: string[], jev: Jev | null, ctx: SpaceContext = { school: [], personal: [] }): Promise<SpaceHint | null> {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (clean.length < 3) return null;
  const rule = ruleSpace(clean, courses);
  if (rule || !jev) return rule;
  if (jev.left('you') < 40) return null;
  const r = await jev.ask({
    state: [
      `A task a high school junior just typed into his planner: "${clean}"`,
      `His classes this year: ${courses.join('; ') || 'unknown'}.`,
      ctx.school.length ? `Things already on his School list: ${ctx.school.slice(0, 8).map((t) => `"${t.slice(0, 60)}"`).join(', ')}.` : '',
      ctx.personal.length ? `Things already on his Personal list: ${ctx.personal.slice(0, 8).map((t) => `"${t.slice(0, 60)}"`).join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    questions: {
      space: {
        type: 'choice',
        instructions: 'Which part of his life is this task for?',
        criteria: {
          school: 'His classes, teachers, homework, tests, or a school club or event',
          personal: 'Family, errands, health, money, friends, hobbies, college applications, or anything else outside class',
        },
      },
    },
    tier: 'you',
    feature: 'next.space',
    ttlMs: 30 * 86_400_000,
  });
  if (!r.ok) return null;
  const c = choice(r.answers, 'space');
  if (!c || c.confidence < 0.5) return null;
  return { space: c.choice as NextSpace, by: 'jev', p: c.probabilities[c.choice] ?? c.confidence };
}
