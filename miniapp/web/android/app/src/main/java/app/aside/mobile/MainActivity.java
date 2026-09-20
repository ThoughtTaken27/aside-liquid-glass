package app.aside.mobile;

import android.Manifest;
import android.content.ComponentName;
import android.content.pm.PackageManager;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.browser.customtabs.CustomTabColorSchemeParams;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.browser.customtabs.CustomTabsServiceConnection;
import androidx.browser.customtabs.CustomTabsSession;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/**
 * The native shell.
 *
 * Its one job beyond hosting the WebView is telling the web app where the
 * system bars are.
 *
 * Since targetSdk 35 Android lays every app out edge to edge, so the
 * WebView occupies the whole screen including the strip behind the status
 * bar clock and battery. The web app already reserves space at the top,
 * but it read that measurement from Telegram's safe-area API, which does
 * not exist here, so it fell back to zero and drew its top bar underneath
 * the system icons.
 *
 * The CSS carries an `env(safe-area-inset-top)` fallback for this, and in a
 * recent WebView that alone is usually enough. It is not something to
 * depend on: WebView has historically reported those insets only for
 * display cutouts rather than for the status bar, and the behaviour varies
 * by Android version and OEM skin. Samsung's One UI is precisely the sort
 * of place that bites.
 *
 * So the real measurement is taken here, from the framework, and pushed
 * into the same CSS variables. An inline style set from JS outranks the
 * stylesheet rule, so when both paths work the native number wins and
 * nothing is padded twice.
 */
public class MainActivity extends BridgeActivity {

    /**
     * A live connection to Chrome, used only to make search feel instant.
     *
     * Null until the service binds, and null again if Chrome is killed for
     * memory while the app is backgrounded, so every read has to re-check
     * rather than assume the field survived.
     */
    private CustomTabsSession tabsSession;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        /*
         * The page is warm cream, so the status bar icons have to be dark
         * to be legible. Without this they default to white on a near-white
         * background and the clock effectively disappears.
         */
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(true);
        controller.setAppearanceLightNavigationBars(true);

        requestMicrophoneUpFront();
        bindCustomTabs();
        // Start Gecko while the home screen is still being read, so the
        // first search does not pay for engine startup.
        BrowserActivity.prewarm(this);

        /*
         * Let the search iframe load inside the app.
         *
         * Capacitor's BridgeWebViewClient treats every navigation as a
         * candidate for an external Intent: if the host is not the app's
         * own origin and not on the allowNavigation list, it fires
         * ACTION_VIEW and returns true, handing the URL to the system
         * browser. For the top-level frame that is correct behaviour -- a
         * tap that would leave the app should leave the app.
         *
         * But `shouldOverrideUrlLoading` is also called for subframe
         * navigations on API 21+, which means the search iframe's initial
         * load of google.com and every click that navigates it would be
         * kicked out to Chrome instead of rendering here. So this override
         * re-checks `isForMainFrame()`: the super behaviour (and its
         * external-Intent handoff) runs only for the top-level frame, and
         * everything inside the iframe is left alone to load normally.
         *
         * The OVERRIDING constraint is that the app's own origin is
         * always a main-frame navigation anyway, so this never changes how
         * the app itself loads. It only affects frames it embeds.
         */
        final WebView webview = getBridge() != null ? getBridge().getWebView() : null;
        if (webview != null) {
            /*
             * The address bar's speculative-loading hook.
             *
             * Adding a JavaScript interface to a WebView is normally a
             * serious thing to do, because it hands page script a direct
             * line into the app. Two properties make it acceptable here
             * and both have to hold: the WebView only ever loads the
             * owner's own tailnet origin (see `allowNavigation` in
             * capacitor.config.ts), and the interface exposes exactly one
             * method that takes a URL and returns nothing. The worst a
             * compromised page could do with it is ask Chrome to prefetch
             * something, which it could already do with a link tag.
             */
            webview.addJavascriptInterface(new SearchPrewarm(), "AsideSearch");

            final WebViewClient base = webview.getWebViewClient();
            webview.setWebViewClient(new WebViewClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    return base.shouldInterceptRequest(view, request);
                }
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    if (request.isForMainFrame()) {
                        return base.shouldOverrideUrlLoading(view, request);
                    }
                    return false;
                }
                @Override
                public void onPageStarted(WebView view, String url, Bitmap favicon) {
                    super.onPageStarted(view, url, favicon);
                    base.onPageStarted(view, url, favicon);
                }
                @Override
                public void onPageFinished(WebView view, String url) {
                    super.onPageFinished(view, url);
                    base.onPageFinished(view, url);
                }
            });
        }

        final View decor = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decor, (view, insets) -> {
            /*
             * systemBars covers the status and navigation bars; displayCutout
             * covers a punch-hole or notch that can sit lower than the status
             * bar on some devices. Taking the union means the app never draws
             * under either.
             */
            Insets bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout());

            // Framework insets are physical pixels; CSS wants density-independent ones.
            float density = getResources().getDisplayMetrics().density;
            final int top = Math.round(bars.top / density);
            final int bottom = Math.round(bars.bottom / density);
            final int left = Math.round(bars.left / density);
            final int right = Math.round(bars.right / density);

            publishInsets(top, bottom, left, right);
            // Returning the insets unconsumed keeps normal layout behaviour
            // for anything else that wants to react to them.
            return insets;
        });
    }

    /**
     * Warm Chrome up before the owner has typed anything.
     *
     * `warmup()` starts Chrome's browser process and its network stack in
     * the background, which is the single largest fixed cost in opening a
     * Custom Tab: without it the first search of a session pays for a cold
     * browser process on top of the page load.
     *
     * The session created here is then what `mayLaunchUrl` speculates
     * against, and it is also what makes the eventual tab reuse the warmed
     * process rather than starting over.
     *
     * Entirely best-effort. If Chrome is not installed, is disabled, or
     * the bind is refused, `tabsSession` simply stays null and every
     * search still works exactly as it would have: the Custom Tab opens
     * through the normal intent path, a little slower.
     */
    private void bindCustomTabs() {
        try {
            // Resolves the user's *default* browser that supports Custom
            // Tabs, not Chrome specifically, so this is correct on a phone
            // where the default is something else.
            final String pkg = CustomTabsClient.getPackageName(this, null);
            if (pkg == null) return;
            CustomTabsClient.bindCustomTabsService(this, pkg, new CustomTabsServiceConnection() {
                @Override
                public void onCustomTabsServiceConnected(ComponentName name, CustomTabsClient client) {
                    try {
                        client.warmup(0L);
                        tabsSession = client.newSession(null);
                    } catch (Exception ignored) {
                        // A browser that binds but refuses to warm up is
                        // not a failure worth surfacing anywhere.
                    }
                }

                @Override
                public void onServiceDisconnected(ComponentName name) {
                    // Chrome was killed, usually for memory. The next
                    // prefetch is a no-op until something rebinds, and the
                    // tab itself still opens.
                    tabsSession = null;
                }
            });
        } catch (Exception ignored) {
            // Nothing here is load-bearing; search works without any of it.
        }
    }

    /** The app's page colour, so the tab does not read as a different app.
     *  Mirrors `--page` in web/src/theme/tokens.css. */
    private static final int TOOLBAR_COLOR = 0xFFF9F9F7;

    /**
     * The methods the page can call into the shell.
     *
     * Both return void and report nothing. `prefetch` is a hint, and a hint
     * that could fail visibly would tempt the caller into waiting on it.
     * `open` is fire-and-forget for the same reason: the web layer has
     * already decided to navigate, and there is no useful thing for it to
     * do if the browser refuses.
     */
    private final class SearchPrewarm {
        @JavascriptInterface
        public void prefetch(String url) {
            if (url == null || url.isEmpty()) return;
            /*
             * Speculate through Gecko, which is what actually renders the
             * page now. This used to hint to Chrome via `mayLaunchUrl`,
             * which stopped meaning anything the moment the search left
             * Custom Tabs for the in-app engine: it was warming a browser
             * that would never be opened.
             */
            BrowserActivity.speculate(url);
        }

        /**
         * Open a URL as a fullscreen Custom Tab: real Chrome, signed in.
         *
         * **This was briefly a bottom sheet and that was a mistake worth
         * recording.** `setInitialActivityHeightPx` does exactly what it
         * advertises: it leaves the host app visible above the page. The
         * problem is what the host app was showing there. Google's own
         * result page already opens with a Google logo and a search box,
         * and a Custom Tab already draws a toolbar with the page title
         * above that. Adding this app's address bar on top produced three
         * search fields and a half-clipped suggestion row stacked before
         * the first result. Every layer was individually justifiable and
         * the result was unusable.
         *
         * So the tab takes the whole screen. The app's own chrome is not
         * additional context here, it is a fourth copy of the same
         * control, and the back gesture already returns to it.
         *
         * What is left is deliberately the thinnest browser possible:
         * `setShowTitle(false)` collapses the toolbar from two lines to
         * one, and `setUrlBarHidingEnabled(true)` scrolls even that away.
         * Past the first flick it is Google, full bleed, nothing else.
         */
        @JavascriptInterface
        public void open(String url) {
            if (url == null || url.isEmpty()) return;
            final Uri uri;
            try {
                uri = Uri.parse(url);
            } catch (Exception ignored) {
                return;
            }
            /*
             * http(s) only.
             *
             * This method is reachable from any script running in the
             * pinned origin, and it launches trusted in-app chrome at
             * whatever it is handed. Without this check an XSS on our own
             * origin gets a navigation primitive it otherwise would not
             * have: `file:`, `content:` and `javascript:` all parse fine
             * as a Uri. A search result is always http(s), so nothing
             * legitimate is lost.
             */
            if (!isWebUrl(uri)) return;
            runOnUiThread(() -> {
                try {
                    final Intent intent = new Intent(MainActivity.this, BrowserActivity.class);
                    intent.putExtra(BrowserActivity.EXTRA_URL, uri.toString());
                    /*
                     * No transition animation. The default slide is ~300ms
                     * of motion in front of a page that, with a warm
                     * session, has often already started painting. Cutting
                     * it makes the browser feel like part of the same
                     * screen rather than a place you travelled to.
                     */
                    intent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
                    startActivity(intent);
                } catch (Exception ignored) {
                    // Nothing sensible to fall back to: the whole point is
                    // that this stays in the app. A failure here means the
                    // engine could not start, which the next attempt retries.
                }
            });
        }
    }

    /**
     * Ask for the microphone before the page ever needs it.
     *
     * getUserMedia inside a WebView is gated twice: the page requests it,
     * and the app must already hold the OS permission. If the app does not,
     * the WebView denies the request outright rather than prompting, and
     * the page sees a flat refusal it cannot recover from -- which is what
     * "Microphone access is off for this site" was.
     *
     * Asking at launch means the OS dialog appears once, on a screen where
     * it makes sense, instead of the first voice recording failing silently.
     * Declining is handled fine: the composer still types, and the next
     * launch asks again.
     */
    private void requestMicrophoneUpFront() {
        boolean granted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
        if (!granted) {
            ActivityCompat.requestPermissions(
                    this, new String[]{Manifest.permission.RECORD_AUDIO}, 4001);
        }
    }

    /**
     * Write the measured insets into the page as CSS custom properties.
     *
     * Posted to the WebView's own thread and guarded, because the first
     * inset pass can land before the bridge or the document exists. It is
     * cheap and idempotent, and the listener fires again on rotation, on a
     * keyboard opening, and on the first real layout, so an early no-op
     * always gets a later correction.
     */
    private void publishInsets(int top, int bottom, int left, int right) {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        final String js =
                "(function(){var s=document&&document.documentElement&&document.documentElement.style;"
                        + "if(!s)return;"
                        + "s.setProperty('--shell-content-top','" + top + "px');"
                        + "s.setProperty('--shell-safe-bottom','" + bottom + "px');"
                        + "s.setProperty('--shell-safe-left','" + left + "px');"
                        + "s.setProperty('--shell-safe-right','" + right + "px');"
                        + "})()";
        getBridge().getWebView().post(() -> {
            try {
                getBridge().getWebView().evaluateJavascript(js, null);
            } catch (Exception ignored) {
                // A dead or not-yet-ready WebView is not worth crashing over;
                // the next inset pass will repeat this.
            }
        });
    }

    /** True only for a real absolute web URL. Used to gate in-app navigation. */
    static boolean isWebUrl(Uri uri) {
        if (uri == null) return false;
        final String scheme = uri.getScheme();
        if (scheme == null) return false;
        final String lower = scheme.toLowerCase(java.util.Locale.ROOT);
        if (!lower.equals("http") && !lower.equals("https")) return false;
        final String host = uri.getHost();
        return host != null && !host.isEmpty();
    }
}
