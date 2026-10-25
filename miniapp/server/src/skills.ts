/**
 * The skills the "/" menu offers, read straight from the account's
 * skills folder.
 *
 * The desktop composer gets its list from the daemon's
 * `projects.listSkills`, which the `aside repl` facade does not expose. The
 * same facts live on disk -- every skill is a folder with a SKILL.md whose
 * frontmatter carries its name, description, and the flags that hide it --
 * so this reads them directly and applies the desktop's rules:
 *
 *  - `metadata.internal: true` is never offered (the channel bridge skill);
 *  - `settingsGate: a.b` hides a skill unless that setting is on;
 *  - display names follow the desktop's formatter, so "goal-loop" reads
 *    "Goal Loop" and "x-twitter" reads "X / Twitter".
 *
 * Self-updating: a cheap signature (each SKILL.md's mtime plus the
 * settings file's) is computed per request, and the folder is only
 * re-read when it changes, so a skill added, edited or deleted on the Mac
 * shows up on the next open of the menu without a restart.
 *
 * Self-healing: one malformed SKILL.md drops that skill, not the list; a
 * failed scan serves the last good list marked `stale` and tries again on
 * the next request.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type SkillGroup = 'yours' | 'builtin' | 'sites';

export interface SkillEntry {
  /** Stable across scans: the SKILL.md path relative to the skills root. */
  id: string;
  name: string;
  slug: string;
  description: string;
  group: SkillGroup;
  /** Absolute SKILL.md path, which is what the `[$Name](path)` token carries. */
  path: string;
}

export interface SkillCatalogSnapshot {
  version: string;
  skills: SkillEntry[];
  stale?: boolean;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACRONYMS = new Set(['API', 'CSV', 'DOCX', 'HTML', 'PDF', 'PPTX', 'URL', 'XLSX']);
const SPECIAL = new Map([['x-twitter', 'X / Twitter']]);

/** The desktop composer's display-name rule, ported. */
export function displayName(slug: string, name?: string): string {
  const given = name?.trim();
  if (given && given !== slug && !SLUG.test(given)) return given;
  const base = given || slug;
  return (
    SPECIAL.get(base) ??
    base
      .split('-')
      .map((word) => {
        const upper = word.toUpperCase();
        return ACRONYMS.has(upper) ? upper : word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(' ')
  );
}

const unquote = (v: string) => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  return t;
};

/**
 * Just enough YAML for skill frontmatter: top-level scalars, folded or
 * literal block scalars, and one level of nesting (`metadata.internal`).
 * Anything it does not understand is ignored rather than fatal.
 */
export function parseFrontmatter(source: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) return {};
  const out: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  let parent = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const nested = /^\s{2,}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (nested && parent) {
      out[`${parent}.${nested[1]}`] = unquote(nested[2]);
      continue;
    }
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!top) continue;
    const [, key, raw] = top;
    if (raw === '' ) {
      parent = key;
      continue;
    }
    parent = '';
    if (raw === '>' || raw === '|' || raw === '>-' || raw === '|-') {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || !lines[i + 1].trim())) {
        block.push(lines[++i].trim());
      }
      out[key] = block.join(raw.startsWith('>') ? ' ' : '\n').trim();
      continue;
    }
    out[key] = unquote(raw);
  }
  return out;
}

function settingOn(settings: unknown, dotted: string): boolean {
  let node: unknown = settings;
  for (const part of dotted.split('.')) {
    if (!node || typeof node !== 'object') return false;
    node = (node as Record<string, unknown>)[part];
  }
  return node === true || (typeof node === 'object' && node !== null && (node as { enabled?: unknown }).enabled === true);
}

const ROOTS: { rel: string; group: SkillGroup }[] = [
  { rel: 'user', group: 'yours' },
  { rel: 'builtin', group: 'builtin' },
  { rel: 'builtin/site-specific', group: 'sites' },
];

export class SkillCatalog {
  private last: SkillCatalogSnapshot | null = null;
  private lastSignature = '';

  private readonly skillsRoot: string;
  private readonly settingsPath: string;

  constructor(skillsRoot: string, settingsPath: string) {
    this.skillsRoot = skillsRoot;
    this.settingsPath = settingsPath;
  }

  private skillFiles(): { file: string; group: SkillGroup; slug: string }[] {
    const found: { file: string; group: SkillGroup; slug: string }[] = [];
    for (const root of ROOTS) {
      const dir = path.join(this.skillsRoot, root.rel);
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const file = path.join(dir, name, 'SKILL.md');
        if (fs.existsSync(file)) found.push({ file, group: root.group, slug: name });
      }
    }
    return found;
  }

  private signature(files: { file: string }[]): string {
    const hash = crypto.createHash('sha1');
    for (const { file } of files) {
      let m = 0;
      try {
        m = fs.statSync(file).mtimeMs;
      } catch {
        /* vanished mid-scan; the next request settles it */
      }
      hash.update(`${file}:${m}\n`);
    }
    try {
      hash.update(`settings:${fs.statSync(this.settingsPath).mtimeMs}`);
    } catch {
      hash.update('settings:none');
    }
    return hash.digest('hex').slice(0, 16);
  }

  private scan(files: { file: string; group: SkillGroup; slug: string }[], version: string): SkillCatalogSnapshot {
    let settings: unknown = {};
    try {
      settings = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
    } catch {
      /* no settings: every gated skill stays hidden, the rest are fine */
    }
    const skills: SkillEntry[] = [];
    for (const { file, group, slug } of files) {
      try {
        const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        if (fm['metadata.internal'] === 'true' || fm.internal === 'true') continue;
        if (fm.settingsGate && !settingOn(settings, fm.settingsGate)) continue;
        if (fm.platform && !/mac/i.test(fm.platform)) continue;
        skills.push({
          id: path.relative(this.skillsRoot, file),
          name: displayName(slug, fm.name),
          slug,
          description: (fm.description || '').replace(/\s+/g, ' ').trim(),
          group,
          path: file,
        });
      } catch {
        /* one bad file never costs the whole menu */
      }
    }
    const order: Record<SkillGroup, number> = { yours: 0, builtin: 1, sites: 2 };
    skills.sort((a, b) => order[a.group] - order[b.group] || a.name.localeCompare(b.name));
    return { version, skills };
  }

  get(): SkillCatalogSnapshot {
    try {
      const files = this.skillFiles();
      const version = this.signature(files);
      if (this.last && version === this.lastSignature) return this.last;
      const next = this.scan(files, version);
      this.last = next;
      this.lastSignature = version;
      return next;
    } catch {
      if (this.last) return { ...this.last, stale: true };
      return { version: 'empty', skills: [], stale: true };
    }
  }
}
