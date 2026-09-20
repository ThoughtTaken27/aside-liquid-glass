/**
 * The home screen's resting state.
 *
 * The greeting is the only text on an otherwise empty screen, so a band
 * that lands wrong is very visible. It is a pure function of the hour for
 * exactly this reason: the boundaries are asserted rather than eyeballed.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RestCue, RestHero, bandFor, greetingFor } from '../src/components/Rest';
import { pillModelLabel } from '../src/utils/pills';
import { threadErrorText } from '../src/utils/format';

function at(hour: number): Date {
  const d = new Date(2026, 7, 2, hour, 30, 0);
  return d;
}

describe('greetingFor', () => {
  it('covers every hour of the day, in every phrasing', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      for (let pick = 0; pick < 3; pick += 1) {
        const text = greetingFor('Alex', at(hour), pick);
        expect(text, `hour ${hour} pick ${pick}`).toBeTruthy();
        expect(text).toContain('Alex');
      }
    }
  });

  it('uses the late-night band before 5am', () => {
    expect(greetingFor('Alex', at(1), 0)).toBe('Up late, Alex?');
    expect(greetingFor('Alex', at(4), 0)).toBe('Up late, Alex?');
  });

  it('switches at each boundary', () => {
    expect(greetingFor('Alex', at(5), 0)).toBe('Early start, Alex');
    expect(greetingFor('Alex', at(9), 0)).toBe('Morning, Alex');
    expect(greetingFor('Alex', at(12), 0)).toBe('Afternoon, Alex');
    expect(greetingFor('Alex', at(17), 0)).toBe('Evening, Alex');
    expect(greetingFor('Alex', at(21), 0)).toBe('Still up, Alex?');
  });

  it('offers more than one phrasing per band', () => {
    // The whole point: one string per band meant every launch in the same
    // stretch of hours produced a byte-identical screen.
    for (const hour of [1, 7, 10, 14, 19, 22]) {
      const seen = new Set(
        [0, 1, 2].map((pick) => greetingFor('Alex', at(hour), pick)),
      );
      expect(seen.size, `hour ${hour}`).toBeGreaterThan(1);
    }
  });

  it('drops the name cleanly when there is not one', () => {
    // No dangling comma, and no "undefined" on an otherwise empty screen.
    for (const name of [undefined, '', '   ']) {
      for (let pick = 0; pick < 3; pick += 1) {
        const text = greetingFor(name, at(13), pick);
        expect(text).not.toContain(',');
        expect(text).not.toContain('undefined');
        expect(text.trim()).toBe(text);
      }
    }
  });

  it('takes any number as the pick without falling off the list', () => {
    for (const pick of [-7, 0, 3, 99, 1.9, NaN, Infinity]) {
      expect(greetingFor('Alex', at(13), pick)).toContain('Alex');
    }
  });
});

describe('bandFor', () => {
  it('maps each hour to exactly one band, in order', () => {
    const bands = Array.from({ length: 24 }, (_, h) => bandFor(at(h)));
    expect(bands.every((b) => b >= 0)).toBe(true);
    // Bands only ever move forward through the day.
    expect([...bands].sort((a, b) => a - b)).toEqual(bands);
  });
});

describe('RestHero', () => {
  it('renders the greeting as the screen heading', () => {
    render(<RestHero name="Alex" />);
    expect(
      screen.getByRole('heading', { level: 1 }).textContent,
    ).toContain('Alex');
  });
});

describe('RestCue', () => {
  it('stays hidden when there is no history to reveal', () => {
    const { container } = render(<RestCue count={0} onOpen={() => {}} />);
    expect(container.querySelector('.rest-cue')).toBeNull();
  });

  it('appears once there is something below', () => {
    render(<RestCue count={3} onOpen={() => {}} />);
    expect(screen.getByText('Recent work')).toBeTruthy();
  });
});

describe('pillModelLabel', () => {
  it('drops a trailing qualifier so the pill names the model', () => {
    // "DeepSee…" named nothing; the qualifier is the part worth losing.
    expect(pillModelLabel('DeepSeek V4 Flash (Free)')).toBe('DeepSeek V4 Flash');
    expect(pillModelLabel('Nemotron 3 Ultra (Nvidia)')).toBe('Nemotron 3 Ultra');
    expect(pillModelLabel('oc/deepseek-v4-flash-free(max)')).toBe(
      'oc/deepseek-v4-flash-free',
    );
  });

  it('leaves names without a qualifier untouched', () => {
    for (const name of ['Opus 5', 'GLM 5.2', 'Sonnet 4.6', 'gpt-5.5']) {
      expect(pillModelLabel(name)).toBe(name);
    }
  });

  it('never returns an empty pill', () => {
    // A label that is only a parenthetical would otherwise vanish.
    expect(pillModelLabel('(Free)')).toBe('(Free)');
    expect(pillModelLabel('')).toBe('');
  });

  it('only strips the LAST parenthetical', () => {
    expect(pillModelLabel('Foo (v2) Bar (Free)')).toBe('Foo (v2) Bar');
  });
});

describe('threadErrorText', () => {
  it('never shows a status code or a snake_case reason', () => {
    // "404: session_not_found" was reaching the screen verbatim.
    const out = threadErrorText(new Error('404: session_not_found'));
    expect(out).not.toMatch(/\d{3}:/);
    expect(out).not.toContain('_');
    expect(out).toBe('This chat is no longer on your Mac.');
  });

  it('explains the cases a user can act on', () => {
    expect(threadErrorText(new Error('413: transcript_too_large'))).toContain(
      'too long',
    );
    expect(threadErrorText(new Error('401: expired'))).toContain('bot menu');
    expect(threadErrorText(new TypeError('Failed to fetch'))).toContain(
      'awake and online',
    );
  });

  it('falls back to something readable for anything unknown', () => {
    expect(threadErrorText(new Error('500: kaboom'))).toBe('kaboom');
    expect(threadErrorText(null)).toBe('Something went wrong loading this chat.');
  });
});
