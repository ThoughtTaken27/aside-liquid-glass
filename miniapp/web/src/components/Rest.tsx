/**
 * The home screen's resting state.
 *
 * The old home screen opened on a composer stacked directly on top of the
 * session list, so the first thing you saw was a wall of past work. This
 * inverts that: opening the app lands on a quiet, near-empty screen -- the
 * mark, a greeting, and the composer -- and the history lives one swipe
 * below, scrolling up from under the composer.
 *
 * Nothing here is decorative-only. The greeting is the one place the app
 * addresses the owner by name, and it is also the thing that makes an
 * otherwise empty screen feel deliberate rather than unloaded.
 */
import { LiquidGreeting } from './LiquidGreeting';
import { TextReveal } from './Affect';
import { AsideSymbol } from './Brand';
import { useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown } from './Icons';

/**
 * The greetings, by hour band.
 *
 * Six bands rather than the usual three because the edges are what matter
 * here: someone opening this at 01:00 and someone opening it at 09:00 are
 * not having the same day, and a flat "Good morning" for both reads as
 * generated.
 *
 * Several per band because there used to be exactly one, which meant every
 * launch inside the same stretch of hours produced a byte-identical
 * screen. A greeting that never varies stops being a greeting.
 *
 * `named` and `plain` are kept as separate strings rather than one
 * template with the name spliced out: dropping a name from
 * "Up late, %s?" by string surgery leaves a dangling comma, and every
 * near-miss there is visible on an otherwise empty screen.
 */
interface Greeting {
  named: (who: string) => string;
  plain: string;
}

const BANDS: Array<{ until: number; options: Greeting[] }> = [
  {
    until: 5,
    options: [
      { named: (w) => `Up late, ${w}?`, plain: 'Up late?' },
      { named: (w) => `Still awake, ${w}?`, plain: 'Still awake?' },
      { named: (w) => `Late one, ${w}?`, plain: 'A late one?' },
    ],
  },
  {
    until: 9,
    options: [
      { named: (w) => `Early start, ${w}`, plain: 'Early start' },
      { named: (w) => `You are up early, ${w}`, plain: 'Up early' },
      { named: (w) => `Morning already, ${w}`, plain: 'Morning already' },
    ],
  },
  {
    until: 12,
    options: [
      { named: (w) => `Morning, ${w}`, plain: 'Good morning' },
      { named: (w) => `Good morning, ${w}`, plain: 'Good morning' },
      { named: (w) => `Hey, ${w}`, plain: 'Hey there' },
    ],
  },
  {
    until: 17,
    options: [
      { named: (w) => `Afternoon, ${w}`, plain: 'Good afternoon' },
      { named: (w) => `Good afternoon, ${w}`, plain: 'Good afternoon' },
      { named: (w) => `Hey, ${w}`, plain: 'Hey there' },
    ],
  },
  {
    until: 21,
    options: [
      { named: (w) => `Evening, ${w}`, plain: 'Good evening' },
      { named: (w) => `Good evening, ${w}`, plain: 'Good evening' },
      { named: (w) => `Hey, ${w}`, plain: 'Hey there' },
    ],
  },
  {
    until: 24,
    options: [
      { named: (w) => `Still up, ${w}?`, plain: 'Still up?' },
      { named: (w) => `Evening, ${w}`, plain: 'Good evening' },
      { named: (w) => `Late one, ${w}?`, plain: 'A late one?' },
    ],
  },
];

/** Which band an hour falls in. Exported so the bands are testable. */
export function bandFor(date: Date): number {
  const hour = date.getHours();
  return BANDS.findIndex((b) => hour < b.until);
}

/**
 * The greeting for a moment, optionally varied by `pick`.
 *
 * `pick` is any number; it is reduced into the band's options, so callers
 * can pass a counter, a timestamp or a random value without knowing how
 * many phrasings exist. Pure, so the bands and the nameless forms are
 * asserted directly rather than eyeballed.
 */
export function greetingFor(
  name: string | undefined,
  date: Date,
  pick = 0,
): string {
  const who = (name || '').trim();
  const band = BANDS[bandFor(date)] ?? BANDS[BANDS.length - 1];
  const options = band.options;
  // Non-finite and negative values must still land on a real option.
  const index = Number.isFinite(pick)
    ? ((Math.trunc(pick) % options.length) + options.length) % options.length
    : 0;
  const choice = options[index];
  return who ? choice.named(who) : choice.plain;
}

/**
 * The resting greeting and shared product signature.
 *
 * Telegram keeps the signature in the shared markup; the standalone shell
 * hides it in the standalone-only material layer so the phone stays quiet.
 */
/**
 * Whether the resting hero has played its entrance yet.
 *
 * Once per app load -- see the note on `first` inside `RestHero`.
 */
let heroEntrancePlayed = false;
const greetingPicks = new Map<number, number>();

export function RestHero({ name, children }: { name?: string; children?: ReactNode }) {
  /*
   * Chosen once per mount, not per render.
   *
   * The session list polls every 8s and re-renders this, so picking on
   * each render would reshuffle the greeting under the reader every few
   * seconds. Keyed by the band so crossing midnight while the app is open
   * still moves it on.
   */
  const now = new Date();
  const band = bandFor(now);
  const pick = useMemo(
    () => {
      if (!greetingPicks.has(band)) greetingPicks.set(band, Math.floor(Math.random() * 3));
      return greetingPicks.get(band)!;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [band],
  );
  /*
   * The entrance plays once per app load, not once per mount.
   *
   * Home remounts on every return from a thread, and a greeting that
   * sweeps in each time reads as a splash screen that cannot be
   * dismissed. The flag lives at module level because it is about the
   * app's life, not any one screen's: read in a layout effect so the
   * class lands before first paint, with no flash of the settled hero.
   */
  const [first, setFirst] = useState(false);
  useLayoutEffect(() => {
    if (!heroEntrancePlayed) {
      heroEntrancePlayed = true;
      setFirst(true);
    }
  }, []);

  return (
    <section
      className={`rest-hero${first ? ' is-first' : ''}`}
      aria-labelledby="rest-greeting"
      data-surface="atmospheric"
    >
      {document.documentElement.dataset.client !== 'standalone' ? <span className="rest-mark" aria-hidden="true"><AsideSymbol size={38} /></span> : null}
      <h1 id="rest-greeting" className="rest-greeting" aria-label={greetingFor(name, now, pick)}>
        {document.documentElement.dataset.client === 'standalone'
          ? <LiquidGreeting text={greetingFor(name, now, pick).replace(/,\s+/, ',\n')} />
          : <TextReveal text={greetingFor(name, now, pick)} play={first} delay={180} accent={(name || '').trim().split(/\s+/)[0] || undefined} />}
      </h1>
      {children}
    </section>
  );
}

/**
 * The affordance that says there is something below the composer.
 *
 * Without it the history is genuinely undiscoverable -- a screen that ends
 * in a composer gives no reason to think anything is under it. It is a
 * button as well as a hint so the gesture is not the only way down.
 */
export function RestCue({
  count,
  pending = false,
  onOpen,
}: {
  count: number;
  /** Recents has not loaded yet: hold the cue's place, invisibly. */
  pending?: boolean;
  onOpen: () => void;
}) {
  /*
   * The cue used to appear only once Recents arrived, and its 44px pushed
   * the centred greeting up 22px half a second after launch: a visible hop.
   * Until the list is known the slot is held by an invisible stand-in, so
   * the greeting lands in its final place and the chevron fades in there.
   */
  if (!count) return pending ? <span className="rest-cue rest-cue-pending" aria-hidden="true" /> : null;
  return (
    <button type="button" className="rest-cue" aria-label="Recent work" onClick={onOpen}>
      {/* Label dropped for now: it sat in the composer critter's hop path. */}
      <ChevronDown size={16} strokeWidth={2} />
    </button>
  );
}
