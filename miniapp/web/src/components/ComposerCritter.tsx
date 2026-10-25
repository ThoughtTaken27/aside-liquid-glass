/**
 * The critter that lives on the composer's top rim.
 *
 * Idle: sits home at the left, blinks, knee-bobs, glances around.
 * Agent running: patrols the rim, hops, pauses to look about, and jumps
 * for the occasional clay spark. Turn over: a cheer hop, a walk home, a
 * double knee-bob. Tap it to make it jump (tap again mid-air to flip);
 * long-press toggles its sounds.
 *
 * One rAF loop writes transforms straight to the DOM; React renders once.
 * Shown only in the Clay fits (CSS hides it elsewhere). Reduced motion:
 * it sits at home and only blinks.
 */
import { useEffect, useRef } from 'react';
import { EmberSprite } from './EmberSprite';
import { haptic } from '../telegram';
import {
  CRITTER_H,
  CRITTER_W,
  SPARK_HEIGHT,
  SPARK_LIFE_MS,
  between,
  newCritter,
  pickSparkX,
  poke,
  poseScale,
  step,
  type Spark,
} from './critterModel';

const SOUND_KEY = 'aside.critter.sound';

// --- tiny chiptune blips ----------------------------------------------------

let audio: AudioContext | null = null;
function blip(notes: Array<[freq: number, ms: number]>, gain = 0.035): void {
  try {
    if (localStorage.getItem(SOUND_KEY) === 'off') return;
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    let t = audio.currentTime + 0.005;
    for (const [freq, ms] of notes) {
      const osc = audio.createOscillator();
      const amp = audio.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, t);
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(gain, t + 0.006);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      osc.connect(amp).connect(audio.destination);
      osc.start(t);
      osc.stop(t + ms / 1000 + 0.02);
      t += (ms * 0.8) / 1000;
    }
  } catch {
    // Audio is a garnish; never let it break the composer.
  }
}
const SFX = {
  jump: () => blip([[523, 60], [784, 80]]),
  flip: () => blip([[659, 50], [880, 50], [1175, 90]]),
  spark: () => blip([[988, 70], [1319, 140]], 0.03),
  toggle: (on: boolean) => blip(on ? [[660, 60], [990, 90]] : [[660, 60], [440, 90]], 0.03),
};

// --- component ----------------------------------------------------------------

export function ComposerCritter({ running }: { running: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const poseRef = useRef<HTMLDivElement>(null);
  const sparkRef = useRef<HTMLDivElement>(null);
  const fxRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(running);
  runningRef.current = running;
  const userRef = useRef<{ poke: () => void; toggleSound: () => void } | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const body = bodyRef.current;
    const pose = poseRef.current;
    const sparkEl = sparkRef.current;
    const fx = fxRef.current;
    if (!root || !body || !pose || !sparkEl || !fx) return;

    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const c = newCritter();
    let width = root.clientWidth;
    let spark: Spark | null = null;
    let sparkIn = between(Math.random, 3500, 8000);
    let blinkIn = between(Math.random, 1800, 4200);
    let blinkLeft = 0;
    let doubleBlink = false;
    let happyLeft = 0;
    let spin = 0;
    let last = performance.now();
    let raf = 0;
    let wasRunning = runningRef.current;

    // Pin the layer to the composer card it follows in the DOM: same
    // offset parent, so its offsets are ours.
    const anchor = root.previousElementSibling as HTMLElement | null;
    const place = () => {
      if (anchor) {
        root.style.left = `${anchor.offsetLeft}px`;
        root.style.top = `${anchor.offsetTop}px`;
        root.style.width = `${anchor.offsetWidth}px`;
      }
      width = root.clientWidth;
    };
    const ro = new ResizeObserver(place);
    ro.observe(root);
    if (anchor) ro.observe(anchor);
    window.addEventListener('resize', place);
    place();

    const set = (name: string, value: string) => {
      if (root.dataset[name] !== value) root.dataset[name] = value;
    };

    const puff = (x: number, kind: 'dust' | 'pop' | 'note', text?: string, dir = 0) => {
      const el = document.createElement('span');
      el.className = `cc-fx is-${kind}`;
      if (text) el.textContent = text;
      el.style.setProperty('--x', `${x}px`);
      el.style.setProperty('--dir', String(dir));
      fx.appendChild(el);
      window.setTimeout(() => el.remove(), 700);
    };
    const dust = (x: number) => {
      puff(x - 10, 'dust', undefined, -1);
      puff(x + 10, 'dust', undefined, 1);
    };

    userRef.current = {
      poke: () => {
        const kind = poke(c);
        if (!kind) return;
        happyLeft = 1400;
        if (kind === 'flip') {
          spin = 1;
          SFX.flip();
        } else {
          SFX.jump();
        }
        haptic('light');
      },
      toggleSound: () => {
        const on = localStorage.getItem(SOUND_KEY) === 'off';
        localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
        SFX.toggle(on);
        puff(c.x, 'note', on ? '♪' : '×');
        haptic('select');
      },
    };

    let lastBody = '';
    let lastPose = '';
    // While the reader scrolls, the critter holds its pose: the scroll gets
    // the whole frame budget, and it picks up where it was afterwards.
    let scrollingUntil = 0;
    const onAnyScroll = () => {
      scrollingUntil = performance.now() + 180;
    };
    document.addEventListener('scroll', onAnyScroll, { capture: true, passive: true });
    const frame = (now: number) => {
      if (now < scrollingUntil) {
        last = now;
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = Math.min(50, now - last);
      last = now;
      // Dev preview: <html data-critter-demo="run"> fakes a running turn.
      const running =
        runningRef.current ||
        (import.meta.env.DEV && document.documentElement.dataset.critterDemo === 'run');
      const still = calm?.matches ?? false;

      // Sparks only while the agent works, one at a time.
      if (running && !still) {
        if (spark) {
          spark.age += dt;
          if (spark.age > SPARK_LIFE_MS) {
            spark = null;
            sparkIn = between(Math.random, 5000, 12000);
          }
        } else if ((sparkIn -= dt) <= 0) {
          const x = pickSparkX(width, c.x, Math.random);
          if (x !== null) spark = { x, age: 0 };
          sparkIn = between(Math.random, 7000, 15000);
        }
      } else if (spark) {
        spark = null;
      }

      if (!still) {
        const ev = step(c, dt, width, running, spark, Math.random);
        if (ev.landed) dust(c.x);
        if (ev.jumped === 'cheer') happyLeft = 1600;
        if (ev.collected && spark) {
          puff(spark.x, 'pop');
          spark = null;
          happyLeft = 1100;
          SFX.spark();
          haptic('select');
        }
      } else {
        // Reduced motion: sit at home; still mark the turn ending.
        c.x = 36;
        c.y = 0;
      }
      if (wasRunning && !running) happyLeft = Math.max(happyLeft, 1600);
      wasRunning = running;

      // Blinks: short, occasionally doubled.
      if (blinkLeft > 0) {
        blinkLeft -= dt;
        if (blinkLeft <= 0 && doubleBlink) {
          doubleBlink = false;
          blinkIn = 90;
        }
      } else if ((blinkIn -= dt) <= 0) {
        blinkLeft = 110;
        doubleBlink = Math.random() < 0.22;
        blinkIn = between(Math.random, 2200, 5600);
      }
      happyLeft = Math.max(0, happyLeft - dt);
      if (spin > 0) spin = Math.max(0, spin - dt / 420);

      // Paint, only what changed: an idle critter writes nothing.
      const s = poseScale(c);
      const px = Math.round(c.x - CRITTER_W / 2);
      const py = Math.round(c.y);
      const bodyT = `translate3d(${px}px, ${-py}px, 0)`;
      if (bodyT !== lastBody) body.style.transform = lastBody = bodyT;
      const rot = spin > 0 ? -c.facing * (1 - spin) * 360 : 0;
      const poseT = `scale(${(c.facing * s.sx).toFixed(3)}, ${s.sy.toFixed(3)}) rotate(${rot.toFixed(1)}deg)`;
      if (poseT !== lastPose) pose.style.transform = lastPose = poseT;
      set('legs', c.legs ? 'b' : 'a');
      set('eyes', blinkLeft > 0 || (happyLeft > 0 && c.y > 4) ? 'shut' : 'open');
      set('mood', happyLeft > 0 ? 'happy' : 'calm');
      set('air', c.y > 0.5 ? 'up' : 'down');
      set('mode', c.mode);
      if (spark) {
        sparkEl.style.transform = `translate3d(${Math.round(spark.x - 7)}px, ${-SPARK_HEIGHT - 7}px, 0)`;
        set('spark', spark.age > SPARK_LIFE_MS - 1200 ? 'fading' : 'on');
      } else {
        set('spark', 'off');
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      document.removeEventListener('scroll', onAnyScroll, { capture: true });
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', place);
      userRef.current = null;
    };
  }, []);

  // Tap = jump / flip. Long-press = sound toggle.
  const press = useRef<number | null>(null);
  const longFired = useRef(false);
  const down = () => {
    longFired.current = false;
    press.current = window.setTimeout(() => {
      longFired.current = true;
      userRef.current?.toggleSound();
    }, 550);
  };
  const up = () => {
    if (press.current !== null) window.clearTimeout(press.current);
    press.current = null;
    if (!longFired.current) userRef.current?.poke();
  };
  const cancel = () => {
    if (press.current !== null) window.clearTimeout(press.current);
    press.current = null;
  };

  return (
    <div ref={rootRef} className="composer-critter" aria-hidden="true" data-mode="home">
      <div ref={fxRef} className="cc-fx-layer" />
      <div ref={sparkRef} className="cc-spark">
        <svg viewBox="0 0 7 7" width={14} height={14} shapeRendering="crispEdges">
          {/* frame A: the Claude-style eight-ray spark */}
          <g className="cc-spark-a">
            <rect x={3} y={0} width={1} height={7} />
            <rect x={0} y={3} width={7} height={1} />
            <rect x={1} y={1} width={1} height={1} />
            <rect x={5} y={1} width={1} height={1} />
            <rect x={1} y={5} width={1} height={1} />
            <rect x={5} y={5} width={1} height={1} />
            <rect x={2} y={2} width={3} height={3} />
          </g>
          {/* frame B: a tighter twinkle */}
          <g className="cc-spark-b">
            <rect x={3} y={1} width={1} height={5} />
            <rect x={1} y={3} width={5} height={1} />
            <rect x={2} y={2} width={3} height={3} />
          </g>
        </svg>
      </div>
      <div
        ref={bodyRef}
        className="cc-body"
        style={{ width: CRITTER_W, height: CRITTER_H }}
        onPointerDown={down}
        onPointerUp={up}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="cc-shadow" />
        <div ref={poseRef} className="cc-pose">
          <EmberSprite className="composer-critter-sprite" prefix="cc" width={CRITTER_W} />
        </div>
      </div>
    </div>
  );
}
