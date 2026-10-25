import { describe, expect, it } from 'vitest';
import {
  GRAVITY,
  TRACK_INSET,
  homeX,
  jumpVelocity,
  newCritter,
  pickSparkX,
  poke,
  sparkHit,
  step,
  SPARK_HEIGHT,
  CRITTER_H,
  type Critter,
} from './critterModel';

const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length];
};
const run = (c: Critter, ms: number, width: number, running: boolean, r = seq(0.9)) => {
  const events = [];
  for (let t = 0; t < ms; t += 16) events.push(step(c, 16, width, running, null, r));
  return events;
};

describe('critter model', () => {
  it('jumpVelocity peaks at the requested height', () => {
    const v = jumpVelocity(30);
    expect((v * v) / (2 * GRAVITY)).toBeCloseTo(30, 5);
  });

  it('starts home on the left, facing right, on the rim', () => {
    const c = newCritter();
    expect(c.x).toBe(homeX());
    expect(c.y).toBe(0);
    expect(c.facing).toBe(1);
    expect(c.mode).toBe('home');
  });

  it('stays home while idle', () => {
    const c = newCritter();
    run(c, 5000, 360, false);
    expect(c.x).toBe(homeX());
    expect(c.mode).toBe('home');
  });

  it('leaves home with a hop when the agent starts, then patrols right', () => {
    const c = newCritter();
    const ev = step(c, 16, 360, true, null, seq(0.9));
    expect(ev.jumped).toBe('hop');
    run(c, 2000, 360, true);
    expect(c.x).toBeGreaterThan(homeX() + 40);
  });

  it('never leaves the track', () => {
    const c = newCritter();
    run(c, 20000, 200, true, seq(0.1, 0.5, 0.9, 0.3, 0.65));
    expect(c.x).toBeGreaterThanOrEqual(TRACK_INSET);
    expect(c.x).toBeLessThanOrEqual(200 - TRACK_INSET);
  });

  it('cheers, walks home and settles with a bob when the turn ends', () => {
    const c = newCritter();
    run(c, 3000, 360, true);
    const events = run(c, 6000, 360, false);
    expect(events.some((e) => e.jumped === 'cheer')).toBe(true);
    expect(events.some((e) => e.arrivedHome)).toBe(true);
    expect(c.mode).toBe('home');
    expect(c.x).toBe(homeX());
    expect(c.facing).toBe(1);
  });

  it('lands with a squash after a hop', () => {
    const c = newCritter();
    poke(c);
    const events = run(c, 1200, 360, false);
    expect(events.some((e) => e.landed)).toBe(true);
    expect(c.y).toBe(0);
  });

  it('a second tap mid-air flips once, a third does nothing', () => {
    const c = newCritter();
    expect(poke(c)).toBe('jump');
    step(c, 16, 360, false, null, seq(0.9));
    expect(poke(c)).toBe('flip');
    expect(poke(c)).toBeNull();
  });

  it('reaches a spark placed ahead of it', () => {
    const c = newCritter();
    run(c, 400, 360, true);
    const spark = { x: c.x + 90, age: 0 };
    let got = false;
    for (let t = 0; t < 6000 && !got; t += 16) {
      got = Boolean(step(c, 16, 360, true, spark, seq(0.9)).collected);
    }
    expect(got).toBe(true);
  });

  it('spark hit box matches a jump to the spark height', () => {
    const c = newCritter();
    c.x = 100;
    c.y = SPARK_HEIGHT - CRITTER_H * 0.55;
    expect(sparkHit(c, { x: 104, age: 0 })).toBe(true);
    c.y = 0;
    expect(sparkHit(c, { x: 104, age: 0 })).toBe(false);
  });

  it('spawns sparks away from the critter', () => {
    const x = pickSparkX(360, 100, seq(0.1, 0.9));
    expect(x).not.toBeNull();
    expect(Math.abs((x as number) - 100)).toBeGreaterThan(70);
  });
});
