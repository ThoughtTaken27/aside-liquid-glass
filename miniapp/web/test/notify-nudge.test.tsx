import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const enable = vi.fn();
vi.mock('../src/phoneNotifications', async (orig) => ({
  ...(await orig<typeof import('../src/phoneNotifications')>()),
  enablePhoneNotifications: () => enable(),
  pushSupport: () => null,
  reportSetupFailure: () => {},
}));
vi.mock('../src/standalone', async (orig) => ({ ...(await orig<typeof import('../src/standalone')>()), isStandaloneEntry: () => true }));
import { NotifyNudge, nudgeWanted } from '../src/components/NotifyNudge';

describe('home notification card', () => {
  beforeEach(() => { localStorage.clear(); enable.mockReset(); });
  afterEach(cleanup);
  it('shows once on an unconnected phone and never asks permission on paint', () => {
    render(<NotifyNudge />);
    expect(screen.getByText('Live status')).toBeTruthy();
    expect(enable).not.toHaveBeenCalled();
  });
  it('turns on with one tap, then confirms and leaves', async () => {
    vi.useFakeTimers();
    enable.mockResolvedValue({ id: 'd', preferences: { previews: false, progress: true } });
    render(<NotifyNudge />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Turn on' })); });
    expect(enable).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Live status is on')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1900); });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(screen.queryByText('Live status is on')).toBeNull();
    vi.useRealTimers();
  });
  it('names the failed step and stays to retry', async () => {
    enable.mockRejectedValue(new Error('Google’s push service didn’t answer.'));
    render(<NotifyNudge />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Turn on' })); });
    expect(screen.getByRole('alert').textContent).toContain('push service');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
  it('stays hidden once dismissed or connected', () => {
    render(<NotifyNudge />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(nudgeWanted()).toBe(false);
    localStorage.clear(); localStorage.setItem('aside.phonePushDevice.v1', 'abc');
    expect(nudgeWanted()).toBe(false);
  });
});
