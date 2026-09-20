import { useState } from 'react';
import { isInstalled } from '../standalone';

const DISMISSED_KEY = 'aside.install-hint.dismissed';

/**
 * Tell iPhone owners to install the app, once.
 *
 * Chrome fires `beforeinstallprompt` and lets a site offer installation
 * with a button. Safari has never implemented it and shows no install
 * affordance of its own, so on iOS an uninstalled web app looks like a
 * website and stays one.
 *
 * That distinction is not cosmetic here. Running from the Home Screen is
 * what gets push notifications at all (WebKit gates the Push API on it),
 * and what exempts the app from the seven-day wipe Safari applies to
 * script-writable storage on sites it considers idle. Left in a tab, this
 * app would lose its saved session roughly weekly for no visible reason.
 *
 * Shown only where it is actionable: iOS, in a browser tab, not already
 * dismissed. Android is excluded because Chrome offers its own install
 * prompt, and a second one competing with it would be noise.
 */
export function InstallHint() {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      // Private browsing throws rather than returning null. Treat an
      // unreadable preference as "not dismissed" so the hint still works.
      return false;
    }
  });

  if (hidden || !isIosBrowserTab()) return null;

  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Non-fatal: the hint reappears next launch, which is a smaller
      // problem than it never appearing.
    }
  };

  return (
    <aside
      className="install-hint surface-card"
      data-surface="notice"
      data-surface-card="install"
      role="note"
    >
      <p className="install-hint-text surface-content" data-surface-content>
        Add Aside to your Home Screen for notifications and a full-screen
        app. Tap Share, then <strong>Add to Home Screen</strong>.
      </p>
      <button
        type="button"
        className="install-hint-close surface-row"
        data-surface-row="dismiss"
        onClick={dismiss}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </aside>
  );
}

/**
 * True on an iPhone or iPad that is running this in a browser tab.
 *
 * The iPad check is the awkward one: iPadOS reports itself as a Mac, and
 * the only reliable way to tell one from an actual Mac is that it has a
 * touchscreen. Desktop Safari would otherwise be told to use a Share menu
 * item that does something different there.
 */
function isIosBrowserTab(): boolean {
  if (isInstalled()) return false;
  const ua = navigator.userAgent;
  const iphone = /iPad|iPhone|iPod/.test(ua);
  const ipad = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (!iphone && !ipad) return false;
  // Chrome and Firefox on iOS are WebKit underneath but have no Add to
  // Home Screen item, so the instruction would be wrong there.
  return !/CriOS|FxiOS|EdgiOS/.test(ua);
}
