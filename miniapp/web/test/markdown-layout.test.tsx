/** Preserve content and native Markdown semantics on narrow screens. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Markdown } from '../src/components/Markdown';
import { UserBubble } from '../src/components/Thread';
import { WorkFold } from '../src/components/WorkFold';
import type { ThreadWork } from '../src/types';

afterEach(cleanup);

const here = path.dirname(fileURLToPath(import.meta.url));
const componentsCss = readFileSync(
  path.join(here, '../src/theme/components.css'),
  'utf8',
);
const tokensCss = readFileSync(
  path.join(here, '../src/theme/tokens.css'),
  'utf8',
);

/** Collect every declaration applied to one selector, ignoring comments. */
function ruleBody(css: string, selector: string): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(
    `(?:^|\\n)(?:[^{}\\n]*,\\s*\\n)*${escaped}(?:\\s*,[^{]*)?\\s*\\{([^}]*)\\}`,
    'g',
  );
  let body = '';
  for (const match of bare.matchAll(rule)) body += match[1];
  return body;
}

describe('natural mobile reading surfaces', () => {
  it('renders user and work commentary through the selectors under contract', async () => {
    const user = render(<UserBubble text="A user paragraph long enough to wrap." />);
    expect(user.container.querySelector('.user-bubble-body')?.textContent).toBe(
      'A user paragraph long enough to wrap.',
    );
    user.unmount();

    const block: ThreadWork = {
      kind: 'work',
      id: 'work',
      durationMs: 0,
      running: false,
      items: [{ kind: 'text', id: 'commentary', text: 'Work commentary.' }],
    };
    const work = render(
      <WorkFold
        block={block}
        live={false}
        subagentSteps={{}}
        onInspectSubagent={() => {}}
        sources={{}}
        onOpenCitation={() => {}}
      />,
    );
    const commentary = await screen.findByText('Work commentary.');
    expect(
      commentary.matches('.work-text .md-pending, .work-text .md p'),
    ).toBe(true);
    expect(work.container.contains(commentary)).toBe(true);
  });

  it('never justifies a narrow chat reading surface', () => {
    for (const selector of [
      '.user-bubble-body',
      '.md p',
      '.md li',
      '.md-pending',
      '.md h1',
      '.md pre',
      '.md table',
      '.md th',
    ]) {
      expect(ruleBody(componentsCss, selector), selector).not.toMatch(
        /text-align:\s*justify|text-justify:|text-align-last:/,
      );
    }
  });

  /*
   * The reading face is a system sans on ChatGPT's measured metrics, not a
   * serif. the owner compared the two on his own phone and chose this one, so
   * it is a product decision rather than a default worth drifting back off.
   */
  it('sets prose in the system sans reading stack, never a serif', () => {
    const prose = /--font-prose:\s*([^;]+);/.exec(
      tokensCss.replace(/\/\*[\s\S]*?\*\//g, ''),
    )?.[1];
    expect(prose).toBeTruthy();
    expect(prose).toMatch(/ui-sans-serif/);
    expect(prose).toMatch(/sans-serif\s*$/);
    expect(prose).not.toMatch(/ui-serif|New York|Georgia|Palatino/);
  });

  it('holds the measured 16px / 26px reading rhythm', () => {
    const md = ruleBody(componentsCss, '.md');
    expect(md).toMatch(/font-family:\s*var\(--font-prose\)/);
    expect(md).toMatch(/font-size:\s*1rem/);
    expect(md).toMatch(/line-height:\s*1\.625/);
    expect(md).toMatch(/letter-spacing:\s*normal/);
  });
});

describe('readable, lossless Markdown', () => {
  it('keeps bold labels inline without injected icons', () => {
    const { container } = render(<Markdown text={'- **Goals:** Finish the brief.\n- **Notes:** Keep the evidence.'} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getAllByRole('listitem')[0].textContent).toBe('Goals: Finish the brief.');
    expect(container.querySelector('.md-lead-item')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });
  it('preserves links inside bold labels', () => {
    render(<Markdown text={'- **[Project update](https://example.com):** Full details.'} />);
    const link = screen.getByRole('link', { name: 'Project update' });
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.closest('strong')).toBeTruthy();
    expect(screen.getByRole('listitem').textContent).toBe('Project update: Full details.');
  });
  it('preserves a long answer, hierarchy, caveats, table and code', () => {
    const text = '## Decision\n\nThe complete explanation stays here.\n\n- **Reason:** The evidence supports it.\n  - Caveat: verify freshness.\n\n3. Third step\n4. Fourth step\n\n> Important qualification.\n\n| Option | Tradeoff |\n| --- | --- |\n| A | Portability |\n\n```text\nunchanged source content\n```';
    const { container } = render(<Markdown text={text} />);
    expect(screen.getByRole('heading', { name: 'Decision' })).toBeTruthy();
    expect(screen.getByText('The complete explanation stays here.')).toBeTruthy();
    expect(container.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(container.querySelector('blockquote')?.textContent).toContain('Important qualification.');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(container.textContent).toContain('unchanged source content');
    expect(container.textContent).toContain('Caveat: verify freshness.');
  });
});

it('keeps an unlabelled fence in a pre block and inline code inline', () => {
  const { container } = render(<Markdown text={'Inline `value`.\n\n```\nline one\nline two\n```'} />);
  expect(container.querySelector('pre code')?.textContent).toBe('line one\nline two\n');
  expect(container.querySelector('p code')?.textContent).toBe('value');
});
