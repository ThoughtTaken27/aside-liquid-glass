import { describe, expect, it } from 'vitest';
import { rankSlash, skillToken, slashQuery, splitSkillTokens, type SkillItem } from './slash';

const sk = (name: string, slug: string, description = '', group: SkillItem['group'] = 'builtin'): SkillItem => ({
  id: `${group}/${slug}/SKILL.md`, name, slug, description, group, path: `/s/${slug}/SKILL.md`,
});

describe('slashQuery', () => {
  it('opens at the start or after whitespace, with the caret at the run end', () => {
    expect(slashQuery('/', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(slashQuery('make a chart /vis', 17)).toEqual({ start: 13, end: 17, query: 'vis' });
    expect(slashQuery('/vis more', 4)).toEqual({ start: 0, end: 4, query: 'vis' });
  });
  it('stays shut for URLs, fractions, a typed space, and a caret inside a word', () => {
    expect(slashQuery('see a/b', 7)).toBeNull();
    expect(slashQuery('https://x.com/', 14)).toBeNull();
    expect(slashQuery('/vis ', 5)).toBeNull();
    expect(slashQuery('/visual', 3)).toBeNull();
  });
});

describe('rankSlash', () => {
  const skills = [sk('Visualize', 'visualize', 'charts'), sk('Visual Browse', 'visual-browse'), sk('Frontend Design', 'frontend-design', 'intentional visual design', 'yours'), sk('PDF', 'pdf')];
  it('lists commands then skills with no query', () => {
    const all = rankSlash('', skills);
    expect(all[0]).toMatchObject({ kind: 'command', id: 'new' });
    expect(all).toHaveLength(2 + skills.length);
  });
  it('ranks name matches above description matches and drops non-matches', () => {
    const names = rankSlash('visu', skills).map((i) => (i.kind === 'skill' ? i.skill.name : i.name));
    expect(names.slice(0, 2).sort()).toEqual(['Visual Browse', 'Visualize']);
    expect(names).toContain('Frontend Design');
    expect(names.indexOf('Frontend Design')).toBeGreaterThan(1);
    expect(names).not.toContain('PDF');
  });
  it('finds commands by keyword', () => {
    expect(rankSlash('model', skills)[0]).toMatchObject({ kind: 'command', id: 'model' });
  });
});

describe('skill tokens', () => {
  it('serialises like the desktop composer and round-trips with escapes', () => {
    expect(skillToken({ name: 'Visualize', path: '/a/visualize/SKILL.md' })).toBe('[$Visualize](/a/visualize/SKILL.md)');
    const tricky = { name: 'A]b', path: '/x/(y)/SKILL.md' };
    const parts = splitSkillTokens(`go ${skillToken(tricky)} now`);
    expect(parts).toEqual([
      { kind: 'text', text: 'go ' },
      { kind: 'skill', name: 'A]b', path: '/x/(y)/SKILL.md' },
      { kind: 'text', text: ' now' },
    ]);
  });
  it('leaves ordinary markdown links alone', () => {
    expect(splitSkillTokens('[docs](https://x.y)')).toEqual([{ kind: 'text', text: '[docs](https://x.y)' }]);
  });
});
