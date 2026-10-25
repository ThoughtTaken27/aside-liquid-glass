/**
 * The desktop's queue, on the phone.
 *
 * Mid-turn with an empty box the one slot is Stop; the moment there is
 * something to send it becomes Send (which queues), and clearing the box
 * brings Stop back. Queued messages show as cards with Send now, Edit and
 * Remove, and each control reports the card it belongs to.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer, type PillState } from '../src/components/Composer';
import { QueuedMessages } from '../src/components/QueuedMessages';
import type { QueuedMessage } from '../src/types';

afterEach(cleanup);

const pills: PillState = { modelLabel: 'm', effortLabel: 'High', effortId: 'high' };

function composer(value: string, extra: Record<string, unknown> = {}) {
  const onSubmit = vi.fn();
  const onStop = vi.fn();
  const view = render(
    <Composer
      variant="reply"
      value={value}
      onChange={vi.fn()}
      onSubmit={onSubmit}
      pills={pills}
      onOpenModel={vi.fn()}
      attachments={[]}
      onAddFiles={vi.fn()}
      onRemoveAttachment={vi.fn()}
      streaming
      onStop={onStop}
      {...extra}
    />,
  );
  const slot = view.container.querySelector('.round-button.send') as HTMLButtonElement;
  return { ...view, slot, onSubmit, onStop };
}

describe('the primary slot while a turn runs', () => {
  it('is Stop when the box is empty', () => {
    const { slot, onStop, onSubmit } = composer('');
    expect(slot.dataset.composerControl).toBe('stop');
    expect(slot.getAttribute('aria-label')).toBe('Stop');
    fireEvent.click(slot);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('is Stop for whitespace only', () => {
    expect(composer('   ').slot.dataset.composerControl).toBe('stop');
  });

  it('becomes Send (queue) as soon as there is text, and sends instead of stopping', () => {
    const { slot, onStop, onSubmit } = composer('also check dark mode');
    expect(slot.dataset.composerControl).toBe('send');
    expect(slot.getAttribute('aria-label')).toBe('Queue message');
    expect(slot.classList.contains('stop')).toBe(false);
    expect(slot.disabled).toBe(false);
    fireEvent.click(slot);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('goes back to Stop when the box is cleared', () => {
    const view = composer('draft');
    expect(view.slot.dataset.composerControl).toBe('send');
    view.rerender(
      <Composer
        variant="reply"
        value=""
        onChange={vi.fn()}
        onSubmit={view.onSubmit}
        pills={pills}
        onOpenModel={vi.fn()}
        attachments={[]}
        onAddFiles={vi.fn()}
        onRemoveAttachment={vi.fn()}
        streaming
        onStop={view.onStop}
      />,
    );
    const slot = view.container.querySelector('.round-button.send') as HTMLButtonElement;
    expect(slot.dataset.composerControl).toBe('stop');
  });

  it('is plain Send when nothing is running', () => {
    const { slot } = composer('hello', { streaming: false });
    expect(slot.dataset.composerControl).toBe('send');
    expect(slot.getAttribute('aria-label')).toBe('Send');
  });
});

const item = (id: string, text: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id,
  text,
  attachments: [],
  at: 1,
  ...extra,
});

describe('queued cards', () => {
  it('renders one card per waiting message with its words', () => {
    render(
      <QueuedMessages
        items={[item('a', 'keep going'), item('b', 'then test')]}
        onSendNow={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText('keep going')).toBeTruthy();
    expect(screen.getByText('then test')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Send now' })).toHaveLength(2);
  });

  it('routes Send now, Edit and Remove to the right message', () => {
    const onSendNow = vi.fn();
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    render(
      <QueuedMessages
        items={[item('a', 'one'), item('b', 'two')]}
        onSendNow={onSendNow}
        onEdit={onEdit}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Send now' })[1]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit queued message' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove queued message' })[1]);
    expect(onSendNow.mock.calls[0][0].id).toBe('b');
    expect(onEdit.mock.calls[0][0].id).toBe('a');
    expect(onRemove.mock.calls[0][0].id).toBe('b');
  });

  it('ignores taps on an optimistic card until the server has acknowledged it', () => {
    const onSendNow = vi.fn();
    render(
      <QueuedMessages
        items={[item('local-1', 'pending', { local: true })]}
        onSendNow={onSendNow}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    expect(onSendNow).not.toHaveBeenCalled();
  });

  it('animates a removed card out, then drops it', () => {
    vi.useFakeTimers();
    try {
      const props = { onSendNow: vi.fn(), onEdit: vi.fn(), onRemove: vi.fn() };
      const view = render(<QueuedMessages items={[item('a', 'bye')]} {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'Remove queued message' }));
      view.rerender(<QueuedMessages items={[]} {...props} />);
      const row = view.container.querySelector('.queued-row') as HTMLElement;
      expect(row.dataset.leaving).toBe('remove');
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(view.container.querySelector('.queued-row')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a card that leaves on its own (its turn started) exits upward as sent', () => {
    const props = { onSendNow: vi.fn(), onEdit: vi.fn(), onRemove: vi.fn() };
    const view = render(<QueuedMessages items={[item('a', 'go')]} {...props} />);
    view.rerender(<QueuedMessages items={[]} {...props} />);
    expect((view.container.querySelector('.queued-row') as HTMLElement).dataset.leaving).toBe('sent');
  });
});
