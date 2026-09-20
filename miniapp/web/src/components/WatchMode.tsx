/**
 * Watch Mode: while a turn that has touched the browser is running, a
 * pinned card refreshes the active tab's screenshot on an interval (plan
 * 7.4). This is the headline demo -- the first implementation that
 * actually shows the supervisor anything, not just a diff.
 *
 * The keyword heuristic for "did this turn touch the browser" mirrors
 * `BROWSER_TOOL_HINTS` in `server/src/app.ts` exactly, so the client and
 * the server's own completion-thumbnail decision (plan 7.5) agree about
 * what counts.
 *
 * ONE capture per tick, rendered from the JSON response's base64.
 *
 * That is load-bearing. The first cut called `api.captureTab()` and THEN
 * pointed the `<img>` at the raw capture route, which is a second capture
 * through `CaptureGate`. So every tick fired two captures back to back,
 * the second one landed inside the gate's own 2s per-tab floor, and it
 * came back 429. Holding ~25-35KB of base64 in memory for one frame is the
 * cheaper half of that trade by a wide margin. `PagePeek` fetches the raw
 * route with credentials into a blob URL instead.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { cloudStorage } from '../telegram';
import type { ThreadItem } from '../types';

const BROWSER_TOOL_HINTS = [
  'browser',
  'tab',
  'snapshot',
  'screenshot',
  'navigate',
  'click',
  'scroll',
  'openurl',
  'open_tab',
];

function touchedBrowser(items: ThreadItem[]): boolean {
  for (const item of items) {
    if (item.kind !== 'work') continue;
    for (const workItem of item.items) {
      if (workItem.kind !== 'step') continue;
      const tool = workItem.tool.toLowerCase();
      if (BROWSER_TOOL_HINTS.some((hint) => tool.includes(hint))) return true;
    }
  }
  return false;
}

const MAX_CAPTURES_PER_TURN = 100;

export function WatchModeCard({
  sessionId,
  busy,
  items,
}: {
  sessionId: string;
  busy: boolean;
  items: ThreadItem[];
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const captureCount = useRef(0);
  const intervalMs = useRef(3_000);
  const lastUrl = useRef('');
  const wasBusy = useRef(false);
  const timer = useRef<number | null>(null);

  const active = busy && touchedBrowser(items);

  useEffect(() => {
    cloudStorage.getItem(`watchMode.collapsed.${sessionId}`).then((value) => {
      if (value === '1') setCollapsed(true);
    });
  }, [sessionId]);

  // A new turn starting resets the per-turn capture ceiling and the
  // backoff clock -- this is a NEW turn's browsing, not a continuation of
  // the last one's.
  useEffect(() => {
    if (busy && !wasBusy.current) {
      captureCount.current = 0;
      intervalMs.current = 3_000;
      lastUrl.current = '';
    }
    wasBusy.current = busy;
  }, [busy]);

  useEffect(() => {
    if (!active || collapsed) {
      if (timer.current) window.clearTimeout(timer.current);
      return undefined;
    }

    let cancelled = false;
    let sinceUrlChange = 0;

    const tick = async () => {
      if (cancelled) return;
      if (captureCount.current >= MAX_CAPTURES_PER_TURN) return; // manual refresh only past here
      try {
        const tabs = await api.tabs();
        const target = tabs.tabs.find((t) => t.active) || tabs.tabs[0];
        if (target && !cancelled) {
          const result = await api.captureTab(target.targetId, 55);
          if (cancelled) return;
          captureCount.current += 1;
          setSrc(result.dataUrl);
          setUrl(result.url);
          if (result.url === lastUrl.current) {
            sinceUrlChange += intervalMs.current;
            // Back off to 6s then 10s after 60s with no navigation change.
            if (sinceUrlChange > 60_000) intervalMs.current = 10_000;
            else if (sinceUrlChange > 30_000) intervalMs.current = 6_000;
          } else {
            lastUrl.current = result.url;
            sinceUrlChange = 0;
            intervalMs.current = 3_000;
          }
        }
      } catch {
        // A 429/409 from the capture gate, or no tabs -- just try again
        // next tick rather than surfacing an error on a card that is
        // inherently best-effort.
      }
      if (!cancelled) {
        timer.current = window.setTimeout(tick, intervalMs.current);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [active, collapsed]);

  // Foreground-only: stop the moment the tab/app is backgrounded, resume
  // (via the effect above re-running on next render) is not attempted --
  // simplest correct behaviour, matching "foreground only" from the plan.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && timer.current) window.clearTimeout(timer.current);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  if (!active) return null;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    void cloudStorage.setItem(`watchMode.collapsed.${sessionId}`, next ? '1' : '0');
  };

  return (
    <div
      className={`watch-mode-card utility-card ${collapsed ? 'is-collapsed' : ''}`}
      data-card-group="utility"
      data-card-kind="watch"
      data-card-state={collapsed ? 'collapsed' : 'expanded'}
    >
      <button type="button" className="watch-mode-head" onClick={toggle}>
        <span className="watch-mode-live" aria-hidden />
        <span>Watching the browser</span>
        <span className="watch-mode-toggle">{collapsed ? 'Show' : 'Hide'}</span>
      </button>
      {!collapsed ? (
        <>
          {src ? <img className="watch-mode-image" src={src} alt="Live browser capture" decoding="async" /> : null}
          {url ? <span className="watch-mode-url">{url}</span> : null}
        </>
      ) : null}
    </div>
  );
}
