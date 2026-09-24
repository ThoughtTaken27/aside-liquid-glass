/**
 * Page Peek: a live screenshot of one tab (plan 7.3).
 *
 * Frames are fetched with credentials and shown as blob: URLs, so no token
 * appears in the DOM. Story sharing is retired with Telegram support: it
 * needed a server-fetchable URL carrying a credential, which no longer
 * exists. Save fetches the bytes first for the same reason.
 *
 * The capture timestamp is drawn ON screen deliberately: a stale
 * screenshot presented as live is a correctness bug, not a cosmetic one.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Download, RotateCw, Spinner } from './Icons';
import { api } from '../api';
import { downloadBlob, haptic } from '../telegram';
import { relativeTime } from '../utils/time';
import { toast } from './Toasts';
import type { BrowserTab } from '../types';

const MIN_REFRESH_MS = 2_000;

function shotName(tab: BrowserTab): string {
  let host = 'tab';
  try {
    host = new URL(tab.url).hostname.replace(/[^\w.-]+/g, '') || 'tab';
  } catch {
    host = 'tab';
  }
  return `${host}.webp`;
}

export function PagePeek({
  tab,
  onClose,
}: {
  tab: BrowserTab;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [capturedAt, setCapturedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [saving, setSaving] = useState(false);
  const lastRefresh = useRef(0);
  const lastObjectUrl = useRef<string | null>(null);
  const requestId = useRef(0);
  const coolTimer = useRef<number | undefined>(undefined);

  const armCooldown = () => {
    setCooling(true);
    if (coolTimer.current) window.clearTimeout(coolTimer.current);
    coolTimer.current = window.setTimeout(() => setCooling(false), MIN_REFRESH_MS);
  };

  const refresh = () => {
    const now = Date.now();
    // Mirrors the server's own 2s-per-tab floor (`CaptureGate`) so a
    // trigger-happy tap does not just draw a 429 the user has to see.
    // The button is disabled for that window rather than swallowing the
    // tap with no change at all.
    if (now - lastRefresh.current < MIN_REFRESH_MS) return;
    lastRefresh.current = now;
    armCooldown();
    const pending = ++requestId.current;
    setLoading(true);
    setError(null);
    void api
      .captureObjectUrl(tab.targetId)
      .then((url) => {
        // A tab change or newer refresh can finish first. Never let the stale
        // frame replace it, and never leak the stale object URL.
        if (pending !== requestId.current) {
          URL.revokeObjectURL(url);
          return;
        }
        if (lastObjectUrl.current) URL.revokeObjectURL(lastObjectUrl.current);
        lastObjectUrl.current = url;
        setSrc(url);
        setCapturedAt(Date.now());
      })
      .catch(() => {
        if (pending !== requestId.current) return;
        setLoading(false);
        setError('Could not capture this tab right now.');
      });
  };

  useEffect(() => {
    refresh();
    return () => {
      requestId.current += 1;
      if (coolTimer.current) window.clearTimeout(coolTimer.current);
      if (lastObjectUrl.current) URL.revokeObjectURL(lastObjectUrl.current);
      lastObjectUrl.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.targetId]);

  const save = () => {
    if (!src || saving) return;
    setSaving(true);
    haptic('light');
    void fetch(src)
      .then((res) => {
        if (!res.ok) throw new Error('save');
        return res.blob();
      })
      .then((blob) => {
        downloadBlob(blob, shotName(tab));
        haptic('success');
        toast('Screenshot saved', { tone: 'success', duration: 2 });
      })
      .catch(() => {
        haptic('error');
        toast('Couldn’t save that screenshot', { tone: 'error' });
      })
      .finally(() => setSaving(false));
  };
  return (
    <div
      className="app page-peek destination-surface"
      data-surface="destination"
      data-destination="page-peek"
    >
      <header className="thread-header surface-header" data-surface-header>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Back">
          <ChevronLeft size={20} strokeWidth={1.75} />
        </button>
        <span className="thread-titles">
          <span className="thread-title">{tab.title || tab.url}</span>
        </span>
      </header>

      <div
        className="page-peek-body surface-content"
        data-surface-content="preview"
      >
        {error ? <p className="list-empty">{error}</p> : null}
        {loading ? (
          <p className="list-empty">
            <Spinner size={16} />
          </p>
        ) : null}
        {src ? (
          <img
            className={`page-peek-image ${zoomed ? 'is-zoomed' : ''}`}
            src={src}
            alt={tab.title || tab.url}
            decoding="async"
            style={{ touchAction: 'pinch-zoom' }}
            onLoad={() => setLoading(false)}
            onError={() => {
              setLoading(false);
              setError('Could not capture this tab right now.');
            }}
            onDoubleClick={() => setZoomed((prev) => !prev)}
            onContextMenu={(event) => {
              if (!src) event.preventDefault();
            }}
          />
        ) : null}
      </div>

      <footer
        className="page-peek-footer surface-footer"
        data-surface="footer"
      >
        <span
          className="page-peek-timestamp surface-meta"
          data-surface-meta="capture"
        >
          {capturedAt ? `Captured ${relativeTime(capturedAt)}` : ''}
        </span>
        <span className="page-peek-actions" data-surface-group="actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              haptic('light');
              refresh();
            }}
            disabled={loading || cooling}
            aria-label={cooling && !loading ? 'Just refreshed' : 'Refresh'}
          >
            {loading ? <Spinner size={15} /> : <RotateCw size={16} strokeWidth={1.75} />}
          </button>
          {src ? (
            <button
              type="button"
              className="icon-button"
              onClick={save}
              disabled={saving}
              aria-busy={saving}
              aria-label="Save screenshot"
            >
              {saving ? <Spinner size={15} /> : <Download size={16} strokeWidth={1.75} />}
            </button>
          ) : null}
        </span>
      </footer>
    </div>
  );
}
