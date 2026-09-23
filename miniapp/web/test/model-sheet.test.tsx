import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ModelSheet } from '../src/components/ModelSheet';
import { ToastHost } from '../src/components/Toasts';

afterEach(() => {
  document.body.innerHTML = '';
});

const CATALOG = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    connected: true,
    models: [{ id: 'opus-4-6', label: 'Opus 4.6', contextWindow: 200000 }],
  },
  {
    id: 'google',
    label: 'Google',
    connected: false,
    models: [{ id: 'gemini-3-pro', label: 'Gemini 3 Pro', contextWindow: 1000000 }],
  },
];

function renderSheet(pick: (provider: string, modelId: string) => void) {
  render(
    <>
      <ToastHost />
      <ModelSheet
        catalog={CATALOG as never}
        currentProvider="anthropic"
        currentModel="opus-4-6"
        effortOptions={[{ id: 'high', label: 'High' }]}
        currentEffort="high"
        permissionOptions={[{ id: 'guard', label: 'Guard' }]}
        permissionMode="guard"
        finalConfirm={null}
        onPickMode={() => {}}
        onToggleConfirm={() => {}}
        onPickModel={pick}
        onPickEffort={() => {}}
        onClose={() => {}}
      />
    </>,
  );
}

describe('disconnected providers in the model picker', () => {
  it('badges the provider row instead of hiding it', () => {
    renderSheet(() => {});
    fireEvent.click(screen.getByText('More models'));
    expect(screen.getByText('1 model · Not connected')).toBeTruthy();
    expect(screen.getByText('Google')).toBeTruthy();
  });

  it('refuses the pick and says where to connect', () => {
    const pick = vi.fn();
    renderSheet(pick);
    fireEvent.click(screen.getByText('More models'));
    fireEvent.click(screen.getByText('Google'));
    expect(
      screen.getByText(/connect Google on your Mac to use/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByText('Gemini 3 Pro'));
    expect(pick).not.toHaveBeenCalled();
    expect(
      screen.getByText('Connect Google on your Mac to use this model'),
    ).toBeTruthy();
  });

  it('still picks a connected model', () => {
    const pick = vi.fn();
    renderSheet(pick);
    fireEvent.click(screen.getByText('More models'));
    fireEvent.click(screen.getByText('Anthropic'));
    fireEvent.click(screen.getByText('Opus 4.6'));
    expect(pick).toHaveBeenCalledWith('anthropic', 'opus-4-6');
  });
});
