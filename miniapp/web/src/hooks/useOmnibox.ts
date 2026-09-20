/**
 * Address-bar behaviour, detached from the panel that used to own it.
 *
 * All of this lived inside `SearchPanel`, which owned its own input, its own
 * query state and its own screen. Search is now a mode of the composer
 * rather than a place you travel to, so the input belongs to the composer
 * and the query lives one level up. What is left here is the part that was
 * never about layout: debounced suggestions, a stale-response guard, and the
 * rules for turning a line of text into a destination.
 *
 * Handing off to a real browser rather than rendering results is the
 * long-standing decision this preserves. Chrome on the phone is signed in
 * and this app is not, google.com refuses to be framed except through a
 * parameter that is served signed out, and Google blocks account sign-in
 * from WebView user agents outright. A Custom Tab is the browser, so it
 * wins on every axis a reimplementation could compete on.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { OmniboxItem } from '../types';
import { openUrl, asUrl, prefetch } from '../utils/openUrl';

/**
 * Debounce for the typeahead.
 *
 * Short on purpose: this races a local history read, not just a network
 * call, so the list is usually ready before the next keystroke lands.
 */
const SUGGEST_DEBOUNCE_MS = 120;

export function googleUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export interface Omnibox {
  items: OmniboxItem[];
  /** Commit a raw line of text: a URL if it parses as one, else a search. */
  runQuery: (text: string) => void;
  /** Commit a suggestion row. */
  pick: (item: OmniboxItem) => void;
  /** Drop the current suggestions, e.g. when leaving search mode. */
  clear: () => void;
}

/**
 * @param query  Live text from the composer.
 * @param active Whether search mode is on. Suggestions are not fetched while
 *               it is off, so switching back to chat stops the typeahead
 *               rather than quietly polling behind the thread.
 * @param onCommit Called after a destination has been handed to the browser.
 *               The composer uses it to clear itself.
 */
export function useOmnibox(
  query: string,
  active: boolean,
  onCommit?: () => void,
): Omnibox {
  const [items, setItems] = useState<OmniboxItem[]>([]);

  /*
   * Stale-response guard. The same incrementing-counter pattern the rest of
   * this codebase uses (`useThread`, `useAttachments`): a slower earlier
   * request must not overwrite a faster later one, which on a typeahead
   * shows up as the list flickering back to a previous prefix.
   */
  const seq = useRef(0);

  useEffect(() => {
    if (!active) return;
    const mine = ++seq.current;
    const ac = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.omnibox(query, ac.signal);
        if (mine !== seq.current) return;
        setItems(res.items);
        /*
         * Tell Chrome where this is probably going.
         *
         * `mayLaunchUrl` lets it resolve DNS, open the socket and begin
         * fetching before the tap happens, which is most of the visible
         * latency in opening a Custom Tab. A hint with no contract: wrong
         * guesses cost a speculative request Chrome was willing to make,
         * right guesses make the tab feel instant. No-op off the shell.
         */
        const q = query.trim();
        if (q) prefetch(asUrl(q) ?? googleUrl(q));
      } catch {
        // A failed typeahead is not worth a visible error: the previous
        // list stays, and the next keystroke tries again.
      }
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [query, active]);

  const clear = useCallback(() => {
    // Bump the guard too, or a request already in flight repopulates the
    // list a moment after it was emptied.
    seq.current += 1;
    setItems([]);
  }, []);

  const open = useCallback(
    (url: string, label: string, kind: 'search' | 'page') => {
      // Recorded so the address bar on either device can see it. Fire and
      // forget: a navigation the owner already committed to should not wait
      // on a bookkeeping write.
      void api.recordVisit({ kind, title: label, url });

      /*
       * One action, one destination.
       *
       * This briefly routed searches through ACTION_WEB_SEARCH to reach the
       * Google app, which removes the address bar. It also removed the
       * search: most handlers of that intent open their search UI with the
       * query pre-filled and *unsubmitted*, so the query had to be
       * confirmed a second time in another app. Trading one tap for a
       * cleaner header is a bad trade, and trading it silently is worse.
       *
       * A URL loads results. That is the whole reason to prefer it.
       */
      void openUrl(url);
      onCommit?.();
    },
    [onCommit],
  );

  const runQuery = useCallback(
    (text: string) => {
      const q = text.trim();
      if (!q) return;
      // A typed destination is a destination. Only text that parses
      // strictly as one counts, so "node.js streams" stays a search.
      const direct = asUrl(q);
      if (direct) {
        open(direct, hostOf(direct) || direct, 'page');
        return;
      }
      open(googleUrl(q), q, 'search');
    },
    [open],
  );

  const pick = useCallback(
    (item: OmniboxItem) => {
      if (item.kind === 'search') {
        runQuery(item.text);
        return;
      }
      if (item.kind === 'url') {
        open(item.url, hostOf(item.url) || item.text, 'page');
        return;
      }
      open(item.url, item.title || item.domain, 'page');
    },
    [open, runQuery],
  );

  return { items, runQuery, pick, clear };
}
