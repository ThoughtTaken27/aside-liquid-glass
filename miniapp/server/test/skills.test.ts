import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { displayName, parseFrontmatter, SkillCatalog } from '../src/skills.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  roots.push(root);
  const add = (rel: string, fm: string) => {
    fs.mkdirSync(path.join(root, 'skills', rel), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', rel, 'SKILL.md'), `---\n${fm}\n---\n# body\n`);
  };
  const settings = path.join(root, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ experimental: { on: true } }));
  return { root, add, settings, catalog: new SkillCatalog(path.join(root, 'skills'), settings) };
}

describe('displayName', () => {
  it('matches the desktop formatter', () => {
    expect(displayName('goal-loop', 'goal-loop')).toBe('Goal Loop');
    expect(displayName('x-twitter', 'x-twitter')).toBe('X / Twitter');
    expect(displayName('pdf', 'pdf')).toBe('PDF');
    expect(displayName('imagegen', 'Image Generation')).toBe('Image Generation');
  });
});

describe('parseFrontmatter', () => {
  it('reads quoted, folded and nested keys', () => {
    const fm = parseFrontmatter('---\nname: "a"\ndescription: >\n  one\n  two\nmetadata:\n  internal: true\n---\n');
    expect(fm).toMatchObject({ name: 'a', description: 'one two', 'metadata.internal': 'true' });
  });
});

describe('SkillCatalog', () => {
  it('applies internal, settings-gate and grouping rules', () => {
    const { add, catalog } = rig();
    add('user/goal-loop', 'name: goal-loop\ndescription: loop');
    add('builtin/visualize', 'name: visualize\ndescription: charts');
    add('builtin/channel', 'name: channel\nmetadata:\n  internal: true');
    add('builtin/gated-off', 'name: off\nsettingsGate: experimental.nope');
    add('builtin/gated-on', 'name: on-thing\nsettingsGate: experimental.on');
    add('builtin/site-specific/github', 'name: github\nsiteSpecific: true');
    const names = catalog.get().skills.map((s) => `${s.group}:${s.name}`);
    expect(names).toEqual(['yours:Goal Loop', 'builtin:On Thing', 'builtin:Visualize', 'sites:Github']);
  });

  it('updates itself when a skill is added or edited, and is cached otherwise', () => {
    const { add, catalog } = rig();
    add('user/a', 'name: a');
    const first = catalog.get();
    expect(catalog.get()).toBe(first);
    add('user/b', 'name: b');
    const second = catalog.get();
    expect(second.version).not.toBe(first.version);
    expect(second.skills).toHaveLength(2);
  });

  it('survives a malformed skill and an unreadable settings file', () => {
    const { add, catalog, settings, root } = rig();
    add('user/good', 'name: good');
    fs.mkdirSync(path.join(root, 'skills/user/bad/SKILL.md'), { recursive: true }); // a directory, unreadable as a file
    fs.writeFileSync(settings, '{not json');
    expect(catalog.get().skills.map((s) => s.slug)).toEqual(['good']);
  });
});
