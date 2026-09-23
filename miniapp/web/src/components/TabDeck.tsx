/**
 * The Tab Deck: every open tab on the Mac, from the phone (plan 7.2).
 *
 * Nobody else in the category shows you the browser at all -- Claude Code,
 * Codex, Jules, Devin, OpenHands all top out at a diff. This is the
 * capability the whole Day 3 plan leads with, so it stays close to what it
 * actually is: a live list of `listBrowserTabs()`, grouped by window
 * because that call already hands back `windowId` for free.
 */
import { useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import { PagePeek } from './PagePeek';
import { ArrowUp, Globe, Spinner, X } from './Icons';
import { api } from '../api';
import { haptic, showConfirm } from '../telegram';
import type { BrowserTab } from '../types';

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Whether two polls describe the same browser.
 *
 * Compares only the fields this list actually draws. Deliberately not a
 * deep equality: `listBrowserTabs()` returns fields that churn without
 * being visible here, and treating those as changes would defeat the point.
 */
function sameTabs(a: BrowserTab[] | null, b: BrowserTab[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((tab, index) => {
    const other = b[index];
    return (
      tab.targetId === other.targetId &&
      tab.title === other.title &&
      tab.url === other.url &&
      tab.active === other.active &&
      tab.windowId === other.windowId &&
      tab.faviconUrl === other.faviconUrl
    );
  });
}

export function TabDeck({ onClose }: { onClose: () => void }) {
  const [tabs, setTabs] = useState<BrowserTab[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [opening, setOpening] = useState(false);
  const [peeking, setPeeking] = useState<BrowserTab | null>(null);

  const load = () => {
    api.tabs().then(
      (res) => {
        // Keep the previous array when nothing actually changed. At a
        // 1.5s poll a fresh array every time would re-render every row
        // (and re-request every favicon) roughly forty times a minute
        // while the user stares at an unchanged list.
        setTabs((prev) => (sameTabs(prev, res.tabs) ? prev : res.tabs));
        setError(null);
      },
      (err) => setError((err as Error).message),
    );
  };

  /**
   * Live, for real.
   *
   * This used to be `useEffect(load, [])` -- one fetch when the sheet
   * opened and then a frozen snapshot for as long as you looked at it. Open
   * a tab on the Mac and the phone kept showing the old list, which is
   * worse than not having the feature: a stale list of tabs looks exactly
   * like a current one.
   *
   * 1.5s, and the interval is not arbitrary. `listTabs` on the server sits
   * behind a 2s TTL cache (browser.ts), so polling faster than that just
   * re-reads the same cached value and spends battery; polling much slower
   * makes opening a tab on the Mac feel like it did not register. Slightly
   * under the TTL keeps the phone within one cache generation of the truth.
   *
   * `setInterval` rather than a self-scheduling timeout because `load` is
   * fire-and-forget: an in-flight request that outlives its slot is
   * harmless (the state setter is idempotent), and a chained timeout would
   * stall the whole loop on one slow response.
   *
   * Paused while the tab is backgrounded -- a phone in a pocket polling a
   * laptop twice a second is pure drain, and the visibility change fires an
   * immediate refresh so coming back is instant rather than up-to-1.5s
   * stale.
   */
  useEffect(() => {
    load();

    let timer: number | undefined;
    const start = () => {
      if (timer === undefined) timer = window.setInterval(load, 1_500);
    };
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        load();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openUrl = async () => {
    const raw = urlInput.trim();
    if (!raw) return;
    // A bare phrase like "espn" is not a URL -- the paste-and-go field is
    // for going somewhere specific, not for searching, so it gets an
    // https:// prefix rather than silently failing `new URL()` server-side.
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    haptic('light');
    setOpening(true);
    try {
      await api.openTab(withScheme);
      setUrlInput('');
      haptic('success');
      load();
    } catch {
      haptic('error');
    } finally {
      setOpening(false);
    }
  };

  const closeTab = async (tab: BrowserTab) => {
    const ok = await showConfirm(`Close "${tab.title || hostname(tab.url)}"?`);
    if (!ok) return;
    haptic('medium');
    setTabs((prev) => prev?.filter((t) => t.targetId !== tab.targetId) ?? null);
    try {
      await api.closeTab(tab.targetId);
    } catch {
      load(); // put the truth back if the close didn't actually happen
    }
  };

  if (peeking) {
    return (
      <PagePeek
        tab={peeking}
        onClose={() => setPeeking(null)}
      />
    );
  }

  const groups = new Map<number, BrowserTab[]>();
  for (const tab of tabs ?? []) {
    const list = groups.get(tab.windowId) ?? [];
    list.push(tab);
    groups.set(tab.windowId, list);
  }

  return (
    <Sheet side="bottom" title="Browser" subtitle="Open tabs on your Mac" onClose={onClose}>
      <form
        className="tab-deck-go surface-group"
        data-surface-group="open-url"
        onSubmit={(event) => {
          event.preventDefault();
          void openUrl();
        }}
      >
        <input
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          placeholder="Open a URL"
          aria-label="Open a URL"
          inputMode="url"
          enterKeyHint="go"
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button type="submit" disabled={opening || !urlInput.trim()} aria-label="Open">
          {opening ? <Spinner size={14} /> : <ArrowUp size={16} />}
        </button>
      </form>

      {/*
        An error only replaces the list when there is no list. A poll that
        fails once -- the laptop lid dipping, the tunnel reconnecting --
        must not blank out tabs that were correct a second ago.
      */}
      {error && !tabs ? <p className="list-empty">{error}</p> : null}
      {!tabs && !error ? (
        <p className="list-empty">
          <Spinner size={14} /> Loading…
        </p>
      ) : null}
      {tabs && tabs.length === 0 ? <p className="list-empty">No open tabs.</p> : null}

      {[...groups.entries()].map(([windowId, list]) => (
        <section
          className="tab-deck-window surface-section"
          data-surface-section="window"
          data-window-id={windowId}
          key={windowId}
        >
          <h3 className="tab-deck-window-head" data-surface-heading>
            Window
          </h3>
          {list.map((tab) => (
            <div
              className="tab-deck-row surface-row"
              data-surface-row="tab"
              data-active={tab.active ? 'true' : undefined}
              key={tab.targetId}
            >
              <button
                type="button"
                className="tab-deck-row-main"
                onClick={() => {
                  haptic('light');
                  setPeeking(tab);
                }}
              >
                {tab.faviconUrl ? (
                  <img
                    className="tab-deck-favicon"
                    src={tab.faviconUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <Globe size={14} strokeWidth={1.75} />
                )}
                <span className="tab-deck-titles">
                  <span className="tab-deck-title">{tab.title || hostname(tab.url)}</span>
                  <span
                    className="tab-deck-host surface-meta"
                    data-surface-meta="host"
                  >
                    {hostname(tab.url)}
                  </span>
                </span>
                {tab.active ? (
                  <span
                    className="tab-deck-active surface-meta"
                    data-surface-meta="state"
                  >
                    Active
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Close "${tab.title || hostname(tab.url)}"`}
                onClick={() => void closeTab(tab)}
              >
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </section>
      ))}
    </Sheet>
  );
}
