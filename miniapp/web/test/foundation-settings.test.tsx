import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsScreen } from '../src/components/SettingsScreen';
import { api } from '../src/api';
import type { MiniappSettings } from '../src/types';

const defaults: MiniappSettings = { defaultProvider: '', defaultModelId: '', defaultEffort: '', defaultPermissionMode: null, defaultFinalConfirm: false };
let previous: string | undefined;
beforeEach(() => {
  previous = document.documentElement.dataset.client;
  document.documentElement.dataset.client = 'standalone';
  vi.spyOn(api, 'settings').mockResolvedValue({ settings: { ...defaults } });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  if (previous === undefined) delete document.documentElement.dataset.client;
  else document.documentElement.dataset.client = previous;
});

describe('TypeUI clickable settings labels', () => {
  it('delegates a whole-row label click to exactly one existing switch action', async () => {
    const save = vi.spyOn(api, 'saveSettings').mockImplementation(async patch => ({ settings: { ...defaults, ...patch } }));
    render(<SettingsScreen status={null} onClose={() => {}} />);
    const control = await screen.findByRole('switch', { name: 'Confirm before acting by default' });
    const row = control.closest('label');
    expect(row).not.toBeNull();
    expect((row as HTMLLabelElement).control).toBe(control);
    fireEvent.click(screen.getByText('Confirm before acting', { exact: true }));
    await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith({ defaultFinalConfirm: true }));
    expect(control.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(control);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]).toEqual([{ defaultFinalConfirm: false }]);
  });
  it('does not turn read-only rows into clickable labels or alter Telegram rows', async () => {
    document.documentElement.dataset.client = 'telegram';
    render(<SettingsScreen status={null} onClose={() => {}} />);
    const control = await screen.findByRole('switch', { name: 'Confirm before acting by default' });
    expect(control.closest('label')).toBeNull();
    expect(screen.getByText('Account default model').closest('[data-surface-row]')?.tagName).toBe('DIV');
  });
  it('exposes the selected setting choice without relying on its color', async () => {
    render(<SettingsScreen status={null} onClose={() => {}} />);
    await screen.findByRole('switch', { name: 'Confirm before acting by default' });
    fireEvent.click(screen.getByRole('button', { name: /^Model/ }));
    expect(screen.getByRole('button', { name: 'Aside’s default' }).getAttribute('aria-pressed')).toBe('true');
  });
});
