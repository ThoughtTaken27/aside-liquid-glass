/**
 * The context meter moved to the composer's edge, and permission moved off
 * the control row.
 *
 * What these lock in is the reasoning, not the pixels: the meter must stay
 * silent when it has nothing to report, it must stay a linear scale, and
 * the permission signal must survive losing its button -- because the one
 * state worth catching in passing is full access, and a decluttered row
 * that hides it is a worse row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Composer } from '../src/components/Composer';
import type { PillState } from '../src/components/Composer';

afterEach(cleanup);

const pills: PillState = {
  modelLabel: 'gpt-6-astra',
  effortLabel: 'High',
  effortId: 'high',
  provider: 'openai',
};

function renderComposer() {
  return render(
    <Composer
      variant="home"
      value=""
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      pills={pills}
      onOpenModel={vi.fn()}
      attachments={[]}
      onAddFiles={vi.fn()}
      onRemoveAttachment={vi.fn()}
    />,
  );
}

describe('permission is not in the composer at all', () => {
  it('has no permission button', () => {
    const { container } = renderComposer();
    expect(container.querySelector('.permission-button')).toBeNull();
  });

  it('has no permission mark on the model pill', () => {
    // It went through a corner dot and an inline glyph, and both earned
    // the same question: what is that. Permission is a setting you change
    // deliberately, not a live readout, so it is named in words in the
    // model sheet instead of asking a colour to carry the meaning.
    const { container } = renderComposer();
    expect(container.querySelector('.pill-badge')).toBeNull();
  });

  it('leaves the pill announcing the model, and only the model', () => {
    renderComposer();
    const pill = screen.getByRole('button', { name: 'gpt-6-astra' });
    expect(pill.classList.contains('pill')).toBe(true);
  });
});
