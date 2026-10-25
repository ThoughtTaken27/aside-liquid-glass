/**
 * Interface sounds, synthesised, off by default.
 *
 * TypeUI's sound catalogue (120 cues) and loadmo's sound-design tag agree:
 * the apps that feel expensive all tick. But a phone is not a website --
 * unexpected audio out of a chat app reads as a bug, not as polish -- so
 * these are opt-in behind a setting, default off, and every cue is
 * synthesised with WebAudio rather than shipped as an asset. No audio
 * files, no decode, no network; a few oscillators with short envelopes.
 *
 * The context is created lazily inside a user gesture (a send tap, a
 * toggle flip), which is the only moment the browser lets one start
 * anyway. Everything fails soft: no AudioContext, exceptions mid-play,
 * or a locked context all degrade to silence, never to an error.
 */

import { readLocal, writeLocal } from './storage';

const SOUNDS_KEY = 'miniapp.sounds';

export type SoundName = 'send' | 'receive' | 'toggle' | 'success' | 'error';

/** Off unless explicitly enabled. A chat app must never surprise with audio. */
export function soundsEnabled(): boolean {
  return readLocal(SOUNDS_KEY) === '1';
}

export function setSoundsEnabled(next: boolean): void {
  writeLocal(SOUNDS_KEY, next ? '1' : '0');
}

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  try {
    const Ctor =
      globalThis.AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) ctx = new Ctor();
    // A context created outside a gesture starts suspended; resume is a
    // no-op when it is already running.
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx.state === 'running' ? ctx : null;
  } catch {
    return null;
  }
}

/**
 * One enveloped tone.
 *
 * `from`/`to` in Hz over `dur` seconds, peaking at `gain` (kept low --
 * these sit under haptics, not over them). Exponential ramps need
 * non-zero endpoints, hence the 0.0001 floor.
 */
function tone(
  ac: AudioContext,
  from: number,
  to: number,
  dur: number,
  delay = 0,
  gain = 0.08,
  type: OscillatorType = 'sine',
): void {
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(amp).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Play a cue. Silent unless the setting is on; never throws. */
export function playSound(name: SoundName): void {
  try {
    if (!soundsEnabled()) return;
    // No sound before first paint/interaction: creating the context early
    // just leaves a suspended node to resume later.
    const ac = context();
    if (!ac) return;
    switch (name) {
      case 'send':
        // A short upward blip: the message leaving.
        tone(ac, 660, 880, 0.09);
        break;
      case 'receive':
        // Two soft notes a fourth apart: something arriving.
        tone(ac, 523, 523, 0.09);
        tone(ac, 784, 784, 0.12, 0.09);
        break;
      case 'toggle':
        // A faint mechanical tick for switches and picks.
        tone(ac, 1400, 900, 0.035, 0, 0.05, 'triangle');
        break;
      case 'success':
        tone(ac, 587, 880, 0.12);
        tone(ac, 880, 1174, 0.14, 0.1);
        break;
      case 'error':
        // Low and short: a thud, not an alarm.
        tone(ac, 196, 147, 0.16, 0, 0.09, 'triangle');
        break;
    }
  } catch {
    /* silence is always acceptable */
  }
}
