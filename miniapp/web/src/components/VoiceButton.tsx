/**
 * Push-to-talk for the composer.
 *
 * Hold the button, speak, let go. The clip goes to the Mac, a local Whisper
 * decodes it, and the text is appended to whatever is already in the box
 * rather than replacing it, so dictation composes with typing instead of
 * fighting it.
 *
 * Hold rather than tap-to-toggle: the failure mode of a toggle is a recorder
 * you forgot to stop, which on a phone in a pocket is a long silent clip and
 * a confusing wait. Holding makes the end of the recording physical. A tap
 * shorter than MIN_RECORDING_MS is treated as a mis-tap and discarded
 * silently rather than sent off to be transcribed as nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { haptic } from '../telegram';
import {
  MIN_RECORDING_MS,
  type RecorderHandle,
  VoiceError,
  isVoiceSupported,
  startRecording,
  voiceErrorMessage,
} from '../voice';

interface VoiceButtonProps {
  /** Append transcribed text to the composer. */
  onTranscript: (text: string) => void;
  disabled?: boolean;
  /** Surfaced by the composer as a one-line hint under the input. */
  onError?: (message: string) => void;
}

type Phase = 'idle' | 'recording' | 'transcribing';

const BAR_COUNT = 5;

export function VoiceButton({ onTranscript, disabled, onError }: VoiceButtonProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [levels, setLevels] = useState<number[]>(() => new Array(BAR_COUNT).fill(0.15));
  const handle = useRef<RecorderHandle | null>(null);
  const frame = useRef<number>(0);
  const supported = isVoiceSupported();

  // A recorder outliving its component would hold the mic open, which on
  // Android shows a permanent recording indicator in the status bar.
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      handle.current?.cancel();
      handle.current = null;
    },
    [],
  );

  const pump = useCallback(() => {
    const h = handle.current;
    if (!h) return;
    const value = h.level();
    setLevels((prev) => {
      const next = prev.slice(1);
      next.push(Math.max(0.12, value));
      return next;
    });
    frame.current = requestAnimationFrame(pump);
  }, []);

  const begin = useCallback(async () => {
    if (phase !== 'idle' || disabled || !supported) return;
    // Before the mic even opens: the model load and the recording then run
    // concurrently instead of one after the other.
    api.warmTranscriber();
    try {
      handle.current = await startRecording();
      setPhase('recording');
      haptic('medium');
      frame.current = requestAnimationFrame(pump);
    } catch (err) {
      handle.current = null;
      const code = err instanceof VoiceError ? err.code : 'failed';
      onError?.(voiceErrorMessage(code));
      haptic('error');
    }
  }, [disabled, onError, phase, pump, supported]);

  const finish = useCallback(async () => {
    const h = handle.current;
    if (!h || phase !== 'recording') return;
    handle.current = null;
    cancelAnimationFrame(frame.current);
    setLevels(new Array(BAR_COUNT).fill(0.15));

    let recording;
    try {
      recording = await h.stop();
    } catch {
      setPhase('idle');
      onError?.('Recording failed.');
      return;
    }

    if (recording.ms < MIN_RECORDING_MS || recording.blob.size < 1024) {
      // A mis-tap, not a message. Say nothing.
      setPhase('idle');
      return;
    }

    setPhase('transcribing');
    haptic('light');
    try {
      const text = await api.transcribe(recording.blob);
      if (text) {
        onTranscript(text);
        haptic('success');
      } else {
        // Decoded cleanly and found no words. Silence, or a pocket.
        onError?.('Nothing heard.');
      }
    } catch (err) {
      const reason = (err as { reason?: string }).reason;
      onError?.(
        reason === 'model_missing'
          ? 'Speech model missing on the Mac.'
          : reason === 'timeout'
            ? 'Transcription timed out.'
            : reason === 'whisper_missing' || reason === 'ffmpeg_missing'
              ? 'Transcription tools missing on the Mac.'
              : "Couldn't transcribe that.",
      );
      haptic('error');
    } finally {
      setPhase('idle');
    }
  }, [onError, onTranscript, phase]);

  if (!supported) return null;

  const recording = phase === 'recording';
  const busy = phase === 'transcribing';

  return (
    <button
      type="button"
      className={`round-button ghost voice-button composer-primary-control${
        recording ? ' is-recording' : ''
      }${busy ? ' is-busy' : ''}`}
      data-composer-control="voice"
      data-composer-group="primary"
      data-composer-primary="true"
      data-composer-control-state={phase}
      aria-label={recording ? 'Release to transcribe' : 'Hold to speak'}
      aria-pressed={recording}
      disabled={disabled || busy}
      // Pointer events cover touch, pen and mouse in one path, and
      // setPointerCapture keeps the release bound to this button even if the
      // finger drifts off it mid-sentence.
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        void begin();
      }}
      onPointerUp={(event) => {
        event.preventDefault();
        void finish();
      }}
      onPointerCancel={() => {
        handle.current?.cancel();
        handle.current = null;
        cancelAnimationFrame(frame.current);
        setPhase('idle');
      }}
      // The browser's own long-press menu on a button you are holding down is
      // exactly the wrong gesture to trigger here.
      onContextMenu={(event) => event.preventDefault()}
    >
      {recording ? (
        <span className="voice-wave" aria-hidden="true">
          {levels.map((level, index) => (
            <span
              key={index}
              className="voice-bar"
              style={{ transform: `scaleY(${level.toFixed(3)})` }}
            />
          ))}
        </span>
      ) : busy ? (
        <span className="voice-dots" aria-hidden="true">
          <span /><span /><span />
        </span>
      ) : (
        <MicGlyph />
      )}
    </button>
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
