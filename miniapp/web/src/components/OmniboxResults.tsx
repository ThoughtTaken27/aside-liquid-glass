/**
 * Suggestion rows, rendered directly above the composer.
 *
 * These moved out of `SearchPanel` unchanged. What changed is where they
 * sit: search used to be a second page you swiped to, with its own address
 * bar at the top of it, so the list hung below that bar and filled the
 * screen. Search is now a mode of the composer, so the list grows upward
 * out of the field you are already typing in and the thumb never travels.
 *
 * Rows stay full-width buttons with generous height for the same reason
 * they always did: this is a one-handed surface and the target is a moving
 * thumb, not a cursor.
 */
import type { OmniboxItem } from '../types';
import { Clock, Globe, Search } from './Icons';

function timeAgo(ms: number): string {
  const secs = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.round(days / 7)}w ago`;
}

function SourceMark({ domain }: { domain: string }) {
  // A remote favicon service turns private browsing history into requests
  // to that service. Keep the same mark geometry and render locally.
  return (
    <span className="omni-mark omni-mark-fallback" aria-hidden>
      {(domain || '?').charAt(0).toUpperCase()}
    </span>
  );
}

function OmniRow({
  item,
  onPick,
}: {
  item: OmniboxItem;
  onPick: (item: OmniboxItem) => void;
}) {
  if (item.kind === 'search') {
    return (
      <button type="button" className="omni-row" onClick={() => onPick(item)}>
        <span className="omni-glyph" aria-hidden>
          {item.source === 'history' ? (
            <Clock size={15} strokeWidth={2} />
          ) : (
            <Search size={15} strokeWidth={2} />
          )}
        </span>
        <span className="omni-text">
          <span className="omni-primary">{item.text}</span>
        </span>
      </button>
    );
  }

  if (item.kind === 'url') {
    return (
      <button type="button" className="omni-row" onClick={() => onPick(item)}>
        <span className="omni-glyph" aria-hidden>
          <Globe size={15} strokeWidth={2} />
        </span>
        <span className="omni-text">
          <span className="omni-primary">{item.text}</span>
          <span className="omni-secondary">Go to site</span>
        </span>
      </button>
    );
  }

  return (
    <button type="button" className="omni-row" onClick={() => onPick(item)}>
      <SourceMark domain={item.domain} />
      <span className="omni-text">
        <span className="omni-primary">{item.title}</span>
        <span className="omni-secondary">
          {item.domain}
          {item.lastVisit ? ` · ${timeAgo(item.lastVisit)}` : ''}
        </span>
      </span>
    </button>
  );
}

export function OmniboxResults({
  items,
  query,
  onPick,
}: {
  items: OmniboxItem[];
  query: string;
  onPick: (item: OmniboxItem) => void;
}) {
  if (items.length === 0) {
    return (
      <section
        className="omni-sheet-inline"
        aria-label="Web search suggestions"
        aria-live="polite"
        data-state="empty"
      >
        <p className="omni-empty">
          {query ? 'No suggestions' : 'Recent pages from your Mac show up here'}
        </p>
      </section>
    );
  }

  return (
    <section
      className="omni-sheet-inline"
      aria-label="Web search suggestions"
      aria-live="polite"
      data-state="results"
    >
      <div className="omni-list" role="list" data-hierarchy="list">
        {items.map((item, i) => (
          <div role="listitem" key={(item.kind === 'search' ? item.text : item.url) + i}>
            <OmniRow item={item} onPick={onPick} />
          </div>
        ))}
      </div>
    </section>
  );
}
