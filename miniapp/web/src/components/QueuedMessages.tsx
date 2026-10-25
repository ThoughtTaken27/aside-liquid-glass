/**
 * Messages waiting behind the running turn, as the desktop shows them.
 *
 * Aside's sidepanel puts each queued message in its own card directly
 * above the composer: the words, then Send now, Edit and Remove. The phone
 * mirrors that one-for-one, because the point of the queue is that you can
 * see what will happen next and change your mind before it does.
 *
 * Motion is spatial, so each exit says where the message went:
 *
 *  - Send now lifts it up, toward the conversation it is joining.
 *  - Edit drops it down, into the composer it is returning to.
 *  - Remove settles it in place and fades.
 *  - A turn ending takes it up, the same way Send now does.
 *
 * The row's height collapses with the card (a grid-rows transition), so
 * the composer under it glides instead of jumping when a card leaves.
 */
import { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { FileIcon, X } from './Icons';
import { haptic } from '../telegram';
import type { QueuedMessage } from '../types';

export type QueueExit = 'now' | 'edit' | 'remove' | 'sent';

interface Row {
  item: QueuedMessage;
  leaving: QueueExit | null;
}

/** Matches the CSS exit duration, plus a frame. */
const EXIT_MS = 260;

export function QueuedMessages({
  items,
  onSendNow,
  onEdit,
  onRemove,
}: {
  items: QueuedMessage[];
  onSendNow: (item: QueuedMessage) => void;
  onEdit: (item: QueuedMessage) => void;
  onRemove: (item: QueuedMessage) => void;
}) {
  /*
   * Rows outlive their items by one exit animation. The reason a card left
   * is recorded at the tap (`exitFor`), before the item vanishes from the
   * props; anything that leaves without a tap left because its turn began.
   */
  const exitFor = useRef(new Map<string, QueueExit>());
  const [rows, setRows] = useState<Row[]>(() => items.map((item) => ({ item, leaving: null })));
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    setRows((prev) => {
      const live = new Map(items.map((item) => [item.id, item]));
      const next: Row[] = [];
      for (const row of prev) {
        const still = live.get(row.item.id);
        if (still) {
          next.push({ item: still, leaving: null });
          live.delete(row.item.id);
        } else {
          next.push({
            item: row.item,
            leaving: row.leaving ?? exitFor.current.get(row.item.id) ?? 'sent',
          });
        }
      }
      // An optimistic card can be re-keyed to its server id; it takes the
      // old row's place rather than animating out and in again.
      for (const item of live.values()) {
        const swap = next.findIndex(
          (r) => r.leaving === 'sent' && r.item.local && r.item.text === item.text,
        );
        if (swap >= 0) next[swap] = { item, leaving: null };
        else next.push({ item, leaving: null });
      }
      return next;
    });
  }, [items]);

  useEffect(() => {
    for (const row of rows) {
      if (!row.leaving || timers.current.has(row.item.id)) continue;
      const id = row.item.id;
      timers.current.set(
        id,
        window.setTimeout(() => {
          timers.current.delete(id);
          exitFor.current.delete(id);
          setRows((prev) => prev.filter((r) => r.item.id !== id || !r.leaving));
        }, EXIT_MS),
      );
    }
  }, [rows]);

  useEffect(
    () => () => {
      for (const t of timers.current.values()) window.clearTimeout(t);
    },
    [],
  );

  if (!rows.length) return null;

  const act = (item: QueuedMessage, kind: QueueExit, fn: (item: QueuedMessage) => void) => {
    // The optimistic card has no server id yet; its reply lands in a beat.
    if (item.local) return;
    haptic('light');
    exitFor.current.set(item.id, kind);
    fn(item);
  };

  return (
    <section className="queue-stack" aria-label="Queued messages">
      {rows.map(({ item, leaving }) => (
        <div
          key={item.id}
          className="queued-row"
          data-leaving={leaving ?? undefined}
          aria-hidden={leaving ? true : undefined}
        >
          <div className="queued-clip">
          <div className="queued-card" data-local={item.local ? 'true' : undefined}>
            <p className="queued-text" title={item.text}>
              {item.text || (item.attachments.length ? 'Attachment' : '')}
            </p>
            {item.attachments.length ? (
              <span className="queued-files" aria-label={`${item.attachments.length} attached`}>
                <FileIcon size={12} strokeWidth={1.75} />
                {item.attachments.length}
              </span>
            ) : null}
            <div className="queued-actions">
              <button
                type="button"
                className="queued-now"
                onClick={() => act(item, 'now', onSendNow)}
                disabled={Boolean(leaving)}
              >
                Send now
              </button>
              <button
                type="button"
                className="queued-icon"
                aria-label="Edit queued message"
                onClick={() => act(item, 'edit', onEdit)}
                disabled={Boolean(leaving)}
              >
                <Pencil size={15} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="queued-icon"
                aria-label="Remove queued message"
                onClick={() => act(item, 'remove', onRemove)}
                disabled={Boolean(leaving)}
              >
                <X size={16} strokeWidth={1.75} />
              </button>
            </div>
          </div>
          </div>
        </div>
      ))}
    </section>
  );
}
