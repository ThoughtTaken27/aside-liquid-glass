/**
 * The software keyboard, animated.
 *
 * `interactive-widget=resizes-content` (index.html) fixed the layout: the top
 * bar and greeting stay put and only the composer rides up. But Chrome
 * applies that resize in one step, so the screen snapped into its new shape
 * while the keyboard slid. Claude's app moves the composer WITH the keyboard.
 *
 * Chrome's VirtualKeyboard API lets the page own that motion. With
 * `overlaysContent` the keyboard draws over the page and reports its size;
 * the app writes that size into `--kb`, a registered `<length>` that CSS
 * transitions, and `#root` gives up exactly that much height
 * (`theme/keyboard.css`). Every flex layout inside, the docked composer, the
 * centred greeting and a pinned transcript, then glides instead of jumping.
 * Bottom sheets come along because `#root` is their containing block.
 *
 * Timing: the size can arrive late, at the END of the keyboard's slide. So
 * on focus the last-known height (cached per device) starts the motion at
 * once, in step with the keyboard, and the real geometry retargets it. A CSS
 * transition retargets from its current value, so a correction is a bend
 * in the curve, never a jump.
 *
 * Anticipate only when a keyboard is really coming. Starting the lift on
 * `pointerup` did not hold: a tap that slid a few pixels is no tap to
 * Chrome, so it focuses nothing and no keyboard comes, yet the composer had
 * already risen and the watchdog dropped it again. That rise and fall read
 * as the keyboard opening and closing, and it took a second tap. Now the
 * lift starts on a real focus, or on a real tap (`click`) into the field
 * that already has focus, which is how the keyboard comes back after the
 * back gesture hid it. A script focus raises the keyboard only once the page
 * has been touched (Chrome's rule), so before that nothing moves at all.
 * The watchdog stays for the rare focus that still brings no keyboard.
 *
 * Browsers without the API (iOS, Firefox) keep the meta tag's resize.
 */
import { isStandaloneEntry } from './standalone';

interface VirtualKeyboardLike extends EventTarget {
  overlaysContent: boolean;
  readonly boundingRect: DOMRectReadOnly;
}

const CACHE_KEY = 'aside.kbh';
/** Longer than the keyboard's own slide, so a slow device is not undone. */
const WATCHDOG_MS = 700;
/** Just past the CSS transition, so a field is revealed in its final box. */
const SETTLE_MS = 340;

const NOT_TYPED = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
]);

function isEditable(el: Element | null): el is HTMLElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return !NOT_TYPED.has(el.type) && !el.readOnly && !el.disabled;
  return el instanceof HTMLElement && el.isContentEditable;
}

let current = 0;

function apply(px: number): void {
  const next = Math.max(0, Math.round(px));
  if (next === current) return;
  current = next;
  const root = document.documentElement;
  root.style.setProperty('--kb', `${next}px`);
  root.dataset.kb = next > 0 ? 'open' : 'closed';
}

/**
 * A field outside the composer (recents search, memory filter, tab search)
 * can end up behind the keyboard once the page has shrunk. The composer is
 * docked to the bottom edge and never needs this.
 */
function revealFocused(): void {
  window.setTimeout(() => {
    const el = document.activeElement;
    if (!isEditable(el)) return;
    if (el.closest('.home-dock, .thread-footer, .composer')) return;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, SETTLE_MS);
}

export function installKeyboardMotion(): void {
  if (!(isStandaloneEntry() || location.pathname === '/dev.html')) return;
  const vk = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard;
  const root = document.documentElement;

  if (import.meta.env.DEV) {
    // Desktop has no software keyboard to fire events, so the harness drives
    // the same path by hand with a DOM event (it crosses into automation's
    // isolated world, where a window global would not):
    // document.dispatchEvent(new CustomEvent('aside:keyboard', { detail: 320 }))
    root.dataset.vk = 'on';
    document.addEventListener('aside:keyboard', (e) => {
      const px = Number((e as CustomEvent).detail) || 0;
      apply(px);
      if (px > 0) revealFocused();
    });
  }

  if (!vk) return;
  // Only touch devices have a keyboard to make room for. Desktop Chrome
  // ships the API too, and opting in there would change nothing but risk.
  if (!matchMedia('(pointer: coarse)').matches) return;

  vk.overlaysContent = true;
  root.dataset.vk = 'on';

  let cached = 0;
  try {
    cached = Number(localStorage.getItem(CACHE_KEY)) || 0;
  } catch {
    // Private mode: the first open of each launch just starts a beat later.
  }
  let watchdog = 0;
  let confirmed = false;

  vk.addEventListener('geometrychange', () => {
    const h = vk.boundingRect.height;
    window.clearTimeout(watchdog);
    confirmed = h > 0;
    if (h > 0) {
      cached = h;
      try {
        localStorage.setItem(CACHE_KEY, String(Math.round(h)));
      } catch {
        // ignore
      }
    }
    apply(h);
    if (h > 0) revealFocused();
  });

  // Start in step with the keyboard rather than after it. Also on a tap into
  // a field that already has focus: the keyboard can be dismissed with the
  // system back gesture while the field keeps focus, and a tap brings it
  // back without any focus event. `click` only fires for a real tap.
  const touched = () =>
    (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true;
  const anticipate = (target: EventTarget | null) => {
    if (!isEditable(target as Element | null) || cached <= 0 || current > 0 || !touched()) return;
    confirmed = false;
    apply(cached);
    window.clearTimeout(watchdog);
    watchdog = window.setTimeout(() => {
      // Some Android keyboards update their rectangle without delivering
      // the event in time. Do not drop a real keyboard behind the field.
      if (!confirmed) apply(Math.max(0, vk.boundingRect.height));
    }, WATCHDOG_MS);
  };
  document.addEventListener('focusin', (e) => anticipate(e.target), true);
  document.addEventListener(
    'click',
    (e) => {
      if (e.target === document.activeElement) anticipate(e.target);
    },
    true,
  );

  // Leaving every field closes the keyboard: start the descent with it.
  // Deferred one task so focus moving between two fields does not dip.
  document.addEventListener(
    'focusout',
    () => {
      window.setTimeout(() => {
        if (!isEditable(document.activeElement)) {
          window.clearTimeout(watchdog);
          apply(0);
        }
      }, 0);
    },
    true,
  );
}

installKeyboardMotion();
