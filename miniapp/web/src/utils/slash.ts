/**
 * The "/" menu's pure logic: when it is open, how items rank, and the
 * `[$Name](path)` token a picked skill becomes.
 *
 * The token and the ranking are ported from Aside's desktop composer so a
 * message sent from the phone is byte-for-byte what the desktop would
 * send, and the daemon attaches the same skill docs either way.
 */

export type SkillGroup = 'yours' | 'builtin' | 'sites';

export interface SkillItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  group: SkillGroup;
  path: string;
}

export type CommandId = 'new' | 'model';

export type SlashItem =
  | { kind: 'command'; id: CommandId; name: string; description: string }
  | { kind: 'skill'; skill: SkillItem };

export const COMMANDS: { id: CommandId; name: string; slug: string; description: string; keywords: string[] }[] = [
  { id: 'new', name: 'New chat', slug: 'new', description: 'Start a fresh conversation', keywords: ['new', 'chat', 'clear', 'start'] },
  { id: 'model', name: 'Model', slug: 'model', description: 'Switch model or thinking level', keywords: ['model', 'effort', 'thinking', 'switch'] },
];

export const GROUP_LABEL: Record<SkillGroup | 'commands' | 'recent', string> = {
  recent: 'Recent',
  commands: 'Commands',
  yours: 'Your skills',
  builtin: 'Built in',
  sites: 'Sites',
};

/**
 * The open slash query at the caret, if any.
 *
 * Open only when `/` starts the text or follows whitespace (so a URL or a
 * fraction never opens it) and the caret sits at the end of the run with
 * no whitespace typed since: typing a space is how you say "I meant a
 * literal slash".
 */
export function slashQuery(
  value: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  const before = value.slice(0, caret);
  const m = /(^|\s)\/([^\s/]*)$/.exec(before);
  if (!m) return null;
  const start = before.length - m[2].length - 1;
  const after = value.slice(caret);
  if (after && !/^\s/.test(after)) return null;
  return { start, end: caret, query: m[2] };
}

/** Desktop's score: exact, then prefix, then substring; lower is better. */
function keywordScore(keywords: string[], q: string): number {
  let best = Number.MAX_SAFE_INTEGER;
  keywords.forEach((raw, i) => {
    const k = raw.trim().toLowerCase();
    if (!k) return;
    // Earlier keywords (the name) outrank later ones (the description).
    const weight = i === 0 ? 0 : i === 1 ? 1 : 4;
    let s = Number.MAX_SAFE_INTEGER;
    if (k === q) s = 0;
    else if (k.startsWith(q)) s = 1;
    else if (k.split(/[\s/-]+/).some((w) => w.startsWith(q))) s = 3;
    else {
      const at = k.indexOf(q);
      if (at >= 0) s = 10 + at;
    }
    if (s !== Number.MAX_SAFE_INTEGER) best = Math.min(best, s + weight * 2);
  });
  return best;
}

export function rankSlash(query: string, skills: SkillItem[]): SlashItem[] {
  const q = query.trim().toLowerCase();
  const commands: SlashItem[] = COMMANDS.map((c) => ({ kind: 'command', id: c.id, name: c.name, description: c.description }));
  const skillItems: SlashItem[] = skills.map((skill) => ({ kind: 'skill', skill }));
  if (!q) return [...commands, ...skillItems];
  const scored: { item: SlashItem; score: number; name: string }[] = [];
  for (const c of COMMANDS) {
    const score = keywordScore([c.name, ...c.keywords], q);
    if (score < Number.MAX_SAFE_INTEGER) {
      scored.push({ item: { kind: 'command', id: c.id, name: c.name, description: c.description }, score: score - 0.5, name: c.name });
    }
  }
  const seen = new Set<string>();
  for (const skill of skills) {
    const score = keywordScore([skill.name, skill.slug, skill.description], q);
    if (score === Number.MAX_SAFE_INTEGER) continue;
    if (seen.has(skill.path)) continue;
    seen.add(skill.path);
    scored.push({ item: { kind: 'skill', skill }, score, name: skill.name });
  }
  return scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).map((s) => s.item);
}

const escName = (s: string) => s.replaceAll('\\', '\\\\').replaceAll(']', '\\]');
const escPath = (s: string) => s.replaceAll('\\', '\\\\').replaceAll(')', '\\)');
const unesc = (s: string) => s.replace(/\\(.)/g, '$1');

/** Exactly the desktop composer's serialisation of a skill mention. */
export function skillToken(skill: Pick<SkillItem, 'name' | 'path'>): string {
  return `[$${escName(skill.name)}](${escPath(skill.path)})`;
}

export type TextSegment = { kind: 'text'; text: string } | { kind: 'skill'; name: string; path: string };

/** Splits sent text into prose and skill mentions, for drawing chips. */
export function splitSkillTokens(text: string): TextSegment[] {
  const re = /\[\$((?:\\.|[^\]\\])*)\]\(((?:\\.|[^\\)])*)\)/g;
  const out: TextSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    out.push({ kind: 'skill', name: unesc(m[1]), path: unesc(m[2]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** Stable identity for a menu row, shared by recents and React keys. */
export const slashKey = (item: SlashItem) => (item.kind === 'command' ? `c:${item.id}` : `s:${item.skill.path}`);

/** What a row is called after the slash: the command's or skill's slug. */
export function slashLabel(item: SlashItem): string {
  if (item.kind === 'command') return COMMANDS.find((c) => c.id === item.id)?.slug ?? item.name.toLowerCase();
  return item.skill.slug || item.skill.name;
}

/*
 * Recently picked rows, newest first. Only the row identity (a command id
 * or a skill path the menu already lists) is kept, never message text.
 */
const RECENT_KEY = 'aside.slash.recent.v1';
export const RECENT_LIMIT = 3;

export function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string').slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

export function rememberRecent(item: SlashItem): string[] {
  const key = slashKey(item);
  const next = [key, ...readRecent().filter((k) => k !== key)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: recents just do not persist */
  }
  return next;
}

/**
 * Lifts recent rows to the front of the unfiltered list, once each.
 * Returns how many lead rows are recent so the menu can label them; a
 * recent key whose skill no longer exists is skipped.
 */
export function withRecent(items: SlashItem[], recent: string[]): { items: SlashItem[]; recentCount: number } {
  if (!recent.length) return { items, recentCount: 0 };
  const byKey = new Map(items.map((item) => [slashKey(item), item]));
  const lead = recent.map((k) => byKey.get(k)).filter((item): item is SlashItem => Boolean(item));
  if (!lead.length) return { items, recentCount: 0 };
  const taken = new Set(lead.map(slashKey));
  return { items: [...lead, ...items.filter((item) => !taken.has(slashKey(item)))], recentCount: lead.length };
}
