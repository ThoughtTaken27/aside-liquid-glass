/**
 * The Browser sheet: every open tab on the Mac, from the phone.
 *
 * - One field searches the list as you type and opens a URL (or a web
 *   search) on submit.
 * - Tabs an Aside chat is using are lifted into their own section, with
 *   the chat's name, so "what is the agent doing" is the first thing seen.
 * - Tapping a tab opens it live (the same stream as the in-chat card),
 *   not a one-off screenshot.
 * - The list refreshes every 2s while open and visible. The server answers
 *   from a warm browser REPL, so a refresh costs ~30ms on the Mac.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Globe, Search, X } from 'lucide-react';
import { Sheet } from './Sheet';
import { Spinner } from './Icons';
import { Favicon, LiveFullscreen, useLiveStream } from './LiveBrowser';
import { api } from '../api';
import { haptic, showConfirm } from '../telegram';
import { toast } from './Toasts';
import type { BrowserTab } from '../types';

const POLL_MS = 2_000;

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

/** Only what the list draws; a fresh array per poll would re-render every row. */
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
      tab.faviconUrl === other.faviconUrl &&
      tab.agent?.sessionId === other.agent?.sessionId &&
      tab.agent?.running === other.agent?.running &&
      tab.agent?.title === other.agent?.title
    );
  });
}

/** What the field would open on submit, or null when it is a search of the list. */
export function destination(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (!/\s/.test(text) && /^[^.\s]+(\.[^.\s]+)+(\/.*)?$/.test(text)) return `https://${text}`;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(text)) return `http://${text}`;
  return null;
}

function matches(tab: BrowserTab, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    tab.title.toLowerCase().includes(q) ||
    tab.url.toLowerCase().includes(q) ||
    (tab.agent?.title || '').toLowerCase().includes(q)
  );
}

function TabRow({
  tab,
  onOpen,
  onClose,
}: {
  tab: BrowserTab;
  onOpen: (tab: BrowserTab) => void;
  onClose: (tab: BrowserTab) => void;
}) {
  const host = hostname(tab.url);
  return (
    <div
      className="tab-deck-row surface-row"
      data-surface-row="tab"
      data-active={tab.active ? 'true' : undefined}
      data-agent={tab.agent ? (tab.agent.running ? 'running' : 'idle') : undefined}
    >
      <button type="button" className="tab-deck-row-main" onClick={() => onOpen(tab)}>
        <span className="tab-deck-icon">
          <Favicon src={tab.faviconUrl || ''} />
        </span>
        <span className="tab-deck-titles">
          <span className="tab-deck-title">{tab.title || host}</span>
          <span className="tab-deck-host surface-meta" data-surface-meta="host">
            {tab.agent ? (
              <>
                <span className={`tab-deck-agent ${tab.agent.running ? 'is-running' : ''}`}>
                  {tab.agent.running ? 'Working' : 'Used by'}
                </span>{' '}
                {tab.agent.title || 'Aside chat'}
              </>
            ) : (
              host
            )}
          </span>
        </span>
        {tab.active ? (
          <span className="tab-deck-active surface-meta" data-surface-meta="state">
            Focused
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="icon-button tab-deck-close"
        aria-label={`Close ${tab.title || host}`}
        onClick={() => onClose(tab)}
      >
        <X size={15} strokeWidth={1.75} />
      </button>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="tab-deck-skeleton" aria-label="Loading tabs" role="status">
      {Array.from({ length: 6 }, (_, i) => (
        <div className="tab-deck-skeleton-row" key={i} aria-hidden>
          <span className="tab-deck-skeleton-icon" />
          <span className="tab-deck-skeleton-lines">
            <span style={{ width: `${62 + ((i * 17) % 30)}%` }} />
            <span style={{ width: `${34 + ((i * 11) % 20)}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Full-screen live view of one tab, with a close action. */
function TabViewer({
  tab,
  onDone,
  onCloseTab,
}: {
  tab: BrowserTab;
  onDone: () => void;
  onCloseTab: (tab: BrowserTab) => Promise<boolean>;
}) {
  const { meta, frame, badge } = useLiveStream({ targetId: tab.targetId }, true, 'full');
  const live = meta?.tab;
  const gone = meta?.state === 'no_tab';
  const title = live?.title || tab.title || hostname(tab.url);
  return (
    <LiveFullscreen
      title={title}
      host={hostname(live?.url || tab.url)}
      who=""
      favicon={tab.faviconUrl || ''}
      frame={frame}
      badge={badge}
      gone={gone}
      onClose={onDone}
      note={
        tab.agent
          ? `${tab.agent.running ? 'In use by' : 'Last used by'} ${tab.agent.title || 'an Aside chat'}.`
          : 'Live, read-only view of this tab on your Mac.'
      }
      actions={
        gone ? null : (
          <button
            type="button"
            className="live-full-action is-danger"
            onClick={async () => {
              if (await onCloseTab(tab)) onDone();
            }}
          >
            <X size={15} /> Close tab
          </button>
        )
      }
    />
  );
}

export function TabDeck({ onClose }: { onClose: () => void }) {
  const [tabs, setTabs] = useState<BrowserTab[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState(false);
  const [watching, setWatching] = useState<BrowserTab | null>(null);
  const inFlight = useRef(false);

  const load = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    api.tabs().then(
      (res) => {
        setTabs((prev) => (sameTabs(prev, res.tabs) ? prev : res.tabs));
        setError(null);
      },
      (err) => setError((err as Error).message || 'Could not reach your Mac'),
    ).finally(() => {
      inFlight.current = false;
    });
  };

  useEffect(() => {
    load();
    let timer: number | undefined;
    const start = () => {
      if (timer === undefined) timer = window.setInterval(load, POLL_MS);
    };
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
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

  const target = destination(query);
  const filtering = query.trim() !== '' && !target;

  const { agentTabs, windows, shown } = useMemo(() => {
    const visible = (tabs ?? []).filter((tab) => matches(tab, filtering ? query.trim() : ''));
    const agent = visible
      .filter((tab) => tab.agent)
      .sort((a, b) => Number(Boolean(b.agent?.running)) - Number(Boolean(a.agent?.running)));
    const rest = visible.filter((tab) => !tab.agent);
    const byWindow = new Map<number, BrowserTab[]>();
    for (const tab of rest) {
      const list = byWindow.get(tab.windowId) ?? [];
      list.push(tab);
      byWindow.set(tab.windowId, list);
    }
    return { agentTabs: agent, windows: [...byWindow.values()], shown: visible.length };
  }, [tabs, query, filtering]);

  const submit = async () => {
    const raw = query.trim();
    if (!raw) return;
    const url = target ?? `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
    haptic('light');
    setOpening(true);
    try {
      await api.openTab(url);
      setQuery('');
      haptic('success');
      toast(target ? `Opened ${hostname(url)} on your Mac` : 'Searching on your Mac');
      load();
    } catch {
      haptic('error');
      toast('Couldn’t open that on your Mac', { tone: 'error' });
    } finally {
      setOpening(false);
    }
  };

  const closeTab = async (tab: BrowserTab): Promise<boolean> => {
    const ok = await showConfirm(`Close "${tab.title || hostname(tab.url)}" on your Mac?`);
    if (!ok) return false;
    haptic('medium');
    setTabs((prev) => prev?.filter((t) => t.targetId !== tab.targetId) ?? null);
    try {
      await api.closeTab(tab.targetId);
      return true;
    } catch {
      haptic('error');
      toast('Couldn’t close that tab', { tone: 'error' });
      load();
      return false;
    }
  };

  const open = (tab: BrowserTab) => {
    haptic('light');
    setWatching(tab);
  };

  const count = tabs?.length ?? 0;
  const subtitle = tabs ? `${count} ${count === 1 ? 'tab' : 'tabs'} open on your Mac` : 'Open tabs on your Mac';

  return (
    <>
      <Sheet side="bottom" title="Browser" subtitle={subtitle} onClose={onClose}>
        <form
          className="tab-deck-go surface-group"
          data-surface-group="open-url"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Search className="tab-deck-go-icon" size={15} aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tabs or enter a URL"
            aria-label="Search tabs or enter a URL"
            inputMode="url"
            enterKeyHint="go"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={opening || !query.trim()}
            aria-label={target ? `Open ${hostname(target)} on your Mac` : 'Search the web on your Mac'}
          >
            {opening ? <Spinner size={14} /> : target ? <ArrowUp size={16} /> : <Globe size={15} />}
          </button>
        </form>
        {query.trim() ? (
          <p className="tab-deck-hint">
            {target
              ? `Return opens ${hostname(target)} in a new tab on your Mac.`
              : `${shown} matching ${shown === 1 ? 'tab' : 'tabs'} · Return searches the web on your Mac.`}
          </p>
        ) : null}

        {error && !tabs ? (
          <div className="tab-deck-empty">
            <p>Couldn’t reach your Mac.</p>
            <button type="button" className="tab-deck-retry" onClick={load}>
              Try again
            </button>
          </div>
        ) : null}
        {!tabs && !error ? <SkeletonRows /> : null}
        {tabs && count === 0 ? <p className="tab-deck-empty">No tabs are open on your Mac.</p> : null}
        {tabs && count > 0 && shown === 0 ? <p className="tab-deck-empty">No tabs match “{query.trim()}”.</p> : null}

        {agentTabs.length ? (
          <section className="tab-deck-window surface-section tab-deck-agents" data-surface-section="agent">
            <h3 className="tab-deck-window-head" data-surface-heading>
              Agent is using
            </h3>
            {agentTabs.map((tab) => (
              <TabRow key={tab.targetId} tab={tab} onOpen={open} onClose={(t) => void closeTab(t)} />
            ))}
          </section>
        ) : null}

        {windows.map((list, index) => (
          <section
            className="tab-deck-window surface-section"
            data-surface-section="window"
            key={list[0].windowId}
          >
            <h3 className="tab-deck-window-head" data-surface-heading>
              {windows.length > 1 ? `Window ${index + 1}` : agentTabs.length ? 'Other tabs' : 'Tabs'}
              <span className="tab-deck-count">{list.length}</span>
            </h3>
            {list.map((tab) => (
              <TabRow key={tab.targetId} tab={tab} onOpen={open} onClose={(t) => void closeTab(t)} />
            ))}
          </section>
        ))}
      </Sheet>
      {watching ? <TabViewer tab={watching} onDone={() => setWatching(null)} onCloseTab={closeTab} /> : null}
    </>
  );
}
