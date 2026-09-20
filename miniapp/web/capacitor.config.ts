import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native Android shell for the Aside mobile app.
 *
 * The app is a remote client by nature: the agent, the browser, the
 * filesystem and the memory all live on the Mac, and the server that
 * fronts them is the only thing that can answer an API call. So the shell
 * loads the app from that server rather than bundling a copy.
 *
 * That choice is what keeps everything else simple. Because the WebView's
 * origin IS the server's origin, every relative `/api/...` path, the
 * session cookie, and the WebSocket upgrade all behave exactly as they do
 * in the browser. Bundling the assets locally would move the app to a
 * `capacitor://` origin and turn every one of those into a cross-origin
 * problem: CORS on every route, and a `SameSite=Lax` cookie that would
 * simply stop being sent.
 *
 * The cost is that the app needs the Mac reachable to paint at all, which
 * is already true of every screen in it.
 *
 * The hostname is a tailnet name, so it only resolves on the owner's own
 * devices. It is stable across reboots (Tailscale state persists) and
 * carries a real Let's Encrypt certificate, which is what lets the WebView
 * load it over https with no certificate exceptions.
 */

/**
 * The Mac's tailnet hostname, e.g. `my-mac.tail1234.ts.net`.
 *
 * Read from the environment rather than written here because it differs
 * for every install, and a checked-in hostname would send someone else's
 * phone to a machine that is not theirs and cannot answer it.
 * `build-android.sh` fills this in by asking Tailscale directly.
 *
 * Failing loudly beats defaulting. A build that quietly produced an APK
 * pointing at the wrong host would only reveal itself as an app that hangs
 * on a blank screen, which is a much worse thing to debug than a build
 * that refuses to start.
 */
const tailnetHost = process.env.ASIDE_TAILNET_HOST;
if (!tailnetHost) {
  throw new Error(
    'ASIDE_TAILNET_HOST is not set.\n' +
      "It is the Mac's tailnet hostname, which you can read with:\n" +
      '  tailscale status --json | grep -i dnsname\n' +
      'Then either export it, or run the build through build-android.sh, ' +
      'which resolves it for you.',
  );
}

const config: CapacitorConfig = {
  appId: 'app.aside.mobile',
  appName: 'Aside',
  // Required to exist even when `server.url` wins at runtime. It is also
  // the payload a future offline shell would fall back to.
  webDir: 'dist',
  // Matches the app's page colour (`--page`), so the window behind the
  // WebView does not flash a different shade before first paint.
  backgroundColor: '#F9F9F7',
  server: {
    url: `https://${tailnetHost}/app`,
    androidScheme: 'https',
    // Everything is served over real TLS; no cleartext exception needed.
    cleartext: false,
    /*
     * Hosts the WebView may navigate to without handing off to Chrome.
     * Deliberately just the one: a search result or an external link
     * should open in the real browser with its own address bar, not
     * silently inside an app that looks like Aside.
     */
    allowNavigation: [tailnetHost],
  },
  android: {
    // The app draws its own warm background; the default white splash
    // between process start and first paint is the jarring part.
    backgroundColor: '#F9F9F7',
    /*
     * Mixed content stays off. Nothing in the app needs it, and leaving
     * it on would let a downgraded asset through on a network that is
     * already private.
     */
    allowMixedContent: false,
    // Public/distributable builds must not expose app DOM, cookies, or
    // network traffic through chrome://inspect.
    webContentsDebuggingEnabled: false,
  },
};

export default config;
