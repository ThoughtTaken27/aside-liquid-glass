/**
 * Chat or Web, at the top of the home screen.
 *
 * This started on the composer's control row, which was wrong for a reason
 * worth writing down: that row had exactly 94px of slack at 390px wide, and
 * a two-word segmented control wants ~88px of it. Everything still fit, and
 * the row went from comfortable to shoulder-to-shoulder, with the model
 * pill dropping to "Mo…". A control that only fits by consuming all the
 * breathing space does not fit.
 *
 * The top bar is the right home, and not only because there is room. This
 * switch changes what the middle of the screen *is* -- greeting and Recents
 * in one mode, suggestions in the other -- which is a screen-level change,
 * and a centred segmented control at the top is the established idiom for
 * exactly that. A control on the composer row reads as modifying the input,
 * which undersells it.
 *
 * It also costs nothing net: the top bar used to carry a magnifier whose
 * only job was travelling to the search page. There is no search page any
 * more, so that icon is replaced rather than joined, and the dead centre of
 * the bar finally does something.
 *
 * Reach is the fair objection, and the answer is that this is not the only
 * way in: a horizontal swipe across the composer flips the same bit without
 * leaving the thumb zone. Visible control for discovery, gesture for speed.
 */
import { Liquid } from 'liquid-gooey';
import type { ComposerMode } from './Composer';
import { haptic } from '../telegram';

const OPTIONS: { id: ComposerMode; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  /*
   * "Web", not "Search". There are two searches in this app and they are
   * different jobs: this one hands off to the browser, while the magnifier
   * in the Recents header filters the session list already on screen.
   * Labelling both "Search" would be wrong half the time.
   */
  { id: 'search', label: 'Web' },
];

export function ModeSwitch({
  mode,
  onChange,
}: {
  mode: ComposerMode;
  onChange: (mode: ComposerMode) => void;
}) {
  return (
    <div
      className="mode-switch mode-switch-context"
      role="group"
      aria-label="Chat or web search"
      data-control="context-switch"
      data-mode={mode}
    >
      {/*
        One indicator that slides, rather than two backgrounds that swap.
        The distance is ~44px, which is short enough that the eye tracks it
        as a single object moving instead of a smear -- the thing a
        bottom-to-top morph across the whole screen could never be. It is a
        transform on its own layer, so it costs nothing to animate.
      */}
      <div className="mode-switch-liquid-layer" aria-hidden="true">
        <Liquid
          className="mode-switch-liquid"
          blur={5}
          contrast={20}
          fill="var(--mode-switch-goo)"
          filterPadding={10}
        >
          <Liquid.Item effect="morph" radius={999}>
            <span className="mode-switch-indicator" />
          </Liquid.Item>
        </Liquid>
      </div>
      <span className="mode-switch-selection" aria-hidden="true" />
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`mode-switch-option${mode === option.id ? ' is-on' : ''}`}
          aria-pressed={mode === option.id}
          onClick={() => {
            if (mode === option.id) return;
            haptic('light');
            onChange(option.id);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
