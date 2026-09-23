/**
 * A read-only browser for this account's own Aside memory folder.
 *
 * Full-screen rather than a sheet, matching `SettingsScreen.tsx`'s own
 * pattern (a destination with its own back affordance) since that is
 * where this is reached from. There is no write path anywhere in this
 * component, on purpose (plan section 10): browsing is the whole feature.
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Search, Spinner } from './Icons';
import { Markdown } from './MarkdownAsync';
import { api } from '../api';
import { haptic } from '../telegram';
import type { MemoryNode } from '../types';

/** Every file node in the tree, flattened, for the name filter below. */
function flatten(nodes: MemoryNode[]): MemoryNode[] {
  const out: MemoryNode[] = [];
  for (const node of nodes) {
    if (node.type === 'file') out.push(node);
    if (node.children) out.push(...flatten(node.children));
  }
  return out;
}

function TreeList({
  nodes,
  onOpen,
}: {
  nodes: MemoryNode[];
  onOpen: (node: MemoryNode) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  return (
    <ul
      className="memory-tree surface-group"
      data-surface-group="memory-tree"
      data-separator="inset"
    >
      {nodes.map((node) => (
        <li key={node.relPath}>
          {node.type === 'dir' ? (
            <>
              <button
                type="button"
                className="memory-tree-dir surface-row"
                data-surface-row="directory"
                aria-expanded={!collapsed.has(node.relPath)}
                onClick={() => {
                  haptic('light');
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(node.relPath)) next.delete(node.relPath);
                    else next.add(node.relPath);
                    return next;
                  });
                }}
              >
                {collapsed.has(node.relPath) ? '▸' : '▾'} {node.name}
              </button>
              {!collapsed.has(node.relPath) && node.children ? (
                <TreeList nodes={node.children} onOpen={onOpen} />
              ) : null}
            </>
          ) : (
            <button
              type="button"
              className="memory-tree-file surface-row"
              data-surface-row="file"
              onClick={() => {
                haptic('light');
                onOpen(node);
              }}
            >
              {node.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function MemoryBrowser({ onClose }: { onClose: () => void }) {
  const [tree, setTree] = useState<MemoryNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<MemoryNode | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.memoryTree().then(
      (res) => alive && setTree(res.tree),
      (err) => alive && setError((err as Error).message),
    );
    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!tree) return null;
    const q = query.trim().toLowerCase();
    if (!q) return tree;
    // A flat list once filtering, rather than trying to preserve the tree
    // shape with partial matches -- simpler, and "which folder was this
    // in" matters less once you are searching by name.
    return flatten(tree).filter((node) => node.name.toLowerCase().includes(q));
  }, [tree, query]);

  const openFile = (node: MemoryNode) => {
    setOpen(node);
    setContent(null);
    setContentError(null);
    api.memoryFile(node.relPath).then(
      (res) => setContent(res.content),
      (err) => setContentError((err as Error).message),
    );
  };

  if (open) {
    return (
      <div
        className="app settings-screen destination-surface"
        data-surface="destination"
        data-destination="memory-file"
      >
        <header className="thread-header surface-header" data-surface-header>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              haptic('light');
              setOpen(null);
            }}
            aria-label="Back"
          >
            <ChevronLeft size={20} strokeWidth={1.75} />
          </button>
          <span className="thread-titles">
            <span className="thread-title">{open.name}</span>
          </span>
        </header>
        <div className="settings-scroll surface-content" data-surface-content>
          {contentError ? <p className="list-empty">{contentError}</p> : null}
          {!content && !contentError ? (
            <p className="list-empty">
              <Spinner size={14} /> Loading…
            </p>
          ) : null}
          {content ? (
            <div
              className="memory-page surface-content"
              data-surface-content="document"
            >
              <Markdown text={content} />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className="app settings-screen destination-surface"
      data-surface="destination"
      data-destination="memory"
    >
      <header className="thread-header surface-header" data-surface-header>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Back"
        >
          <ChevronLeft size={20} strokeWidth={1.75} />
        </button>
        <span className="thread-titles">
          <span className="thread-title">Memory</span>
        </span>
      </header>
      <div className="settings-scroll surface-content" data-surface-content>
        <div
          className="memory-search surface-group"
          data-surface-group="search"
        >
          <Search size={15} strokeWidth={1.75} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name"
            aria-label="Filter memory pages"
          />
        </div>
        {error ? <p className="list-empty">{error}</p> : null}
        {!tree && !error ? (
          <p className="list-empty">
            <Spinner size={14} /> Loading…
          </p>
        ) : null}
        {tree && filtered && filtered.length === 0 ? (
          <p className="list-empty">No pages match “{query}”.</p>
        ) : null}
        {filtered ? (
          query.trim() ? (
            <ul
              className="memory-tree surface-group"
              data-surface-group="memory-results"
              data-separator="inset"
            >
              {filtered.map((node) => (
                <li key={node.relPath}>
                  <button
                    type="button"
                    className="memory-tree-file surface-row"
                    data-surface-row="file"
                    onClick={() => {
                      haptic('light');
                      openFile(node);
                    }}
                  >
                    {node.relPath}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <TreeList nodes={filtered} onOpen={openFile} />
          )
        ) : null}
      </div>
    </div>
  );
}
