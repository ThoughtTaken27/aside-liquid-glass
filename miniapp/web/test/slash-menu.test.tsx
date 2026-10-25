/**
 * The "/" menu, rebuilt on the AI SDK Agents slash command menu.
 *
 * What these lock in: the list floats outside the composer (the voice-glow
 * wrapper clips), recent picks lead the unfiltered list exactly once, the
 * Enter hint appears only where Enter picks, a picked skill becomes a
 * `/slug` chip, and the list never outlives the field it belongs to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { Composer } from '../src/components/Composer';
import { slashRoom } from '../src/components/SlashMenu';
import {
  RECENT_LIMIT,
  rankSlash,
  readRecent,
  rememberRecent,
  slashKey,
  slashLabel,
  withRecent,
  type SkillItem,
} from '../src/utils/slash';

const sk = (slug: string, name: string, group: SkillItem['group'] = 'yours'): SkillItem => ({
  id: `${group}:${slug}`, slug, name, description: `About ${name}`, group, path: `/skills/${group}/${slug}/SKILL.md`,
});
const SKILLS = [sk('daily-plan', 'Daily plan'), sk('pdf', 'PDF', 'builtin'), sk('mail', 'Mail', 'sites')];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('aside.skills.v1', JSON.stringify({ version: 'test', skills: SKILLS }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: 'test', unchanged: true }), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('recent picks', () => {
  it('lead the unfiltered list once, newest first, skipping removed skills', () => {
    const all = rankSlash('', SKILLS);
    const recent = [`s:${SKILLS[1].path}`, 'c:model', 's:/gone/SKILL.md'];
    const { items, recentCount } = withRecent(all, recent);
    expect(recentCount).toBe(2);
    expect(items.map(slashLabel).slice(0, 2)).toEqual(['pdf', 'model']);
    expect(items).toHaveLength(all.length);
    expect(new Set(items.map(slashKey)).size).toBe(items.length);
  });

  it('keep at most three identities and never message text', () => {
    for (const item of rankSlash('', SKILLS)) rememberRecent(item);
    const kept = readRecent();
    expect(kept).toHaveLength(RECENT_LIMIT);
    expect(kept.every((k) => /^(c|s):/.test(k))).toBe(true);
  });
});

describe('room above the composer', () => {
  it('leaves 8px to the composer, 8px to the header, and the 2px border', () => {
    expect(slashRoom(700, 60)).toBe(700 - 8 - 60 - 8 - 2);
  });
});

function Harness({ onNewChat = vi.fn() }: { onNewChat?: () => void }) {
  const [value, setValue] = useState('');
  return (
    <Composer
      variant="reply"
      value={value}
      onChange={setValue}
      onSubmit={vi.fn()}
      pills={{ modelLabel: 'Model A', effortLabel: 'High', effortId: 'high', provider: 'openai' }}
      onOpenModel={vi.fn()}
      onNewChat={onNewChat}
      attachments={[]}
      onAddFiles={vi.fn()}
      onRemoveAttachment={vi.fn()}
    />
  );
}

function typeInto(field: HTMLTextAreaElement, text: string) {
  field.focus();
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
}

describe('the floating menu', () => {
  it('renders outside the clipped composer, grouped like the reference', () => {
    const { container } = render(<Harness />);
    typeInto(screen.getByRole('textbox') as HTMLTextAreaElement, '/');
    const list = screen.getByRole('listbox', { name: 'Commands and skills' });
    expect(container.contains(list)).toBe(false);
    expect(document.body.contains(list)).toBe(true);
    expect(container.querySelector('.composer')?.getAttribute('data-slash-open')).toBe('true');
    const groups = within(list).getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['Commands', 'Your skills', 'Built in', 'Sites']);
    expect(within(list).getByRole('option', { name: /\/daily-plan/ })).toBeTruthy();
  });

  it('shows the Enter key only on the active row, and Enter picks it with a keyboard', () => {
    const onNewChat = vi.fn();
    render(<Harness onNewChat={onNewChat} />);
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeInto(field, '/');
    const active = screen.getByRole('option', { selected: true });
    expect(active.textContent).toContain('/new');
    expect(document.querySelectorAll('.slash-enter')).toHaveLength(1);
    expect(active.querySelector('.slash-enter')).not.toBeNull();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('turns a picked skill into a /slug chip and lists it under Recent next time', async () => {
    render(<Harness />);
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeInto(field, '/pd');
    fireEvent.click(screen.getByRole('option', { name: /\/pdf/ }));
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(document.querySelector('.chip-skill')?.textContent).toContain('/pdf');
    expect(field.value).toBe('');
    typeInto(field, '/');
    const groups = within(screen.getByRole('listbox')).getAllByRole('group');
    expect(groups[0].getAttribute('aria-label')).toBe('Recent');
    expect(within(groups[0]).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('/pdf')]);
    expect(within(screen.getByRole('listbox')).getAllByRole('option', { name: /\/pdf/ })).toHaveLength(1);
  });

  it('hides when the field is left and returns when it is focused again', async () => {
    render(<Harness />);
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeInto(field, '/');
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fireEvent.blur(field);
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.focus(field);
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('closes on Escape for that slash', async () => {
    render(<Harness />);
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeInto(field, '/');
    fireEvent.keyDown(field, { key: 'Escape' });
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
