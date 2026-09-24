/**
 * Voice capture for the composer.
 *
 * Records with MediaRecorder, posts the clip to the Mac, and gets prose back
 * from a local Whisper. The interesting decisions here are about what happens
 * around the recording rather than the recording itself.
 *
 * Codec: negotiated rather than assumed. Chrome on Android produces webm/opus,
 * Safari produces mp4/aac, and a hardcoded mimeType makes `new MediaRecorder`
 * throw on whichever platform guessed wrong. The server hands the bytes to
 * ffmpeg, which sniffs the real container, so any of them are fine.
 *
 * Level metering: the composer draws a live waveform while recording, because
 * a mic button with no feedback gives you no way to tell "still listening"
 * from "died three seconds ago" until you have already lost the sentence.
 */

/** Ordered by preference; the first supported one wins. */
const CANDIDATE_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/aac',
];

export function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return CANDIDATE_TYPES.find((t) => {
    try {
      return MediaRecorder.isTypeSupported(t);
    } catch {
      return false;
    }
  });
}

export function isVoiceSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

export type VoiceFailure =
  | 'unsupported'
  | 'permission_denied'
  | 'no_microphone'
  | 'insecure_context'
  | 'failed';

export class VoiceError extends Error {
  constructor(readonly code: VoiceFailure, message?: string) {
    super(message || code);
    this.name = 'VoiceError';
  }
}

export interface Recording {
  blob: Blob;
  /** Wall-clock length in milliseconds. */
  ms: number;
}

export interface RecorderHandle {
  /**
   * Finish the take. Resolves once the final chunk has been flushed.
   *
   * Keeps listening for a short tail first: people tap "done" on the last
   * syllable, and a clip cut mid-word is exactly where Whisper drops or
   * mangles the final word.
   */
  stop(): Promise<Recording>;
  /** Abandon the take and release the mic without producing a blob. */
  cancel(): void;
  /** Current input level, 0..1, for the waveform and the glow. */
  level(): number;
  /** Called once if the mic dies on its own (another app took it, etc.). */
  onEnded(listener: () => void): void;
}

/** Recording continues this long after "stop" so the last word survives. */
export const STOP_TAIL_MS = 180;
/** If the recorder never reports that it stopped, stop waiting after this. */
const STOP_GRACE_MS = 2_500;

/**
 * An AudioContext created inside the tap itself.
 *
 * Mobile Chrome starts a context "suspended" unless it is made during a user
 * gesture, and a suspended context meters permanent silence. By the time
 * getUserMedia resolves (after a permission prompt, say) the gesture is
 * gone, so the context is made first, synchronously, and the stream is
 * attached to it later.
 */
function makeMeterContext(): AudioContext | null {
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    void ctx.resume?.().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Start recording.
 *
 * Call this synchronously from the tap handler (the first await inside it
 * is the permission prompt), so the meter context counts as user-initiated.
 *
 * Throws a typed `VoiceError` rather than the browser's raw DOMException so
 * the UI can say something useful. "Permission denied" and "no microphone
 * found" need different sentences, and on Android the second one usually
 * means another app is holding the mic.
 */
export async function startRecording(): Promise<RecorderHandle> {
  if (!isVoiceSupported()) {
    // getUserMedia is gated on a secure context. Over plain http on a LAN
    // address the API is simply absent, which is worth distinguishing from
    // an old browser because the fix is "use the https address".
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      throw new VoiceError('insecure_context');
    }
    throw new VoiceError('unsupported');
  }

  const audioCtx = makeMeterContext();
  const closeCtx = () => {
    audioCtx?.close().catch(() => {});
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Let the platform do the cleanup it is already good at. Whisper is
        // markedly more accurate on a clean signal, and phone DSP is better
        // at this than anything worth writing here.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (err) {
    closeCtx();
    const name = (err as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new VoiceError('permission_denied');
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      throw new VoiceError('no_microphone');
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      // Android: another app (a call, the recorder, an assistant) holds it.
      throw new VoiceError('no_microphone');
    }
    throw new VoiceError('failed', String((err as Error)?.message || err));
  }

  const mimeType = pickMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      // Speech, mono. Plenty for Whisper, and a small upload over a phone
      // connection is most of what "fast" means after you let go.
      audioBitsPerSecond: 48_000,
    });
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    closeCtx();
    throw new VoiceError('unsupported');
  }

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  // Level metering. Losing the waveform is never a reason to lose the take.
  let analyser: AnalyserNode | null = null;
  let buffer: Uint8Array<ArrayBuffer> | null = null;
  if (audioCtx) {
    try {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      // Backed by an explicit ArrayBuffer: getByteFrequencyData's signature
      // rejects the SharedArrayBuffer-capable default under strict lib types.
      buffer = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => {});
    } catch {
      analyser = null;
    }
  }

  const startedAt = Date.now();
  // 250 ms timeslice: frequent enough that a crash loses very little, rare
  // enough that the chunk list stays short for a message-length recording.
  recorder.start(250);

  let released = false;
  const teardown = () => {
    if (released) return;
    released = true;
    stream.getTracks().forEach((t) => t.stop());
    closeCtx();
  };

  const ended: Array<() => void> = [];
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (released) return;
      ended.splice(0).forEach((fn) => fn());
    });
  }

  return {
    level() {
      if (!analyser || !buffer) return 0;
      analyser.getByteFrequencyData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i += 1) sum += buffer[i];
      // Perceptual-ish curve: raw RMS barely moves for normal speech, so the
      // bars would sit at a constant nub without the exponent.
      return Math.min(1, (sum / buffer.length / 255) ** 0.6 * 1.8);
    },

    onEnded(listener) {
      ended.push(listener);
    },

    cancel() {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        /* already gone */
      }
      chunks.length = 0;
      teardown();
    },

    stop() {
      return new Promise<Recording>((resolve, reject) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(grace);
          teardown();
          resolve({
            blob: new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }),
            ms: Date.now() - startedAt,
          });
        };
        // Some Android builds never fire `stop` when the track died first.
        // Whatever was captured is still worth transcribing.
        const grace = window.setTimeout(done, STOP_TAIL_MS + STOP_GRACE_MS);
        if (recorder.state === 'inactive') {
          done();
          return;
        }
        recorder.onstop = done;
        recorder.onerror = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(grace);
          teardown();
          reject(new VoiceError('failed', 'recorder error'));
        };
        window.setTimeout(() => {
          try {
            if (recorder.state !== 'inactive') recorder.stop();
            else done();
          } catch {
            done();
          }
        }, STOP_TAIL_MS);
      });
    },
  };
}

/** Human-readable reason, for the one line the composer can show. */
export function voiceErrorMessage(code: VoiceFailure): string {
  switch (code) {
    case 'permission_denied':
      return 'Microphone access is off for this site.';
    case 'no_microphone':
      return 'No microphone available.';
    case 'insecure_context':
      return 'Voice needs the secure (https) address.';
    case 'unsupported':
      return 'This browser cannot record audio.';
    default:
      return 'Recording failed.';
  }
}

/** Shorter than this is a slip, not a message. */
export const MIN_RECORDING_MS = 400;

/** A take stops itself here: a forgotten recorder should not run all day. */
export const MAX_RECORDING_MS = 3 * 60_000;
