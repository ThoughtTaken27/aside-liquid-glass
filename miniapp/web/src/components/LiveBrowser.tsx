/**
 * The agent's browser tab, live, pinned to the top of a chat.
 *
 * Replaces Watch Mode, which screenshotted whatever tab was focused on the
 * Mac every few seconds. This follows the tab the chat's agent (or its
 * running subagent) is actually driving, streamed as changed frames only.
 *
 * Visibility rules:
 *  - Hidden entirely unless the agent has a real, open tab.
 *  - Expanded while a turn runs, a slim bar otherwise; a manual choice
 *    sticks per chat.
 *  - Frames are requested only while the picture can be seen: expanded,
 *    on screen, app in the foreground. Collapsed or scrolled away costs
 *    the Mac nothing.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Globe, Maximize2, X } from 'lucide-react';
import { LiveSocket, hostOf, liveKey, type LiveMeta, type LiveQuality, type LiveTarget } from '../liveview';
import { cloudStorage } from '../telegram';

interface Frame {
  url: string;
  width: number;
  height: number;
  at: number;
}

/** No frame for this long while streaming reads as "still", not "live". */
const STILL_AFTER_MS = 4_000;

function useFrames() {
  const [frame, setFrame] = useState<Frame | null>(null);
  const current = useRef<string | null>(null);
  const decoding = useRef(false);
  const queued = useRef<Blob | null>(null);

  const push = useCallback((blob: Blob) => {
    // Decode off-screen and swap only a fully decoded image, so a frame
    // never paints half-loaded. While one decodes, keep only the newest.
    if (decoding.current) {
      queued.current = blob;
      return;
    }
    decoding.current = true;
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    const done = (ok: boolean) => {
      decoding.current = false;
      if (ok) {
        const previous = current.current;
        current.current = url;
        setFrame({ url, width: img.naturalWidth || 16, height: img.naturalHeight || 10, at: Date.now() });
        if (previous) window.setTimeout(() => URL.revokeObjectURL(previous), 1_000);
      } else {
        URL.revokeObjectURL(url);
      }
      const next = queued.current;
      queued.current = null;
      if (next) push(next);
    };
    const decode = typeof img.decode === 'function' ? img.decode() : Promise.resolve();
    decode.then(() => done(true), () => done(false));
  }, []);

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );

  return { frame, push };
}

export type BadgeMode = 'live' | 'still' | 'connecting' | 'reconnecting';

/**
 * One live stream: meta, the newest decoded frame, and the badge state.
 * `stream` and `quality` may change freely; the socket follows.
 */
export function useLiveStream(target: LiveTarget, stream: boolean, quality: LiveQuality) {
  const [meta, setMeta] = useState<LiveMeta | null>(null);
  const [connected, setConnected] = useState(false);
  const [, tick] = useState(0);
  const { frame, push } = useFrames();
  const socket = useRef<LiveSocket | null>(null);
  const key = liveKey(target);

  useEffect(() => {
    setMeta(null);
    const live = new LiveSocket(target, { onMeta: setMeta, onFrame: push, onConnection: setConnected });
    socket.current = live;
    live.start();
    return () => {
      live.close();
      socket.current = null;
    };
    // `key` is the identity of `target`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, push]);

  useEffect(() => {
    socket.current?.setStream(stream, quality);
  }, [stream, quality, key]);

  // Re-evaluate "live" vs "still" between frames.
  useEffect(() => {
    if (!stream) return undefined;
    const id = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, [stream]);

  const badge: BadgeMode = !connected
    ? 'reconnecting'
    : !frame
      ? 'connecting'
      : Date.now() - frame.at > STILL_AFTER_MS
        ? 'still'
        : 'live';
  return { meta, frame, connected, badge };
}

export function Favicon({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <Globe size={14} aria-hidden />;
  return <img src={src} alt="" width={16} height={16} onError={() => setBroken(true)} />;
}

export function LiveBadge({ mode }: { mode: BadgeMode }) {
  const label =
    mode === 'live' ? 'Live' : mode === 'still' ? 'Live' : mode === 'connecting' ? 'Connecting' : 'Reconnecting';
  return (
    <span className={`live-badge is-${mode}`} role="status" aria-live="polite">
      <span className="live-badge-dot" aria-hidden />
      {label}
    </span>
  );
}

export function LiveBrowserCard({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [onScreen, setOnScreen] = useState(true);
  const [hasTabHint, setHasTabHint] = useState(false);
  const card = useRef<HTMLDivElement | null>(null);
  const storageKey = `liveView.expanded.${sessionId}`;

  useEffect(() => {
    setChoice(null);
    let alive = true;
    void cloudStorage.getItem(storageKey).then((value) => {
      if (!alive) return;
      if (value === '1') setChoice(true);
      else if (value === '0') setChoice(false);
    });
    return () => {
      alive = false;
    };
  }, [storageKey]);

  const expanded = choice ?? busy;
  const streaming = hasTabHint && (fullscreen || (expanded && onScreen));
  const { meta, frame, badge } = useLiveStream({ sessionId }, streaming, fullscreen ? 'full' : 'card');
  const hasTab = Boolean(meta?.tab) && (meta?.state === 'live' || meta?.state === 'ready');
  useEffect(() => setHasTabHint(hasTab), [hasTab]);

  // Only stream what can be seen.
  useEffect(() => {
    const el = card.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => setOnScreen(entries.some((entry) => entry.isIntersecting)),
      { threshold: 0.05 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasTab]);

  if (!hasTab || !meta?.tab) return null;
  const tab = meta.tab;
  const host = hostOf(tab.url);
  const title = tab.title || host || 'Agent tab';
  const who = tab.owner === 'subagent' ? 'Subagent' : 'Agent';

  const toggle = () => {
    const next = !expanded;
    setChoice(next);
    void cloudStorage.setItem(storageKey, next ? '1' : '0');
  };

  return (
    <>
      <div
        ref={card}
        className={`live-view ${expanded ? 'is-expanded' : 'is-collapsed'}`}
        data-card-kind="live-view"
      >
        <button
          type="button"
          className="live-view-head"
          onClick={toggle}
          aria-expanded={expanded}
          aria-label={`${who}'s tab: ${title}. ${expanded ? 'Hide' : 'Show'} live view`}
        >
          <span className="live-view-favicon">
            <Favicon src={tab.faviconUrl} />
          </span>
          <span className="live-view-titles">
            <span className="live-view-title">{title}</span>
            <span className="live-view-host">
              {who} tab · {host}
            </span>
          </span>
          {streaming ? <LiveBadge mode={badge} /> : null}
          <ChevronDown className="live-view-chevron" size={16} aria-hidden />
        </button>
        {expanded ? (
          <button
            type="button"
            className="live-view-stage"
            style={{ aspectRatio: frame ? `${frame.width} / ${frame.height}` : '16 / 10' }}
            onClick={() => setFullscreen(true)}
            aria-label="Open live view full screen"
          >
            {frame ? (
              <img className="live-view-frame" src={frame.url} alt={`Live view of ${title}`} draggable={false} />
            ) : (
              <span className="live-view-wait">
                <span className="live-view-shimmer" aria-hidden />
                <span className="live-view-wait-text">Connecting to the agent's tab…</span>
              </span>
            )}
            {frame ? (
              <span className="live-view-expand" aria-hidden>
                <Maximize2 size={14} />
              </span>
            ) : null}
          </button>
        ) : null}
      </div>
      {fullscreen ? (
        <LiveFullscreen
          title={title}
          host={host}
          who={who}
          favicon={tab.faviconUrl}
          frame={frame}
          badge={badge}
          onClose={() => setFullscreen(false)}
        />
      ) : null}
    </>
  );
}

export function LiveFullscreen({
  title,
  host,
  who,
  favicon,
  frame,
  badge,
  onClose,
  actions,
  note = 'Read-only view of the tab on your Mac. Updates as the agent works.',
  gone = false,
}: {
  title: string;
  host: string;
  who: string;
  favicon: string;
  frame: Frame | null;
  badge: BadgeMode;
  onClose: () => void;
  actions?: ReactNode;
  note?: string;
  /** The tab closed while being watched. */
  gone?: boolean;
}) {
  const close = useRef<HTMLButtonElement | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    // The Android back gesture should close the viewer, not leave the app.
    // The history entry is pushed a tick late: React's development
    // double-mount runs cleanup synchronously, and an entry pushed and
    // popped in the same tick would deliver a late popstate to the
    // remounted viewer and close it the instant it opened.
    let pushed = false;
    const push = window.setTimeout(() => {
      history.pushState({ liveView: true }, '');
      pushed = true;
    }, 0);
    const onPop = () => closeRef.current();
    window.addEventListener('keydown', onKey);
    window.addEventListener('popstate', onPop);
    return () => {
      window.clearTimeout(push);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      if (pushed && (history.state as { liveView?: boolean } | null)?.liveView) history.back();
    };
  }, []);

  return createPortal(
    <div className="live-full" role="dialog" aria-modal="true" aria-label={`Live view of ${title}`}>
      <div className="live-full-bar">
        <span className="live-view-favicon">
          <Favicon src={favicon} />
        </span>
        <span className="live-view-titles">
          <span className="live-view-title">{title}</span>
          <span className="live-view-host">{who ? `${who} tab · ${host}` : host}</span>
        </span>
        {gone ? null : <LiveBadge mode={badge} />}
        <button ref={close} type="button" className="live-full-close" onClick={onClose} aria-label="Close live view">
          <X size={18} />
        </button>
      </div>
      <div
        className={`live-full-stage ${zoomed ? 'is-zoomed' : ''}`}
        onClick={() => (zoomed ? setZoomed(false) : onClose())}
      >
        {gone ? (
          <span className="live-view-wait-text">This tab was closed on your Mac.</span>
        ) : frame ? (
          <img
            className="live-full-frame"
            src={frame.url}
            alt={`Live view of ${title}`}
            draggable={false}
            onClick={(event) => {
              event.stopPropagation();
              setZoomed((z) => !z);
            }}
          />
        ) : (
          <span className="live-view-wait-text">Connecting to the agent's tab…</span>
        )}
      </div>
      {actions ? <div className="live-full-actions">{actions}</div> : null}
      <p className="live-full-note">{frame && !gone ? `${zoomed ? 'Tap to fit' : 'Tap to zoom'} · ${note}` : note}</p>
    </div>,
    document.body,
  );
}
