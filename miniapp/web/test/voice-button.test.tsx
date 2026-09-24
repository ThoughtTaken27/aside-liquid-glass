/**
 * Dictation button.
 *
 * The recorder and the network are faked; what is under test is the state
 * machine, and above all that no sequence of taps can leave the button in a
 * state where the next tap is ignored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

const rec = vi.hoisted(() => ({
  opens: 0,
  cancels: 0,
  stops: 0,
  pending: [] as Array<{ resolve: (h: unknown) => void; reject: (e: unknown) => void }>,
  ended: [] as Array<() => void>,
  blobSize: 4000,
  ms: 2000,
}));
const net = vi.hoisted(() => ({
  calls: 0,
  signals: [] as AbortSignal[],
  result: 'hello world' as string | Error,
  hang: false,
}));

vi.mock('../src/voice', async (orig) => {
  const real = await orig<typeof import('../src/voice')>();
  return {
    ...real,
    isVoiceSupported: () => true,
    startRecording: () => {
      rec.opens += 1;
      return new Promise((resolve, reject) => rec.pending.push({ resolve, reject }));
    },
  };
});

vi.mock('../src/api', async (orig) => {
  const real = await orig<typeof import('../src/api')>();
  return {
    ...real,
    api: {
      ...real.api,
      warmTranscriber: () => {},
      transcribe: (_blob: Blob, signal?: AbortSignal) => {
        net.calls += 1;
        if (signal) net.signals.push(signal);
        if (net.hang) {
          return new Promise((_, reject) =>
            signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
          );
        }
        return net.result instanceof Error ? Promise.reject(net.result) : Promise.resolve(net.result);
      },
    },
  };
});

import { VoiceButton } from '../src/components/VoiceButton';

function fakeHandle() {
  return {
    level: () => 0.5,
    onEnded: (fn: () => void) => rec.ended.push(fn),
    cancel: () => {
      rec.cancels += 1;
    },
    stop: () => {
      rec.stops += 1;
      return Promise.resolve({ blob: new Blob([new Uint8Array(rec.blobSize)]), ms: rec.ms });
    },
  };
}

/** Resolve the oldest pending mic open. */
async function micOpens() {
  await act(async () => {
    rec.pending.shift()!.resolve(fakeHandle());
  });
}

/**
 * The composer re-renders the button on every activity report, with fresh
 * inline callbacks, exactly as the real composer does.
 */
function Host() {
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [, setLevel] = useState<unknown>(null);
  return (
    <div>
      <output data-testid="text">{text}</output>
      <output data-testid="note">{note ?? ''}</output>
      <VoiceButton
        onError={(m) => setNote(m)}
        onVoiceActivity={(level) => setLevel(() => level)}
        onTranscript={(t) => setText((prev) => (prev ? `${prev} ${t}` : t))}
      />
    </div>
  );
}

const mic = () => document.querySelector('[data-composer-control="voice"]') as HTMLButtonElement;
const state = () => mic().getAttribute('data-composer-control-state');

async function tap() {
  await act(async () => {
    fireEvent.pointerDown(mic(), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(mic(), { button: 0, pointerId: 1 });
  });
}

beforeEach(() => {
  rec.opens = rec.cancels = rec.stops = 0;
  rec.pending = [];
  rec.ended = [];
  rec.blobSize = 4000;
  rec.ms = 2000;
  net.calls = 0;
  net.signals = [];
  net.result = 'hello world';
  net.hang = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('VoiceButton', () => {
  it('tap to start, tap to finish, text lands in the composer', async () => {
    render(<Host />);
    await tap();
    expect(state()).toBe('starting');
    await micOpens();
    // The composer re-rendered on the activity report; the take survives it.
    expect(state()).toBe('recording');
    expect(rec.cancels).toBe(0);
    await tap();
    await vi.waitFor(() => expect(screen.getByTestId('text').textContent).toBe('hello world'));
    expect(state()).toBe('idle');
    expect(rec.stops).toBe(1);
  });

  it('a tap released before the mic opened keeps listening instead of sticking', async () => {
    render(<Host />);
    await tap(); // released while the permission prompt / mic open is pending
    await micOpens();
    expect(state()).toBe('recording');
    await tap();
    await vi.waitFor(() => expect(state()).toBe('idle'));
    expect(net.calls).toBe(1);
  });

  it('press and hold, release finishes (walkie-talkie)', async () => {
    const now = vi.spyOn(performance, 'now');
    let t = 1000;
    now.mockImplementation(() => t);
    render(<Host />);
    await act(async () => {
      fireEvent.pointerDown(mic(), { button: 0, pointerId: 1 });
    });
    t += 50;
    await micOpens();
    t += 1500;
    await act(async () => {
      fireEvent.pointerUp(mic(), { button: 0, pointerId: 1 });
    });
    await vi.waitFor(() => expect(screen.getByTestId('text').textContent).toBe('hello world'));
    now.mockRestore();
  });

  it('cancel discards the take and releases the mic', async () => {
    render(<Host />);
    await tap();
    await micOpens();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel voice input' }));
    });
    expect(state()).toBe('idle');
    expect(rec.cancels).toBe(1);
    expect(net.calls).toBe(0);
    // And the next tap works.
    await tap();
    expect(state()).toBe('starting');
  });

  it('cancel while the mic is still opening closes it once it opens', async () => {
    render(<Host />);
    await tap();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel voice input' }));
    });
    expect(state()).toBe('idle');
    await micOpens();
    expect(state()).toBe('idle');
    expect(rec.cancels).toBe(1);
  });

  it('tapping during transcription cancels it, and the button is usable again', async () => {
    net.hang = true;
    render(<Host />);
    await tap();
    await micOpens();
    await tap();
    await vi.waitFor(() => expect(state()).toBe('transcribing'));
    expect(mic().hasAttribute('disabled')).toBe(false);
    await tap();
    expect(state()).toBe('idle');
    expect(net.signals[0].aborted).toBe(true);
    expect(screen.getByTestId('note').textContent).toBe('');
    await tap();
    expect(state()).toBe('starting');
  });

  it('a transcription that never answers times out instead of hanging', async () => {
    net.hang = true;
    render(<Host />);
    await tap();
    await micOpens();
    vi.useFakeTimers();
    await tap();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    vi.useRealTimers();
    expect(state()).toBe('idle');
    expect(screen.getByTestId('note').textContent).toMatch(/timed out/i);
  });

  it('a denied permission explains itself and leaves the button usable', async () => {
    const { VoiceError } = await import('../src/voice');
    render(<Host />);
    await tap();
    await act(async () => {
      rec.pending.shift()!.reject(new VoiceError('permission_denied'));
    });
    expect(state()).toBe('idle');
    expect(screen.getByTestId('note').textContent).toMatch(/microphone access/i);
    await tap();
    expect(state()).toBe('starting');
  });

  it('a mic that dies mid-take still transcribes what was said', async () => {
    render(<Host />);
    await tap();
    await micOpens();
    await act(async () => {
      rec.ended.forEach((fn) => fn());
    });
    await vi.waitFor(() => expect(screen.getByTestId('text').textContent).toBe('hello world'));
  });

  it('a slip too short to be speech is dropped with a hint', async () => {
    rec.ms = 100;
    render(<Host />);
    await tap();
    await micOpens();
    await tap();
    await vi.waitFor(() => expect(state()).toBe('idle'));
    expect(net.calls).toBe(0);
    expect(screen.getByTestId('note').textContent).toMatch(/didn't catch/i);
  });

  it('Escape cancels', async () => {
    render(<Host />);
    await tap();
    await micOpens();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(state()).toBe('idle');
  });

  it('unmounting mid-take releases the mic', async () => {
    const view = render(<Host />);
    await tap();
    await micOpens();
    view.unmount();
    expect(rec.cancels).toBe(1);
  });

  it('keyboard Enter toggles', async () => {
    render(<Host />);
    await act(async () => {
      fireEvent.keyDown(mic(), { key: 'Enter' });
    });
    await micOpens();
    await act(async () => {
      fireEvent.keyDown(mic(), { key: 'Enter' });
    });
    await vi.waitFor(() => expect(screen.getByTestId('text').textContent).toBe('hello world'));
  });
});
