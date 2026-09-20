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
  /** Resolves once the final chunk has been flushed. */
  stop(): Promise<Recording>;
  /** Abandon the take and release the mic without producing a blob. */
  cancel(): void;
  /** Current input level, 0..1, for the waveform. */
  level(): number;
}

/**
 * Start recording.
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
    if (!window.isSecureContext) throw new VoiceError('insecure_context');
    throw new VoiceError('unsupported');
  }

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
    const name = (err as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new VoiceError('permission_denied');
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      throw new VoiceError('no_microphone');
    }
    throw new VoiceError('failed', String((err as Error)?.message || err));
  }

  const mimeType = pickMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    throw new VoiceError('unsupported');
  }

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  // Level metering. Wrapped in try/catch because an AudioContext is a real
  // resource that can fail to allocate, and losing the waveform is not a
  // reason to lose the recording.
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let buffer: Uint8Array<ArrayBuffer> | null = null;
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    audioCtx = new Ctor();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    // Backed by an explicit ArrayBuffer: getByteFrequencyData's signature
    // rejects the SharedArrayBuffer-capable default under strict lib types.
    buffer = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
  } catch {
    analyser = null;
  }

  const startedAt = Date.now();
  // 250 ms timeslice: frequent enough that a crash loses very little, rare
  // enough that the chunk list stays short for a message-length recording.
  recorder.start(250);

  const teardown = () => {
    stream.getTracks().forEach((t) => t.stop());
    audioCtx?.close().catch(() => {});
  };

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

    cancel() {
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
        if (recorder.state === 'inactive') {
          teardown();
          reject(new VoiceError('failed', 'recorder already stopped'));
          return;
        }
        recorder.onstop = () => {
          teardown();
          resolve({
            blob: new Blob(chunks, { type: mimeType || 'audio/webm' }),
            ms: Date.now() - startedAt,
          });
        };
        recorder.onerror = () => {
          teardown();
          reject(new VoiceError('failed', 'recorder error'));
        };
        try {
          recorder.stop();
        } catch (err) {
          teardown();
          reject(new VoiceError('failed', String(err)));
        }
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

/** Below this, the user tapped rather than held. Not a recording. */
export const MIN_RECORDING_MS = 350;
