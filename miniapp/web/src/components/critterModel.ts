/**
 * Behaviour model for the composer critter: pure numbers, no DOM.
 *
 * The critter lives on the composer's top rim. Idle, it sits home at the
 * left and knee-bobs. While a turn runs it patrols, hops, pauses to look
 * around and jumps for sparks. When the turn ends it cheers, walks home
 * and settles with a double bob. Everything here is deterministic given a
 * random source, so the feel can be unit tested.
 */

export const CRITTER_W = 30;
export const CRITTER_H = 22.5;
/** Gap kept between the critter and the composer's rounded corners. */
export const TRACK_INSET = 36;
export const GRAVITY = 1250; // px/s^2, snappy cartoon fall
export const PATROL_SPEED = 48; // px/s, an amble, not a sprint
export const RETURN_SPEED = 74; // px/s, hurrying home
export const STEP_MS = 125; // leg frame period while walking
export const SPARK_HEIGHT = 34; // spark centre above the rim
export const SPARK_LIFE_MS = 9000;

export type Mode = 'home' | 'patrol' | 'pause' | 'return' | 'cheer';

export type Critter = {
  x: number; // centre, px from the track's left edge
  y: number; // feet above the rim
  vy: number;
  facing: 1 | -1;
  mode: Mode;
  /** ms until the next behaviour decision in the current mode. */
  timer: number;
  /** ms accumulated toward the next leg frame. */
  stride: number;
  legs: 0 | 1;
  /** ms remaining on the landing squash. */
  squash: number;
  /** ms remaining on the idle knee-bob (two dips). */
  bob: number;
  flips: number;
};

export type Spark = { x: number; age: number };

export type Rand = () => number;

export const between = (r: Rand, lo: number, hi: number) => lo + r() * (hi - lo);

export function homeX(): number {
  return TRACK_INSET;
}

export function trackMax(width: number): number {
  return Math.max(TRACK_INSET, width - TRACK_INSET);
}

/** Launch speed that peaks exactly `height` px above the rim. */
export function jumpVelocity(height: number): number {
  return Math.sqrt(2 * GRAVITY * Math.max(0, height));
}

export function airborne(c: Critter): boolean {
  return c.y > 0.25 || c.vy > 0;
}

export function newCritter(): Critter {
  return {
    x: homeX(),
    y: 0,
    vy: 0,
    facing: 1,
    mode: 'home',
    timer: 2400,
    stride: 0,
    legs: 0,
    squash: 0,
    bob: 0,
    flips: 0,
  };
}

/** The body's hit box centre, for spark grabs. */
export function bodyCentreY(c: Critter): number {
  return c.y + CRITTER_H * 0.55;
}

export function sparkHit(c: Critter, s: Spark): boolean {
  return Math.abs(c.x - s.x) < 13 && Math.abs(bodyCentreY(c) - SPARK_HEIGHT) < 13;
}

/** Spawn a spark away from the critter so it has to go get it. */
export function pickSparkX(width: number, critterX: number, r: Rand): number | null {
  const lo = TRACK_INSET + 30;
  const hi = trackMax(width) - 30;
  if (hi <= lo) return null;
  for (let i = 0; i < 8; i++) {
    const x = between(r, lo, hi);
    if (Math.abs(x - critterX) > 70) return x;
  }
  return between(r, lo, hi);
}

export type Events = {
  jumped?: 'hop' | 'reach' | 'cheer';
  landed?: boolean;
  collected?: boolean;
  arrivedHome?: boolean;
};

/**
 * Advance one frame. `running` is whether the agent is mid-turn.
 * Mutates and returns `c`; reports one-shot events for sound/haptics/FX.
 */
export function step(
  c: Critter,
  dtMs: number,
  width: number,
  running: boolean,
  spark: Spark | null,
  r: Rand,
): Events {
  const ev: Events = {};
  const dt = Math.min(dtMs, 50) / 1000;
  const max = trackMax(width);
  c.timer -= dtMs;
  c.squash = Math.max(0, c.squash - dtMs);
  c.bob = Math.max(0, c.bob - dtMs);

  // Mode transitions driven by the turn starting or ending.
  if (running && (c.mode === 'home' || c.mode === 'return')) {
    c.mode = 'patrol';
    c.facing = 1;
    c.timer = between(r, 900, 2200);
    if (!airborne(c)) {
      c.vy = jumpVelocity(12); // a little "let's go" hop
      ev.jumped = 'hop';
    }
  } else if (!running && (c.mode === 'patrol' || c.mode === 'pause')) {
    c.mode = 'cheer';
    c.timer = 0;
  }

  const grounded = !airborne(c);
  let speed = 0;

  switch (c.mode) {
    case 'home': {
      if (grounded && c.timer <= 0) {
        const roll = r();
        if (roll < 0.62) c.bob = 520;
        else if (roll < 0.82) c.facing = c.facing === 1 ? -1 : 1;
        else c.facing = 1;
        c.timer = between(r, 2600, 5200);
      }
      break;
    }
    case 'patrol': {
      speed = PATROL_SPEED;
      // Chase a live spark: face it, and leap when it is just ahead.
      if (spark) {
        const dx = spark.x - c.x;
        if (grounded && Math.abs(dx) > 26) c.facing = dx > 0 ? 1 : -1;
        if (grounded && Math.abs(dx) <= 26 && Math.abs(dx) > 6 && Math.sign(dx) === c.facing) {
          c.vy = jumpVelocity(SPARK_HEIGHT - CRITTER_H * 0.3);
          ev.jumped = 'reach';
        }
        speed = PATROL_SPEED * 1.35;
      } else if (grounded && c.timer <= 0) {
        const roll = r();
        if (roll < 0.34) {
          c.vy = jumpVelocity(between(r, 9, 18));
          ev.jumped = 'hop';
          c.timer = between(r, 1400, 3200);
        } else if (roll < 0.56) {
          c.mode = 'pause';
          c.timer = between(r, 650, 1500);
        } else if (roll < 0.7) {
          c.facing = c.facing === 1 ? -1 : 1;
          c.timer = between(r, 1200, 2600);
        } else {
          c.timer = between(r, 900, 2400);
        }
      }
      break;
    }
    case 'pause': {
      // Look around once mid-pause, then carry on.
      if (grounded && c.timer <= 0) {
        if (r() < 0.45) c.facing = c.facing === 1 ? -1 : 1;
        c.mode = 'patrol';
        c.timer = between(r, 1000, 2600);
      } else if (c.timer > 400 && c.timer < 420 && r() < 0.5) {
        c.facing = c.facing === 1 ? -1 : 1;
      }
      break;
    }
    case 'cheer': {
      if (grounded && c.timer <= 0) {
        c.vy = jumpVelocity(20);
        ev.jumped = 'cheer';
        c.mode = 'return';
        c.facing = -1;
      }
      break;
    }
    case 'return': {
      if (grounded) {
        speed = RETURN_SPEED;
        c.facing = c.x > homeX() ? -1 : 1;
        if (Math.abs(c.x - homeX()) < 1.5) {
          c.x = homeX();
          c.mode = 'home';
          c.facing = 1;
          c.bob = 520;
          c.timer = between(r, 2600, 4200);
          ev.arrivedHome = true;
          speed = 0;
        }
      }
      break;
    }
  }

  // Horizontal motion (air keeps momentum so hops travel).
  if (speed > 0) {
    let next = c.x + c.facing * speed * dt;
    if (c.mode === 'return') {
      next = c.facing === -1 ? Math.max(homeX(), next) : Math.min(homeX(), next);
    }
    if (next >= max) {
      next = max;
      c.facing = -1;
    } else if (next <= homeX()) {
      next = homeX();
      if (c.mode !== 'return') c.facing = 1;
    }
    c.x = next;
    if (grounded) {
      c.stride += dtMs;
      if (c.stride >= STEP_MS) {
        c.stride -= STEP_MS;
        c.legs = c.legs === 0 ? 1 : 0;
      }
    }
  } else if (grounded) {
    c.legs = 0;
    c.stride = 0;
  }

  // Vertical motion.
  if (airborne(c)) {
    c.y += c.vy * dt;
    c.vy -= GRAVITY * dt;
    if (c.y <= 0) {
      c.y = 0;
      c.vy = 0;
      c.flips = 0;
      c.squash = 130;
      ev.landed = true;
    }
  }

  if (spark && sparkHit(c, spark)) ev.collected = true;
  return ev;
}

/** A tap: jump if grounded, a flip if already in the air (once). */
export function poke(c: Critter): 'jump' | 'flip' | null {
  if (!airborne(c)) {
    c.vy = jumpVelocity(26);
    return 'jump';
  }
  if (c.flips === 0) {
    c.flips = 1;
    c.vy = Math.max(c.vy, jumpVelocity(12));
    return 'flip';
  }
  return null;
}

/** Landing squash then the idle double knee-bob, as scale factors. */
export function poseScale(c: Critter): { sx: number; sy: number; dy: number } {
  if (c.squash > 0) {
    const k = c.squash / 130;
    return { sx: 1 + 0.16 * k, sy: 1 - 0.18 * k, dy: 0 };
  }
  if (c.bob > 0) {
    // two dips across 520ms: |sin| over two half-periods
    const t = 1 - c.bob / 520;
    const d = Math.abs(Math.sin(t * Math.PI * 2));
    return { sx: 1 + 0.06 * d, sy: 1 - 0.1 * d, dy: 0 };
  }
  if (airborne(c)) {
    // stretch on the way up, round out at the apex
    const s = Math.min(1, Math.abs(c.vy) / 400);
    return { sx: 1 - 0.06 * s, sy: 1 + 0.08 * s, dy: 0 };
  }
  return { sx: 1, sy: 1, dy: 0 };
}
