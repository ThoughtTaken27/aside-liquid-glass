/**
 * The polish round: what must not silently regress.
 *
 * Three things here are behaviour, not decoration, and each of them is a
 * bug that was actually reported:
 *
 *  1. The phone keyboard's return key inserting a newline instead of
 *     firing a half-written message.
 *  2. History being one undifferentiated pile of rows.
 *  3. Delete existing at all, and being confirmed before it happens.
 *
 * The CSS work (the scrim, the motion curves) is deliberately NOT asserted
 * here. jsdom does not lay out or composite, so any test of it would be
 * checking that a string appears in a stylesheet, which passes just as
 * happily when the effect is broken.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// This project does not enable vitest's `globals`, so testing-library's
// auto-cleanup hook never registers itself. Without this every render in
// the file stacks up in the same document and the second test in a block
// fails on "found multiple elements".
afterEach(cleanup);
import { Composer } from '../src/components/Composer';
import { groupByDay } from '../src/components/SessionList';
import { dayBucket, listTime } from '../src/utils/time';
import type { SessionRow } from '../src/types';

function composerProps(overrides: Record<string, unknown> = {}) {
  return {
    variant: 'reply' as const,
    value: 'hello',
    onChange: () => {},
    onSubmit: () => {},
    pills: { modelLabel: 'Sonnet', effortLabel: 'High', effortId: 'high' },
    onOpenModel: () => {},
    onOpenPermission: () => {},
    permissionMode: 'guard',
    attachments: [],
    onAddFiles: () => {},
    onRemoveAttachment: () => {},
    ...overrides,
  };
}

/** Force `matchMedia` to report a given primary pointer. */
function setPointer(kind: 'coarse' | 'fine') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes(`pointer: ${kind}`),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe('the return key on a phone', () => {
  afterEach(() => {
    // @ts-expect-error -- restoring the jsdom default
    delete window.matchMedia;
  });


  it('inserts a newline instead of sending on a touch device', () => {
    setPointer('coarse');
    const onSubmit = vi.fn();
    render(<Composer {...composerProps({ onSubmit })} />);

    const input = screen.getByRole('textbox');
    const event = fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
    // Not prevented, so the textarea does its own default thing: a newline.
    expect(event).toBe(true);
  });

  it('still sends on Enter where the pointer is a mouse', () => {
    setPointer('fine');
    const onSubmit = vi.fn();
    render(<Composer {...composerProps({ onSubmit })} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('never sends on Shift+Enter, on either kind of device', () => {
    for (const kind of ['coarse', 'fine'] as const) {
      setPointer(kind);
      const onSubmit = vi.fn();
      const view = render(<Composer {...composerProps({ onSubmit })} />);
      fireEvent.keyDown(view.getByRole('textbox'), {
        key: 'Enter',
        shiftKey: true,
      });
      expect(onSubmit).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it('leaves the send button as the way out on a touch device', () => {
    setPointer('coarse');
    const onSubmit = vi.fn();
    render(<Composer {...composerProps({ onSubmit })} />);

    fireEvent.click(screen.getByLabelText('Send'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('history date bands', () => {
  // A fixed clock. Every expectation below is relative to it, so the suite
  // does not change meaning at midnight.
  const now = new Date('2026-08-04T15:00:00').getTime();
  const days = (n: number) => now - n * 86_400_000;

  it('names the near bands the way a reader thinks about them', () => {
    expect(dayBucket(now - 3_600_000, now)).toBe('Today');
    expect(dayBucket(days(1), now)).toBe('Yesterday');
    expect(dayBucket(days(3), now)).toBe('Previous 7 days');
    expect(dayBucket(days(14), now)).toBe('Previous 30 days');
  });

  it('counts calendar days, not elapsed hours', () => {
    // 01:00 today vs 23:00 yesterday is two hours apart and still must
    // land in different bands -- this is the off-by-one that makes a list
    // say "Today" above something from the night before.
    const oneAm = new Date('2026-08-04T01:00:00').getTime();
    const elevenPmYesterday = new Date('2026-08-03T23:00:00').getTime();
    expect(dayBucket(oneAm, oneAm)).toBe('Today');
    expect(dayBucket(elevenPmYesterday, oneAm)).toBe('Yesterday');
  });

  it('falls back to month names, with the year only when it differs', () => {
    const march = new Date('2026-03-02T10:00:00').getTime();
    const lastYear = new Date('2025-11-02T10:00:00').getTime();
    expect(dayBucket(march, now)).toBe('March');
    expect(dayBucket(lastYear, now)).toContain('2025');
  });

  it('groups consecutive rows and preserves their order', () => {
    const rows = [
      { id: 'a', updatedAt: now - 3_600_000 },
      { id: 'b', updatedAt: now - 7_200_000 },
      { id: 'c', updatedAt: days(1) },
      { id: 'd', updatedAt: days(4) },
    ] as SessionRow[];

    const groups = groupByDay(rows, now);
    expect(groups.map((g) => g.label)).toEqual([
      'Today',
      'Yesterday',
      'Previous 7 days',
    ]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('does not merge two non-adjacent runs of the same band', () => {
    // A reversed sort can legitimately produce Today ... Today again. The
    // grouping must follow the order it was given rather than re-sorting,
    // or the heading would end up above rows it does not describe.
    const rows = [
      { id: 'a', updatedAt: now },
      { id: 'b', updatedAt: days(1) },
      { id: 'c', updatedAt: now },
    ] as SessionRow[];
    expect(groupByDay(rows, now)).toHaveLength(3);
  });

  it('keeps the row stamp short so it cannot crowd the title', () => {
    // The whole point of replacing "13 hours ago" on each row.
    expect(listTime(days(3), now)).not.toMatch(/ago/);
    expect(listTime(days(3), now).length).toBeLessThanOrEqual(6);
    expect(listTime(days(40), now)).not.toMatch(/ago/);
  });
});

describe('deleting a chat', () => {
  beforeEach(() => {
    setPointer('coarse');
  });

  afterEach(() => {
    // @ts-expect-error -- restoring the jsdom default
    delete window.matchMedia;
  });

  it('asks before it deletes, and does nothing if the answer is no', async () => {
    const { SessionList } = await import('../src/components/SessionList');
    const telegram = await import('../src/telegram');
    const confirm = vi
      .spyOn(telegram, 'showConfirm')
      .mockResolvedValue(false);
    const onDelete = vi.fn().mockResolvedValue(undefined);

    const sessions = [
      {
        id: 's1',
        title: 'A chat',
        preview: '',
        updatedAt: Date.now(),
        status: 'idle',
        unread: false,
      },
    ] as SessionRow[];

    render(
      <SessionList sessions={sessions} onOpen={() => {}} onDelete={onDelete} />,
    );

    fireEvent.click(screen.getByLabelText('Delete'));
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(onDelete).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('draws no delete affordance at all when deleting is not offered', async () => {
    const { SessionList } = await import('../src/components/SessionList');
    const sessions = [
      {
        id: 's1',
        title: 'A chat',
        preview: '',
        updatedAt: Date.now(),
        status: 'idle',
        unread: false,
      },
    ] as SessionRow[];

    render(<SessionList sessions={sessions} onOpen={() => {}} />);
    expect(screen.queryByLabelText('Delete')).toBeNull();
  });
});
