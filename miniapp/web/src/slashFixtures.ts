/**
 * Lab-only "/" menu data: generic sample skills served in place of the
 * Mac's catalog so the menu can be rendered without a backend. Public
 * fixture, so every name here is made up.
 */
import type { SkillItem } from './utils/slash';

const skill = (group: SkillItem['group'], slug: string, name: string, description: string): SkillItem => ({
  id: `${group}:${slug}`, slug, name, description, group, path: `/skills/${group}/${slug}/SKILL.md`,
});

export const LAB_SKILLS: SkillItem[] = [
  skill('yours', 'daily-plan', 'Daily plan', 'Plan the day from your calendar and tasks'),
  skill('yours', 'write-in-my-voice', 'Write in my voice', 'Draft text that sounds like you'),
  skill('yours', 'design-review', 'Design review', 'Check spacing, type, and contrast on a screen'),
  skill('yours', 'meeting-notes-to-actions', 'Meeting notes to actions', 'Turn rough meeting notes into a task list'),
  skill('builtin', 'pdf', 'PDF', 'Read, merge, split, or fill PDFs'),
  skill('builtin', 'spreadsheets', 'Spreadsheets', 'Read and edit spreadsheet files'),
  skill('builtin', 'image-generation', 'Image generation', 'Make or edit an image from a prompt'),
  skill('sites', 'calendar', 'Calendar', 'Read and create events'),
  skill('sites', 'mail', 'Mail', 'Search and draft email'),
];

export function installSlashLab() {
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/skills')) {
      return Promise.resolve(new Response(JSON.stringify({ version: 'lab', skills: LAB_SKILLS }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    return real(input, init);
  };
}

/**
 * Lab-only touch emulation for desktop QA: answers `(pointer: coarse)` as
 * a phone would and applies the stylesheet's coarse-pointer rules, so the
 * 44px touch rows can be measured without a device.
 */
export function emulateTouch() {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q: string) => {
    if (/pointer:\s*coarse|hover:\s*none/.test(q)) {
      return { matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false } as MediaQueryList;
    }
    return real(q);
  };
  const promote = () => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSMediaRule && /pointer:\s*coarse/.test(rule.conditionText) && !(rule as CSSMediaRule & { qaPromoted?: boolean }).qaPromoted) {
          (rule as CSSMediaRule & { qaPromoted?: boolean }).qaPromoted = true;
          for (const inner of Array.from(rule.cssRules)) sheet.insertRule(inner.cssText, sheet.cssRules.length);
        }
      }
    }
  };
  promote();
  new MutationObserver(promote).observe(document.head, { childList: true, subtree: true });
}
