package app.aside.mobile;

import android.content.Intent;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoWebExecutor;
import org.mozilla.geckoview.GeckoRuntimeSettings;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoView;

/**
 * The browser, inside the app.
 *
 * Every earlier version of this handed the search off to something else. A
 * Custom Tab is real Chrome with the real signed-in session, but it is a
 * different activity with its own toolbar, and no configuration removes
 * that toolbar: showing the origin is the point of its security model.
 * ACTION_WEB_SEARCH reaches the Google app, which has no toolbar, but most
 * handlers of that intent open their search UI with the query pre-filled
 * and unsubmitted, so it costs an extra confirmation in another app.
 *
 * Both were app switches. This is not.
 *
 * The reason this can be a plain view in our own window is that it is not
 * Android's WebView. The system WebView adds an `X-Requested-With` header
 * naming the host app to every request, Google reads it, and refuses to
 * sign in behind it. That header cannot be turned off; the opt-out was
 * removed in 2025. Google also fingerprints the JS environment and the TLS
 * handshake, so spoofing the user agent does not help either.
 *
 * GeckoView is Firefox's engine shipped as an embeddable View. It sends
 * none of those signals, because it is not pretending: it is a real
 * browser. Google treats it as one, so the account works, the page is the
 * ordinary mobile result page, and it renders in a window we own with
 * nothing drawn above it.
 *
 * The trade is size. Gecko's native libraries are why the APK goes from
 * ~8 MB to ~90 MB.
 */
public class BrowserActivity extends AppCompatActivity {

    /** URL to open. */
    public static final String EXTRA_URL = "app.aside.mobile.extra.URL";

    /**
     * One engine for the whole process.
     *
     * `GeckoRuntime` starts Gecko's content processes, and only one may
     * exist per application. Holding it statically means the second search
     * of a session reuses a warm engine instead of paying the cold start
     * again, which is the difference between a browser that appears
     * instantly and one that visibly boots.
     */
    private static GeckoRuntime runtime;

    /**
     * One session, kept warm between searches.
     *
     * A `GeckoSession` owns a content process. Creating one per visit meant
     * every search paid for process startup, a fresh network stack and an
     * empty cache. Holding a single session across activity instances turns
     * the second and every later search into an ordinary navigation in an
     * already-running tab, which is what makes it feel instant.
     *
     * The activity therefore attaches and detaches it (`setSession` /
     * `releaseSession`) rather than opening and closing it.
     */
    private static GeckoSession warmSession;

    /** Used only for speculative DNS and connections. */
    private static GeckoWebExecutor executor;

    private GeckoSession session;
    private GeckoView view;
    /** Tracks whether there is history to go back through. */
    private boolean canGoBack = false;

    static GeckoRuntime runtime(final android.content.Context context) {
        if (runtime == null) {
            final GeckoRuntimeSettings settings = new GeckoRuntimeSettings.Builder()
                    /*
                     * Gecko's own remote debugging, off. Nothing in this app
                     * needs it and it opens a local socket.
                     */
                    .remoteDebuggingEnabled(false)
                    /*
                     * Let pages honour the system dark/light setting rather
                     * than forcing one, so Google looks the way it does in
                     * any other browser on the phone.
                     */
                    .aboutConfigEnabled(false)
                    /*
                     * Pre-fork the content process from Android's app
                     * zygote. Gecko renders pages in a separate process,
                     * and spawning one cold is the single largest fixed
                     * cost in showing the first page. The zygote makes
                     * that a fork of an already-initialised image.
                     */
                    .appZygoteProcessEnabled(true)
                    .build();
            runtime = GeckoRuntime.create(context.getApplicationContext(), settings);
        }
        return runtime;
    }

    /**
     * Warm the engine without showing anything.
     *
     * Called from the launcher activity at startup. Creating the runtime is
     * the expensive part of the first navigation, so doing it while the
     * owner is still reading the home screen removes it from the critical
     * path of the first search.
     */
    static void prewarm(final android.content.Context context) {
        try {
            final GeckoRuntime rt = runtime(context);
            // Opening the session here is what moves content-process
            // startup off the critical path of the first search.
            session(rt);
            if (executor == null) executor = new GeckoWebExecutor(rt);
        } catch (Throwable ignored) {
            // A device that cannot start Gecko still gets a working app;
            // the failure surfaces when a search is actually run.
        }
    }

    private static GeckoSession session(final GeckoRuntime rt) {
        if (warmSession == null) {
            warmSession = new GeckoSession();
        }
        if (!warmSession.isOpen()) {
            warmSession.open(rt);
        }
        return warmSession;
    }

    /**
     * Resolve and connect ahead of the tap.
     *
     * Called from the address bar as the owner types. By the time a row is
     * chosen, DNS is resolved and the TLS handshake is usually already
     * done, so the navigation starts at the request rather than at the
     * socket. Entirely best-effort; a wrong guess costs one idle connection.
     */
    static void speculate(final String url) {
        final GeckoWebExecutor ex = executor;
        if (ex == null || url == null || url.isEmpty()) return;
        try {
            ex.speculativeConnect(url);
        } catch (Throwable ignored) {
            // A hint that cannot be given is not a failure worth reporting.
        }
    }

    @Override
    protected void onCreate(final Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Draw edge to edge, then pad for the status bar only. The page
        // itself should reach the bottom of the screen.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        final WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(true);
        controller.setAppearanceLightNavigationBars(true);

        final FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFFFFFFFF);
        view = new GeckoView(this);
        root.addView(view, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            final androidx.core.graphics.Insets bars =
                    insets.getInsets(WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });

        final GeckoRuntime rt;
        try {
            rt = runtime(this);
        } catch (Throwable t) {
            /*
             * Gecko could not start: wrong ABI, out of memory, a corrupt
             * install. Showing an empty white activity would be the worst
             * possible answer, so hand the URL to the system browser and
             * get out of the way. The owner loses the in-app framing for
             * this one navigation and keeps a working search.
             */
            fallbackToBrowser();
            return;
        }

        session = session(rt);

        /*
         * Back has to mean "back in the page" before it means "leave the
         * browser", or a search that led three links deep would need the
         * whole journey retraced by reopening the panel.
         */
        session.setNavigationDelegate(new GeckoSession.NavigationDelegate() {
            @Override
            public void onCanGoBack(final GeckoSession s, final boolean value) {
                canGoBack = value;
            }
        });

        view.setSession(session);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (canGoBack) {
                    session.goBack();
                    return;
                }
                finish();
            }
        });

        load(getIntent());
    }

    /**
     * A second search while this screen is already up.
     *
     * The activity is singleTop, so rather than stacking another copy the
     * existing one is handed the new URL. Without this the back stack would
     * grow a screen per search.
     */
    @Override
    protected void onNewIntent(final Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        load(intent);
    }

    private void load(final Intent intent) {
        if (intent == null || session == null) return;
        final String url = intent.getStringExtra(EXTRA_URL);
        if (url == null || url.isEmpty()) return;
        /*
         * Defence in depth. This activity is not exported and the only
         * caller today is MainActivity, which already checks. Re-checking
         * here means a future caller cannot turn this into a `file:` or
         * `javascript:` loader by passing a different extra.
         */
        if (!MainActivity.isWebUrl(android.net.Uri.parse(url))) {
            finish();
            return;
        }
        /*
         * Each search from the address bar is a fresh trip.
         *
         * The session is reused for speed, which means it still holds the
         * history of the last search. Without this, backing out of a
         * search for "anthropic" would walk into last week's results for
         * something else instead of returning to the app.
         */
        session.purgeHistory();
        canGoBack = false;
        session.loadUri(url);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Tell Gecko this content is on screen so it is scheduled as
        // foreground work rather than throttled.
        if (session != null) session.setActive(true);
    }

    @Override
    protected void onPause() {
        // Backgrounded content should not keep timers and animations
        // running at full rate behind the app.
        if (session != null) session.setActive(false);
        super.onPause();
    }

    /**
     * Last resort when the embedded engine is unavailable.
     *
     * Deliberately an ACTION_VIEW rather than a Custom Tab: if Gecko failed
     * to start, the cheapest and most certain thing on the device is
     * whatever browser the owner already uses.
     */
    private void fallbackToBrowser() {
        final String url = getIntent() != null
                ? getIntent().getStringExtra(EXTRA_URL) : null;
        if (url != null && !url.isEmpty()) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)));
            } catch (Exception ignored) {
                // No browser at all. Nothing further to try.
            }
        }
        finish();
    }

    @Override
    protected void onDestroy() {
        if (view != null) {
            /*
             * Detach, do not close.
             *
             * `close()` would tear down the content process this screen
             * just finished warming, so the next search would pay for it
             * all over again. Releasing hands the session back while
             * leaving it running.
             */
            view.releaseSession();
        }
        session = null;
        super.onDestroy();
    }
}
