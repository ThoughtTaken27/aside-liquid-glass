import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('toasts', () => {
  it('shows a toast and dismisses it on tap', async () => {
    const { ToastHost, toast } = await import('../src/components/Toasts');
    render(<ToastHost />);
    act(() => {
      toast('Chat deleted');
    });
    const pill = screen.getByText('Chat deleted').closest('.toast')!;
    fireEvent.click(pill);
    await vi.waitFor(() => expect(screen.queryByText('Chat deleted')).toBeNull());
  });

  it('dismisses from the keyboard', async () => {
    const { ToastHost, toast } = await import('../src/components/Toasts');
    render(<ToastHost />);
    act(() => {
      toast('Chat deleted');
    });
    const pill = screen.getByText('Chat deleted').closest('.toast')!;
    expect(pill.getAttribute('role')).toBe('button');
    fireEvent.keyDown(pill, { key: 'Enter' });
    await vi.waitFor(() => expect(screen.queryByText('Chat deleted')).toBeNull());
  });

  it('fires the action and carries its tone class', async () => {
    const { ToastHost, toast } = await import('../src/components/Toasts');
    const onClick = vi.fn();
    render(<ToastHost />);
    act(() => {
      toast('Chat could not load', {
        tone: 'error',
        action: { label: 'Retry', onClick },
      });
    });
    const pill = screen.getByText('Chat could not load').closest('.toast')!;
    expect(pill.className).toContain('is-error');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('slide to confirm', () => {
  it('commits from the keyboard at the end of the track', async () => {
    const { SlideToConfirm } = await import(
      '../src/components/SlideToConfirm'
    );
    const onConfirm = vi.fn();
    render(
      <SlideToConfirm label="Slide to allow full access" onConfirm={onConfirm} />,
    );
    const knob = screen.getByRole('slider', {
      name: 'Slide to allow full access',
    });
    fireEvent.keyDown(knob, { key: 'ArrowRight' });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(knob, { key: 'End' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Done')).toBeTruthy();
  });

  it('stays put when disabled', async () => {
    const { SlideToConfirm } = await import(
      '../src/components/SlideToConfirm'
    );
    const onConfirm = vi.fn();
    render(
      <SlideToConfirm
        label="Slide to allow full access"
        onConfirm={onConfirm}
        disabled
      />,
    );
    fireEvent.keyDown(
      screen.getByRole('slider', { name: 'Slide to allow full access' }),
      { key: 'End' },
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('count up', () => {
  it('settles on the new value', async () => {
    vi.useFakeTimers();
    const { CountUp } = await import('../src/components/CountUp');
    const { rerender } = render(
      <CountUp value={100} format={(n) => Math.round(n).toString()} />,
    );
    expect(document.body.textContent).toBe('100');
    rerender(<CountUp value={250} format={(n) => Math.round(n).toString()} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.body.textContent).toBe('250');
  });
});

describe('activity island', () => {
  const activity = {
    label: 'Reading 00-Self',
    work: 'tools' as const,
    detail: null,
    seed: 'test',
    startedAt: Date.now() - 30_000,
    tokens: 500,
  };

  it('expands on tap and stops from the expanded state', async () => {
    const { ActivityIsland } = await import(
      '../src/components/ActivityIsland'
    );
    const onStop = vi.fn();
    render(
      <ActivityIsland
        activity={activity}
        stoppable
        stopping={false}
        onStop={onStop}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Stop this turn' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand turn status' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop this turn' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('hides the stop when this server does not own the turn', async () => {
    const { ActivityIsland } = await import(
      '../src/components/ActivityIsland'
    );
    render(
      <ActivityIsland
        activity={activity}
        stoppable={false}
        stopping={false}
        onStop={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand turn status' }));
    expect(screen.queryByRole('button', { name: 'Stop this turn' })).toBeNull();
  });
});

describe('pull to refresh', () => {
  it('refreshes on a committed pull and stays quiet on a short one', async () => {
    const { PullToRefresh } = await import('../src/components/PullToRefresh');
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const scroller = createRef<HTMLElement>();
    const { container, unmount } = render(
      <div>
        <div
          ref={scroller as React.RefObject<HTMLDivElement>}
          style={{ overflowY: 'auto' }}
        />
        <PullToRefresh scroller={scroller} onRefresh={onRefresh}>
          <p>hero</p>
        </PullToRefresh>
      </div>,
    );
    const root = container.querySelector('.pull-refresh')!;
    const touch = (y: number) => ({ touches: [{ clientY: y }] }) as unknown as TouchEvent;

    // Short pull: down 30px of finger travel never reaches the commit
    // point, so releasing does nothing.
    root.dispatchEvent(new TouchEvent('touchstart', touch(100)));
    root.dispatchEvent(new TouchEvent('touchmove', touch(130)));
    root.dispatchEvent(new TouchEvent('touchend', { touches: [] } as unknown as TouchEventInit));
    await vi.waitFor(() => expect(onRefresh).not.toHaveBeenCalled());

    // Committed pull: far enough to arm, then release.
    root.dispatchEvent(new TouchEvent('touchstart', touch(100)));
    root.dispatchEvent(new TouchEvent('touchmove', touch(300)));
    root.dispatchEvent(new TouchEvent('touchend', { touches: [] } as unknown as TouchEventInit));
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    unmount();
  });
});

describe('full access slide', () => {
  it('asks for a slide instead of picking on tap', async () => {
    const { ModelSheet } = await import('../src/components/ModelSheet');
    const onPickMode = vi.fn();
    render(
      <ModelSheet
        catalog={[]}
        currentProvider=""
        currentModel=""
        effortOptions={[]}
        currentEffort=""
        permissionOptions={[
          { id: 'guard', label: 'Guard' },
          { id: 'full-access', label: 'Full access' },
        ]}
        permissionMode="guard"
        finalConfirm={false}
        onPickMode={onPickMode}
        onToggleConfirm={() => {}}
        onPickModel={() => {}}
        onPickEffort={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Permission/ }));
    fireEvent.click(screen.getByRole('button', { name: /Full access/ }));
    expect(onPickMode).not.toHaveBeenCalled();
    fireEvent.keyDown(
      screen.getByRole('slider', { name: 'Slide to allow full access' }),
      { key: 'End' },
    );
    expect(onPickMode).toHaveBeenCalledWith('full-access');
  });
});

describe('slide knob focus', () => {
  it('takes focus on press so arrows work after a tap', async () => {
    const { SlideToConfirm } = await import('../src/components/SlideToConfirm');
    render(<SlideToConfirm label="Slide to allow full access" onConfirm={() => {}} />);
    const knob = screen.getByRole('slider', { name: 'Slide to allow full access' });
    fireEvent.pointerDown(knob);
    expect(document.activeElement).toBe(knob);
  });
});

describe('permission confirm switch', () => {
  it('reflects and toggles on the live permission view', async () => {
    const { ModelSheet } = await import('../src/components/ModelSheet');
    const onToggleConfirm = vi.fn();
    render(
      <ModelSheet
        catalog={[]}
        currentProvider=""
        currentModel=""
        effortOptions={[]}
        currentEffort=""
        permissionOptions={[{ id: 'guard', label: 'Guard' }]}
        permissionMode="guard"
        finalConfirm
        onPickMode={() => {}}
        onToggleConfirm={onToggleConfirm}
        onPickModel={() => {}}
        onPickEffort={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Permission/ }));
    const sw = screen.getByRole('switch', { name: 'Confirm before acting' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(onToggleConfirm).toHaveBeenCalledWith(false);
    expect(screen.getByText('Applies from your next message.')).toBeTruthy();
  });
});
