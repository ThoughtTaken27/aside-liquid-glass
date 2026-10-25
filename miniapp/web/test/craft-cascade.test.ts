import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Vite's multi-entry build moves system.css into a shared chunk that loads
 * BEFORE main/desk CSS, so the craft layer cannot win on order. Every style
 * rule must win on specificity instead: at least two :root levels.
 * (Oct 17: the Next switch, row actions and desk title shipped but lost to
 * equal-specificity rules loaded after them.)
 */
describe('craft system is order-proof', () => {
  it('every style selector in system.css starts with :root:root', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/theme/system.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@(-webkit-)?keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '')
      .replace(/@(media|supports|container)[^{]*\{/g, '');
    const headers = [...css.matchAll(/([^{};]+)\{/g)].map((m) => m[1].trim()).filter(Boolean);
    // Split on top-level commas only (not the ones inside :is() / :not()).
    const split = (h: string) => {
      const out: string[] = [];
      let depth = 0;
      let cur = '';
      for (const c of h) {
        if (c === '(') depth++;
        if (c === ')') depth--;
        if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += c;
      }
      out.push(cur.trim());
      return out;
    };
    const bad = headers.flatMap(split).filter((s) => s && !s.startsWith(':root:root'));
    expect(bad).toEqual([]);
  });
});
