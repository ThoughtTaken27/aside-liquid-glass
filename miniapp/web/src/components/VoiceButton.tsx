/**
 * Dictation for the composer.
 *
 * Two ways to use one button, because people do both without thinking:
 *
 *  - Tap to start, tap again to finish.
 *  - Press and hold, speak, let go (walkie-talkie).
 *
 * The press that started the take decides which: released within HOLD_MS of
 * the mic actually opening, it was a tap and the take keeps running; held
 * past that, letting go finishes it. A separate cancel control, Escape, or a
 * tap during transcription throws the take away. Nothing here can leave the
 * button in a state where the next tap is ignored.
 *
 * State lives in refs, not in effect dependencies. The previous version tore
 * the recorder down from an unmount effect that depended on an inline
 * callback, so the composer's own re-render (triggered by reporting the
 * stream) "unmounted" it: the mic was released, the button stayed in
 * "recording", and every later tap was ignored.
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { api } from '../api';
import { haptic } from '../telegram';
import {
  MAX_RECORDING_MS,
  MIN_RECORDING_MS,
  type RecorderHandle,
  VoiceError,
  isVoiceSupported,
  startRecording,
  voiceErrorMessage,
} from '../voice';

/** A voice level source for the composer glow; sampled per frame. */
export type VoiceLevel = () => number;

interface VoiceButtonProps {
  /** Append transcribed text to the composer. */
  onTranscript: (text: string) => void;
  disabled?: boolean;
  /** Surfaced by the composer as a one-line hint under the input. */
  onError?: (message: string | null) => void;
  /**
   * Recording state for the voice glow: a level getter while listening,
   * `busy` while transcribing, both quiet when the take resolves.
   */
  onVoiceActivity?: (level: VoiceLevel | null, busy: boolean) => void;
}

export type VoicePhase = 'idle' | 'starting' | 'recording' | 'transcribing';

/** A press this long after the mic opened is a hold, not a tap. */
export const HOLD_MS = 450;
/** Give up on the Mac after this, plus a little per second of audio. */
const TRANSCRIBE_TIMEOUT_MS = 25_000;
const BAR_COUNT = 5;
/** ~30 fps is plenty for five bars and half the work of 60. */
const METER_INTERVAL_MS = 33;

export function VoiceButton({ onTranscript, disabled, onError, onVoiceActivity }: VoiceButtonProps) {
  const [phase, setPhaseState] = useState<VoicePhase>('idle');
  const phaseRef = useRef<VoicePhase>('idle');
  const handle = useRef<RecorderHandle | null>(null);
  /** Bumped on every start and cancel; stale async work checks it and bails. */
  const take = useRef(0);
  const openedAt = useRef(0);
  const press = useRef<{ at: number; kind: 'start' | 'stop' | 'cancel' } | null>(null);
  const stopQueued = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const maxTimer = useRef(0);
  const meterFrame = useRef(0);
  const bars = useRef<Array<HTMLSpanElement | null>>([]);
  const history = useRef<number[]>(new Array(BAR_COUNT).fill(0.15));

  // Latest callbacks, read at call time. Never effect dependencies.
  const cb = useRef({ onTranscript, onError, onVoiceActivity });
  cb.current = { onTranscript, onError, onVoiceActivity };

  const supported = isVoiceSupported();

  const setPhase = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const stopMeter = useCallback(() => {
    cancelAnimationFrame(meterFrame.current);
    meterFrame.current = 0;
    history.current = new Array(BAR_COUNT).fill(0.15);
  }, []);

  // Five bars driven straight on the DOM: no React render per frame.
  const startMeter = useCallback(() => {
    let last = 0;
    const tick = (now: number) => {
      meterFrame.current = requestAnimationFrame(tick);
      if (now - last < METER_INTERVAL_MS) return;
      last = now;
      const h = handle.current;
      if (!h) return;
      const next = history.current;
      next.shift();
      next.push(Math.max(0.12, h.level()));
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const el = bars.current[i];
        if (el) el.style.transform = `scaleY(${next[i].toFixed(3)})`;
      }
    };
    meterFrame.current = requestAnimationFrame(tick);
  }, []);

  const clearTimers = useCallback(() => {
    window.clearTimeout(maxTimer.current);
    maxTimer.current = 0;
  }, []);

  /** Drop everything about the current take. Safe to call in any state. */
  const reset = useCallback(() => {
    take.current += 1;
    stopQueued.current = false;
    clearTimers();
    stopMeter();
    handle.current?.cancel();
    handle.current = null;
    abort.current?.abort();
    abort.current = null;
    cb.current.onVoiceActivity?.(null, false);
    setPhase('idle');
  }, [clearTimers, setPhase, stopMeter]);

  const cancel = useCallback(() => {
    if (phaseRef.current === 'idle') return;
    reset();
    haptic('light');
  }, [reset]);

  const finish = useCallback(async () => {
    if (phaseRef.current === 'starting') {
      // The mic is still opening; finish as soon as it does.
      stopQueued.current = true;
      return;
    }
    const h = handle.current;
    if (phaseRef.current !== 'recording' || !h) return;
    const mine = take.current;
    handle.current = null;
    clearTimers();
    stopMeter();
    setPhase('transcribing');
    cb.current.onVoiceActivity?.(null, true);
    haptic('light');

    let recording;
    try {
      recording = await h.stop();
    } catch {
      if (take.current !== mine) return;
      reset();
      cb.current.onError?.('Recording failed. Tap the mic to try again.');
      return;
    }
    if (take.current !== mine) return;

    if (recording.ms < MIN_RECORDING_MS || recording.blob.size < 1024) {
      reset();
      cb.current.onError?.("Didn't catch that. Tap the mic and speak.");
      return;
    }

    const controller = new AbortController();
    abort.current = controller;
    let timedOut = false;
    const timer = window.setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      TRANSCRIBE_TIMEOUT_MS + recording.ms / 4,
    );
    try {
      const text = await api.transcribe(recording.blob, controller.signal);
      if (take.current !== mine) return;
      if (text) {
        cb.current.onError?.(null);
        cb.current.onTranscript(text);
        haptic('success');
      } else {
        cb.current.onError?.('Nothing heard. Try again a little closer to the mic.');
      }
    } catch (err) {
      if (take.current !== mine) return; // cancelled by the user: say nothing
      const reason = (err as { reason?: string }).reason;
      cb.current.onError?.(
        timedOut || reason === 'timeout'
          ? 'Transcription timed out. Is your Mac awake?'
          : reason === 'model_missing'
            ? 'Speech model missing on the Mac.'
            : reason === 'whisper_missing' || reason === 'ffmpeg_missing'
              ? 'Transcription tools missing on the Mac.'
              : "Couldn't transcribe that. Tap the mic to try again.",
      );
      haptic('error');
    } finally {
      window.clearTimeout(timer);
      if (take.current === mine) {
        abort.current = null;
        cb.current.onVoiceActivity?.(null, false);
        setPhase('idle');
      }
    }
  }, [clearTimers, reset, setPhase, stopMeter]);

  const begin = useCallback(() => {
    if (phaseRef.current !== 'idle') return;
    const mine = ++take.current;
    stopQueued.current = false;
    setPhase('starting');
    cb.current.onError?.(null);
    // The model loads on the Mac while the mic opens and you speak.
    api.warmTranscriber();
    // Called synchronously inside the tap: see startRecording.
    startRecording().then(
      (h) => {
        if (take.current !== mine) {
          h.cancel();
          return;
        }
        handle.current = h;
        openedAt.current = performance.now();
        setPhase('recording');
        haptic('medium');
        cb.current.onVoiceActivity?.(() => h.level(), false);
        startMeter();
        h.onEnded(() => {
          if (handle.current === h) void finish();
        });
        maxTimer.current = window.setTimeout(() => {
          if (handle.current === h) void finish();
        }, MAX_RECORDING_MS);
        if (stopQueued.current) void finish();
      },
      (err) => {
        if (take.current !== mine) return;
        reset();
        const code = err instanceof VoiceError ? err.code : 'failed';
        cb.current.onError?.(voiceErrorMessage(code));
        haptic('error');
      },
    );
  }, [finish, reset, setPhase, startMeter]);

  // Unmount only. Nothing may hold the mic open after the composer is gone.
  useEffect(() => () => reset(), [reset]);

  // Escape cancels; backgrounding the app finishes what you said so far.
  useEffect(() => {
    if (phase === 'idle') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      if (phaseRef.current === 'recording') void finish();
      else if (phaseRef.current === 'starting') reset();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [cancel, finish, phase, reset]);

  if (!supported) return null;

  const onDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    // Keeps focus (and the keyboard) where it is.
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* not capturable (synthetic event); release still reaches us */
    }
    const current = phaseRef.current;
    if (current === 'idle') {
      if (disabled) return;
      press.current = { at: performance.now(), kind: 'start' };
      begin();
    } else if (current === 'transcribing') {
      press.current = { at: performance.now(), kind: 'cancel' };
    } else {
      press.current = { at: performance.now(), kind: 'stop' };
    }
  };

  const onUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (p.kind === 'cancel') {
      cancel();
    } else if (p.kind === 'stop') {
      void finish();
    } else if (
      // Held past HOLD_MS with the mic open for most of it: walkie-talkie.
      phaseRef.current === 'recording' &&
      performance.now() - p.at >= HOLD_MS &&
      performance.now() - openedAt.current >= HOLD_MS / 2
    ) {
      void finish();
    }
    // Otherwise it was a tap: keep listening until the next tap.
  };

  // Keyboard and assistive tech: Enter/Space toggles.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    const current = phaseRef.current;
    if (current === 'idle') {
      if (!disabled) begin();
    } else if (current === 'transcribing') cancel();
    else void finish();
  };

  const listening = phase === 'recording' || phase === 'starting';
  const busy = phase === 'transcribing';
  const active = phase !== 'idle';

  return (
    <>
      {active ? (
        <button
          type="button"
          className="round-button ghost voice-cancel"
          data-composer-control="voice-cancel"
          aria-label={busy ? 'Cancel transcription' : 'Cancel voice input'}
          onClick={cancel}
          onPointerDown={(event) => event.preventDefault()}
        >
          <XGlyph />
        </button>
      ) : null}
      <button
        type="button"
        className={`round-button ghost voice-button composer-primary-control${
          listening ? ' is-recording' : ''
        }${phase === 'starting' ? ' is-starting' : ''}${busy ? ' is-busy' : ''}`}
        data-composer-control="voice"
        data-composer-group="primary"
        data-composer-primary="true"
        data-composer-control-state={phase}
        aria-label={
          listening ? 'Finish and transcribe' : busy ? 'Transcribing, tap to cancel' : 'Voice input'
        }
        aria-pressed={listening}
        disabled={disabled && !active}
        onPointerDown={onDown}
        onPointerUp={onUp}
        // A cancelled pointer (the browser took the gesture, a permission
        // prompt stole focus) is not a decision. The take keeps running and
        // the next tap or the cancel button ends it.
        onPointerCancel={() => {
          press.current = null;
        }}
        onKeyDown={onKeyDown}
        // The browser's long-press menu on a button you are holding down is
        // exactly the wrong gesture to trigger here.
        onContextMenu={(event) => event.preventDefault()}
      >
        {phase === 'recording' ? (
          <span className="voice-wave" aria-hidden="true">
            {Array.from({ length: BAR_COUNT }, (_, index) => (
              <span
                key={index}
                ref={(el) => {
                  bars.current[index] = el;
                }}
                className="voice-bar"
              />
            ))}
          </span>
        ) : busy ? (
          <span className="voice-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        ) : (
          <MicGlyph />
        )}
      </button>
    </>
  );
}

function MicGlyph({ size = 17 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

function XGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
