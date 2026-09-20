/**
 * The session list, in Aside's two views.
 *
 * A `List | Card` segmented control switches between them and the choice
 * persists, exactly as in the sidepanel. Mobile defaults to List: cards
 * are handsome but show two per screen on a phone.
 *
 * What is deliberately NOT rendered here: session ids, costs, token
 * counts, turn counts. The sidepanel shows none of those, so neither does
 * this. Only the title, when it last moved, whether it is unread, and
 * whether it is running.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchHit, SessionRow } from '../types';
import { api } from '../api';
import { dayBucket, listTime, relativeTime } from '../utils/time';
import {
  ArrowDownUp,
  LayoutGrid,
  ListIcon,
  Search,
  Spinner,
  TrashIcon,
} from './Icons';
import { haptic, showConfirm } from '../telegram';
import { readLocal, writeLocal } from '../utils/storage';
import { SwipeToDelete } from './SwipeToDelete';

const VIEW_KEY = 'miniapp.sessionView';

export type SessionView = 'list' | 'card';

export function readStoredView(): SessionView {
  const stored = readLocal(VIEW_KEY);
  return stored === 'card' ? 'card' : 'list';
}

export interface SessionListProps {
  sessions: SessionRow[];
  onOpen: (id: string) => void;
  loading?: boolean;
  /**
   * Delete a chat. Absent means the list is read-only and no delete
   * affordance is drawn at all -- a swipe that reveals a button which
   * cannot work is worse than no swipe.
   */
  onDelete?: (id: string) => Promise<void>;
}

/**
 * Split an already-sorted list into its date bands, preserving order.
 *
 * Bands are emitted in the order the rows arrive rather than in a fixed
 * Today-first order, so reversing the sort reverses the headings too and
 * the list never claims "Today" above a row from March.
 */
export function groupByDay(
  rows: SessionRow[],
  now = Date.now(),
): { label: string; rows: SessionRow[] }[] {
  const groups: { label: string; rows: SessionRow[] }[] = [];
  for (const row of rows) {
    const label = dayBucket(row.updatedAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

export function SessionList({
  sessions,
  onOpen,
  loading,
  onDelete,
}: SessionListProps) {
  const [view, setView] = useState<SessionView>(readStoredView);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [oldestFirst, setOldestFirst] = useState(false);

  // Hits from the server-side body-text search. These live in a separate
  // section from the client-side title/preview filter above; the server
  // already excludes pure title matches to avoid duplicating what the
  // in-memory filter already shows.
  const [remoteHits, setRemoteHits] = useState<SearchHit[]>([]);
  const [remoteSearching, setRemoteSearching] = useState(false);

  // Stale-request guard: each debounce cycle bumps this counter, and the
  // response handler checks it on resolution so an older query's slow reply
  // cannot clobber results from a newer one the user already typed.
  const searchReqId = useRef(0);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.preview.toLowerCase().includes(q),
        )
      : sessions;
    // Waiting sessions sort above everything else; a push notification
    // tap is the most specific intent, and a stuck session should never
    // sit below idle history.
    const sorted = [...filtered].sort((a, b) => {
      if (a.waiting && !b.waiting) return -1;
      if (!a.waiting && b.waiting) return 1;
      return 0;
    });
    return oldestFirst ? sorted.reverse() : sorted;
  }, [sessions, query, oldestFirst]);

  // Debounced server-side body search. Fires 300ms after the user stops
  // typing, and only when there is an actual query -- an empty/cleared box
  // wipes results immediately without a round-trip. The ref counter keeps
  // the resolve from the previous query off the DOM if the user has
  // already moved on to a newer one.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setRemoteHits([]);
      setRemoteSearching(false);
      return;
    }
    const myId = ++searchReqId.current;
    setRemoteSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const { hits } = await api.search(q);
        if (searchReqId.current !== myId) return;
        setRemoteHits(hits);
      } catch {
        if (searchReqId.current !== myId) return;
        setRemoteHits([]);
      } finally {
        if (searchReqId.current !== myId) return;
        setRemoteSearching(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const choose = (next: SessionView) => {
    setView(next);
    writeLocal(VIEW_KEY, next);
    haptic('select');
  };

  const open = (id: string) => {
    haptic('light');
    onOpen(id);
  };

  /**
   * Ask, then delete.
   *
   * Telegram's own confirm dialog rather than a webview one: it is the
   * OS-level sheet, it cannot be missed behind the keyboard, and it is the
   * same dialog the Stop control already uses. Deleting is the one action
   * in this list with no undo inside the app, so it gets the interruption.
   */
  const remove = async (session: SessionRow) => {
    if (!onDelete) return;
    const ok = await showConfirm(`Delete “${session.title}”?`);
    if (!ok) return;
    haptic('medium');
    await onDelete(session.id);
  };

  // Rows are already sorted by the memo above; grouping only inserts
  // headings at the points where the band changes.
  const groups = useMemo(() => groupByDay(visible), [visible]);

  return (
    <section
      className="session-area session-area-quiet"
      aria-label="Recent chats"
      data-density="quiet"
    >
      <div className="list-toolbar context-controls" data-role="context-controls">
        <div className="segmented" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'list'}
            className={view === 'list' ? 'is-active' : ''}
            onClick={() => choose('list')}
          >
            <ListIcon size={15} strokeWidth={1.75} />
            List
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'card'}
            className={view === 'card' ? 'is-active' : ''}
            onClick={() => choose('card')}
          >
            <LayoutGrid size={15} strokeWidth={1.75} />
            Card
          </button>
        </div>

        <span className="composer-spacer" />

        <button
          type="button"
          className="icon-button"
          aria-label="Search sessions"
          onClick={() => {
            setSearching((prev) => !prev);
            if (searching) setQuery('');
          }}
        >
          <Search size={17} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Reverse order"
          onClick={() => setOldestFirst((prev) => !prev)}
        >
          <ArrowDownUp size={17} strokeWidth={1.75} />
        </button>
      </div>

      {searching ? (
        <input
          className="list-search"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search chats"
        />
      ) : null}

      {loading && sessions.length === 0 ? (
        <p className="list-empty">Loading chats…</p>
      ) : null}
      {!loading && visible.length === 0 ? (
        <p className="list-empty is-blank">
          {query ? 'No chats match that.' : 'No chats yet.'}
        </p>
      ) : null}

      {view === 'list' ? (
        <div className="session-groups" data-hierarchy="list">
          {groups.map((group) => (
            <section className="session-group" key={group.label}>
              <h3 className="session-group-head">{group.label}</h3>
              <div
                className="session-rows"
                role="list"
                aria-label={group.label}
              >
                {group.rows.map((session, index) => (
                  <div
                    className="session-row-item"
                    role="listitem"
                    key={session.id}
                  >
                    <SwipeToDelete
                      enabled={Boolean(onDelete)}
                      label="Delete"
                      icon={<TrashIcon size={17} strokeWidth={1.75} />}
                      onDelete={() => remove(session)}
                    >
                    <button
                      type="button"
                      className={`session-row${
                        session.waiting ? ' is-waiting' : ''
                      }`}
                      /*
                       * The row's position in its day band, read by the
                       * entrance stagger in components.css. Inline because
                       * it is per-element data, not a style decision --
                       * the cadence and the cap both live in the
                       * stylesheet.
                       */
                      style={{ '--i': index } as React.CSSProperties}
                      onClick={() => open(session.id)}
                    >
                      <span className="session-row-main">
                        {session.waiting ? (
                          <span className="session-waiting-label">
                            <span className="waiting-dot" />
                            Waiting on you
                          </span>
                        ) : null}
                        <span className="session-row-title">
                          {session.title}
                        </span>
                      </span>
                      <span className="session-row-marks">
                        {session.status === 'running' ? (
                          <Spinner size={13} />
                        ) : null}
                        {session.unread ? (
                          <span className="unread-dot" />
                        ) : null}
                        <span className="session-row-time">
                          {listTime(session.updatedAt)}
                        </span>
                      </span>
                    </button>
                    </SwipeToDelete>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="session-cards" role="list" data-hierarchy="cards">
          {visible.map((session, index) => (
            <div role="listitem" key={session.id}>
              <button
                type="button"
                className={`session-card${session.waiting ? ' is-waiting' : ''}`}
                style={{ '--i': index } as React.CSSProperties}
                onClick={() => open(session.id)}
              >
                <span className="session-card-head">
                  <span className="session-card-time">
                    {session.waiting ? (
                      <span className="session-waiting-label">
                        <span className="waiting-dot" />
                        Waiting on you
                      </span>
                    ) : null}
                    {relativeTime(session.updatedAt)}
                  </span>
                  {session.status === 'running' ? <Spinner size={13} /> : null}
                  {session.unread ? <span className="unread-dot" /> : null}
                </span>
                <span className="session-card-title">{session.title}</span>
                {session.preview ? (
                  <span className="session-card-preview">{session.preview}</span>
                ) : null}
              </button>
            </div>
          ))}
        </div>
      )}

      {searching && query.trim() && (remoteSearching || remoteHits.length > 0) ? (
        <section
          className="search-hits"
          aria-label="Older message matches"
          data-results="secondary"
        >
          <span className="search-hits-heading" role="heading" aria-level={3}>
            {remoteSearching ? <Spinner size={12} /> : null}
            Also found in older messages
          </span>
          {remoteHits.map((hit) => (
            <button
              key={hit.sessionId}
              type="button"
              className="search-hit-row"
              onClick={() => open(hit.sessionId)}
            >
              <span className="search-hit-title">{hit.title}</span>
              <span className="search-hit-snippet">{hit.snippet}</span>
            </button>
          ))}
        </section>
      ) : null}
    </section>
  );
}
