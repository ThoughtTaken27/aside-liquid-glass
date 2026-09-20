/**
 * On-device speech-to-text.
 *
 * Audio arrives as whatever the phone's MediaRecorder produced (webm/opus on
 * Android Chrome, mp4/aac on iOS Safari), gets normalised by ffmpeg to the
 * 16 kHz mono PCM whisper.cpp requires, and is decoded locally by whisper-cli.
 *
 * Nothing leaves the Mac. No API key, no per-minute billing, no third party
 * holding the recordings. On an M1 the large-v3-turbo q5 model decodes the
 * 11-second JFK sample in roughly 4 seconds wall clock, so a normal spoken
 * message comes back faster than it took to say.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_FFMPEG = '/opt/homebrew/bin/ffmpeg';
export const DEFAULT_WHISPER = '/opt/homebrew/bin/whisper-cli';

/** Decode ceiling. A wedged child must never pin the box indefinitely. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** ~25 MB of compressed opus is far more speech than a composer ever needs. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export interface TranscribeOptions {
  modelPath: string;
  ffmpegPath?: string;
  whisperPath?: string;
  timeoutMs?: number;
  /** whisper.cpp thread count. The M1's 4 performance cores are the sweet spot. */
  threads?: number;
  /** ISO-639-1, or 'auto' to let the model decide. */
  language?: string;
  /**
   * Port of a resident `whisper-server` holding the model in memory.
   *
   * When present the decode goes there and skips the process start, the
   * Metal init and the 488MB model read that `whisper-cli` repeats on every
   * single take -- measured at ~650ms of the ~1300ms round trip on this M1.
   * Absent, or unreachable, and the CLI path runs exactly as before.
   */
  serverPort?: number | null;
}

export type TranscribeFailure =
  | 'empty_audio'
  | 'audio_too_large'
  | 'model_missing'
  | 'ffmpeg_missing'
  | 'whisper_missing'
  | 'decode_failed'
  | 'timeout';

export class TranscribeError extends Error {
  constructor(readonly code: TranscribeFailure, message?: string) {
    super(message || code);
    this.name = 'TranscribeError';
  }
}

/**
 * whisper.cpp is chatty in ways that are useless inside a text box.
 *
 * Even under `-nt` some builds still emit bracketed timestamps, and on silence
 * every Whisper model reproduces boilerplate from its training set: subtitle
 * credits, "thanks for watching", bracketed sound tags. A composer that
 * silently fills itself with "[BLANK_AUDIO]" reads as a broken app, so those
 * are dropped rather than shown.
 */
export function cleanTranscript(raw: string): string {
  const NOISE =
    /^(blank_audio|inaudible|silence|music|applause|laughter|no speech|speaking in foreign language|thanks? for watching[.!]?|subs by .*|subtitles by .*|transcription by .*)$/i;

  return raw
    .split('\n')
    .map((line) =>
      // Leading "[00:00:00.000 --> 00:00:04.000]" style stamps.
      line.replace(/^\s*\[[\d:.,\s\->]+\]\s*/, '').trim(),
    )
    .filter(Boolean)
    .filter((line) => {
      const bare = line.replace(/[[\]()*]/g, '').trim();
      return bare.length > 0 && !NOISE.test(bare);
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function runChild(
  bin: string,
  args: string[],
  timeoutMs: number,
  missingCode: TranscribeFailure,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') {
          return reject(new TranscribeError(missingCode, `${bin} not found`));
        }
        if (e.killed) {
          return reject(new TranscribeError('timeout', `${bin} timed out`));
        }
        return reject(
          new TranscribeError(
            'decode_failed',
            `${path.basename(bin)}: ${String(stderr || err.message).slice(0, 400)}`,
          ),
        );
      },
    );
  });
}

/**
 * Transcribe one recording.
 *
 * Everything happens inside a per-call temp directory that is removed in a
 * `finally`, so a failed decode cannot leave audio lying around on disk.
 */
export async function transcribeAudio(
  audio: Buffer,
  opts: TranscribeOptions,
): Promise<{ text: string; ms: number }> {
  const started = Date.now();

  if (!audio || audio.length === 0) throw new TranscribeError('empty_audio');
  if (audio.length > MAX_AUDIO_BYTES) throw new TranscribeError('audio_too_large');
  if (!fs.existsSync(opts.modelPath)) {
    throw new TranscribeError('model_missing', `model not at ${opts.modelPath}`);
  }

  const ffmpeg = opts.ffmpegPath || DEFAULT_FFMPEG;
  const whisper = opts.whisperPath || DEFAULT_WHISPER;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /*
   * ffmpeg through pipes, not through the disk.
   *
   * The old path made a temp directory, wrote the upload into it, wrote a
   * WAV out of it, read that back, and removed the directory -- four
   * filesystem round trips for a file that exists for a few hundred
   * milliseconds. Piping is 71ms end to end here and leaves nothing behind
   * to clean up or to leak if the process dies mid-decode.
   *
   * Container-agnostic on purpose: ffmpeg sniffs the real format, so the
   * same path handles Android's webm/opus and iOS's mp4/aac without the
   * client having to tell us which one it picked.
   */
  const wav = await convertToWav(ffmpeg, audio, timeoutMs);

  if (wav.length < 2048) {
    // Under ~64 ms of PCM. The user tapped and released, there is no speech.
    return { text: '', ms: Date.now() - started };
  }

  // The resident server first; it is the same model and the same decoder,
  // minus the startup this would otherwise repeat on every sentence.
  if (opts.serverPort) {
    try {
      const text = await decodeOnServer(opts.serverPort, wav, timeoutMs);
      return { text: cleanTranscript(text), ms: Date.now() - started };
    } catch {
      // Fall through to the CLI. A slow answer beats no answer.
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-stt-'));
  const wavPath = path.join(dir, `audio-${crypto.randomBytes(4).toString('hex')}.wav`);
  try {
    fs.writeFileSync(wavPath, wav);
    const args = [
      '-m', opts.modelPath,
      '-f', wavPath,
      '-nt',                                    // no timestamps
      '-np',                                    // no progress chrome
      '-t', String(opts.threads ?? 4),          // M1 performance cores
      /*
       * Greedy, down from beam 3 / best-of 3.
       *
       * Beam search is worth its cost on long-form audio with ambiguous
       * phrasing. On a dictated sentence it produced identical text in
       * every measurement taken here and cost time on each one, which is
       * the wrong trade for a control someone is waiting on.
       */
      '--best-of', '1',
      '--beam-size', '1',
      // Suppress the "[BLANK_AUDIO]"-class tokens at the source as well as in
      // cleanTranscript, since belt-and-braces is cheaper than a bad paste.
      '--suppress-nst',
    ];
    if (opts.language && opts.language !== 'auto') {
      args.push('-l', opts.language);
    }

    const stdout = await runChild(whisper, args, timeoutMs, 'whisper_missing');
    return { text: cleanTranscript(stdout), ms: Date.now() - started };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Normalise any container to the 16 kHz mono PCM whisper.cpp requires. */
function convertToWav(
  ffmpeg: string,
  audio: Buffer,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-ar', '16000',      // whisper.cpp only accepts 16 kHz
        '-ac', '1',          // mono
        '-c:a', 'pcm_s16le',
        // Trim dead air at both ends. Silence is where Whisper hallucinates,
        // and it is also the most expensive thing to decode per word returned.
        '-af', 'silenceremove=start_periods=1:start_silence=0.15:start_threshold=-45dB:detection=peak,areverse,silenceremove=start_periods=1:start_silence=0.15:start_threshold=-45dB:detection=peak,areverse',
        '-f', 'wav',
        'pipe:1',
      ]);
    } catch {
      reject(new TranscribeError('ffmpeg_missing', `${ffmpeg} not found`));
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new TranscribeError('timeout', 'ffmpeg timed out'));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk) => out.push(chunk as Buffer));
    child.stderr.on('data', (chunk) => err.push(chunk as Buffer));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        new TranscribeError(
          code === 'ENOENT' ? 'ffmpeg_missing' : 'decode_failed',
          `ffmpeg: ${error.message}`,
        ),
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new TranscribeError(
            'decode_failed',
            `ffmpeg: ${Buffer.concat(err).toString().slice(0, 400)}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(out));
    });

    // EPIPE is normal here: ffmpeg can decide it has enough of the input
    // before we have finished handing it over.
    child.stdin.on('error', () => {});
    child.stdin.end(audio);
  });
}

/**
 * Decode against a resident whisper-server.
 *
 * Its `/inference` route takes the same multipart form OpenAI's does, so
 * this is a plain upload of the WAV we already have in memory.
 */
async function decodeOnServer(
  port: number,
  wav: Buffer,
  timeoutMs: number,
): Promise<string> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(wav)], { type: 'audio/wav' }),
    'audio.wav',
  );
  form.append('temperature', '0');
  form.append('response_format', 'json');

  const response = await fetch(`http://127.0.0.1:${port}/inference`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`whisper-server ${response.status}`);
  const body = (await response.json()) as { text?: string };
  if (typeof body.text !== 'string') throw new Error('whisper-server bad body');
  return body.text;
}
