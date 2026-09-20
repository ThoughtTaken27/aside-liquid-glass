/**
 * Opening a web page from inside the app.
 *
 * Three hosts, three right answers:
 *
 *  - **Native Android shell.** Hands the URL to `BrowserActivity`, which
 *    renders it with GeckoView inside the app. This is the one that
 *    matters. It is Firefox's engine rather than Android's WebView for one
 *    reason: the WebView adds an `X-Requested-With` header naming the host
 *    app to every request, Google reads it and refuses to sign in behind
 *    it, and that header cannot be removed since the opt-out was withdrawn
 *    in 2025. Gecko sends no such signal, so the owner's Google session
 *    survives and the page renders in a window the app owns, with no
 *    toolbar above it.
 *  - **Telegram.** Has to go through `openLink`; a plain `window.open`
 *    inside that webview opens something there is no way back from.
 *  - **Plain browser / installed PWA.** A normal new tab. On an installed
 *    iOS web app this is not a jump to Safari: iOS renders it as an in-app
 *    browser overlay that keeps the Safari cookie jar, so the page is
 *    signed in and the app is still underneath it. That overlay carries a
 *    small toolbar, and there is no way to remove it, because Apple
 *    requires every iOS browser to use WebKit and the alternative-engine
 *    entitlement is restricted to the EU. It is the closest iOS allows to
 *    the Android behaviour above.
 *
 * Deliberately not an iframe. google.com sends
 * `x-frame-options: SAMEORIGIN`, so it cannot be framed at all without the
 * `igu=1` escape hatch, and that hatch is served permanently signed out.
 * A top-level navigation in an engine of our own sidesteps the framing
 * rules entirely, which is what the Android path does.
 */
import { openExternal } from '../telegram';

/**
 * The app's page colour, used to tint the Custom Tab chrome.
 *
 * Hard-coded rather than read from `--page` because this crosses the
 * bridge into native code, where CSS tokens do not exist. Keep it equal to
 * `--page` in `theme/tokens.css`.
 */
const TOOLBAR = '#F9F9F7';

/**
 * True when running inside the Capacitor Android shell.
 *
 * Feature-detected rather than imported statically so the web build has no
 * hard dependency on the native runtime being present.
 */
function nativeBridge(): { isNativePlatform?: () => boolean } | undefined {
  return (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor;
}

export function isNativeShell(): boolean {
  try {
    return nativeBridge()?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/**
 * The shell's speculative-loading hook, when one is present.
 *
 * `MainActivity` binds to Chrome's Custom Tabs service at launch and
 * exposes `mayLaunchUrl` under this name. It is absent in every non-native
 * host, and absent in the native one until the service connects, so every
 * call site has to treat it as optional rather than assume it.
 */
interface ShellBridge {
  prefetch?: (url: string) => void;
  open?: (url: string) => void;
}

function prewarmBridge(): ShellBridge | undefined {
  return (window as unknown as { AsideSearch?: ShellBridge }).AsideSearch;
}

/**
 * Hint to Chrome that this URL is probably about to be opened.
 *
 * Called from the address bar as suggestions settle, so by the time a row
 * is tapped Chrome has usually already resolved DNS, completed the TLS
 * handshake and begun fetching. That is most of the visible latency in
 * opening a Custom Tab, and it is the difference between one that appears
 * to paint instantly and one that shows a white flash first.
 *
 * Silent and best-effort by design. A prefetch is a guess, and a guess
 * that fails must cost nothing: no error, no retry, no state.
 */
export function prefetch(url: string): void {
  if (!url) return;
  try {
    prewarmBridge()?.prefetch?.(url);
  } catch {
    /* the shell predates this call, or Chrome never bound */
  }
}

/**
 * Open a URL in the most native surface available.
 *
 * Always resolves. A failure to open is not worth an error state in the
 * caller: the fallback path is a plain new tab, which works everywhere.
 */
export async function openUrl(url: string): Promise<void> {
  if (!url) return;

  /*
   * Preferred: the shell's own partial Custom Tab.
   *
   * Same browser and same signed-in session as the Capacitor plugin
   * below, but launched as a bottom sheet instead of a fullscreen
   * activity, so the app's address bar stays visible and usable above the
   * page. The plugin cannot express that -- it has no binding for
   * `setInitialActivityHeightPx` -- which is the only reason this exists
   * as a separate path rather than a plugin option.
   *
   * Absent on any build older than the one that added it, which is
   * exactly why the plugin path is kept underneath rather than replaced.
   */
  const shell = prewarmBridge();
  if (shell?.open) {
    try {
      shell.open(url);
      return;
    } catch {
      // Fall through to the plugin.
    }
  }

  if (isNativeShell()) {
    try {
      const mod = await import('@capacitor/browser');
      await mod.Browser.open({
        url,
        toolbarColor: TOOLBAR,
        presentationStyle: 'fullscreen',
      });
      return;
    } catch {
      // Plugin missing or the tab refused to open; fall through rather
      // than leaving the tap doing nothing at all.
    }
  }
  openExternal(url);
}

/**
 * Decide whether typed text is a destination or a search.
 *
 * Kept strict on purpose. Treating anything with a dot as a URL is the
 * usual shortcut and it misfires constantly on real queries ("node.js
 * streams", "3.5 vs 4"), which is worse than an unnecessary search: a
 * wrong guess here sends the owner to a dead domain instead of an answer.
 * So a bare word with a dot only counts when it ends in a plausible TLD
 * and has no spaces.
 */
export function asUrl(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;

  if (/^https?:\/\//i.test(text)) {
    try {
      return new URL(text).href;
    } catch {
      return null;
    }
  }
  if (/^localhost(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  // host.tld, optionally with port and path. TLD is letters, 2+ long.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(text)) {
    return `https://${text}`;
  }
  return null;
}
