import { useEffect, useLayoutEffect, useRef, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Bookmark, Box, Globe, SlidersHorizontal, SquarePen } from 'lucide-react';
import { Shine } from './Affect';
import type { SkillsStatus } from '../hooks/useSkills';
import { GROUP_LABEL, slashKey, slashLabel, type SlashItem } from '../utils/slash';
import '../theme/slash.css';

/**
 * The "/" menu: commands and skills in a floating list above the composer.
 *
 * Shape follows the AI SDK Agents slash command menu: one card, 6px inset,
 * single-line rows of icon, `/name`, and a muted description, grouped with
 * small labels and led by what you picked recently. Phone changes: rows are
 * 44px on touch (32px with a mouse), and the Enter hint only shows where
 * Enter actually picks (a phone keyboard's return is a newline).
 *
 * It is portalled to <body> and pinned to the composer's measured top edge,
 * because the composer sits inside the voice-glow wrapper, which clips.
 * The list takes exactly the room between the header and the composer,
 * re-measured as the keyboard resizes #root.
 *
 * Motion (reference): 150ms ease-out in from scale .98 and 4px down, 120ms
 * out; opacity/transform only, none under reduced motion.
 */

const itemName = slashLabel;
const itemDescription = (item: SlashItem) => (item.kind === 'command' ? item.description : item.skill.description);
const itemGroup = (item: SlashItem) => (item.kind === 'command' ? 'commands' : item.skill.group);

function Mark({ item }: { item: SlashItem }) {
  const Icon =
    item.kind === 'command'
      ? item.id === 'new' ? SquarePen : SlidersHorizontal
      : item.skill.group === 'sites' ? Globe : item.skill.group === 'builtin' ? Box : Bookmark;
  return (
    <span className="slash-mark" aria-hidden>
      <Icon size={16} strokeWidth={1.8} />
    </span>
  );
}

/** Room the floating list may use, given the composer's top edge. */
export function slashRoom(composerTop: number, headerBottom: number): number {
  // 8px gap to the composer, 8px clear of the header, 2px of card border.
  return Math.floor(composerTop - 8 - headerBottom - 8 - 2);
}

export function SlashMenu({
  items,
  query,
  active,
  showActive = true,
  enterHint = false,
  recentCount = 0,
  nameChars,
  status,
  closing,
  anchor,
  onPick,
  onActive,
}: {
  items: SlashItem[];
  query: string;
  active: number;
  /** Off on touch with no query: nothing is "chosen" until you type or tap. */
  showActive?: boolean;
  /** Show the ↵ key on the active row (only where Enter picks it). */
  enterHint?: boolean;
  /** How many leading rows are recent picks (unfiltered list only). */
  recentCount?: number;
  /** Longest name in the whole catalog, so the column holds while filtering. */
  nameChars?: number;
  status: SkillsStatus;
  closing?: boolean;
  /** The composer card the menu floats above. */
  anchor: RefObject<HTMLElement | null>;
  onPick: (item: SlashItem) => void;
  onActive: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const pin = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const card = anchor.current;
    const box = pin.current;
    const el = list.current;
    const root = document.getElementById('root');
    if (!card || !box || !el) return;
    let raf = 0;
    const fit = () => {
      raf = 0;
      const cardBox = card.getBoundingClientRect();
      const rootTop = root ? root.getBoundingClientRect().top : 0;
      const header = document.querySelector<HTMLElement>('.thread-header');
      const headerBottom = Math.max(
        rootTop + 4,
        header && header.offsetParent ? header.getBoundingClientRect().bottom : rootTop + 48,
      );
      box.style.left = `${Math.round(cardBox.left)}px`;
      box.style.width = `${Math.round(cardBox.width)}px`;
      box.style.top = `${Math.round(cardBox.top - 8)}px`;
      const next = `${Math.max(132, Math.min(420, slashRoom(cardBox.top, headerBottom)))}px`;
      if (el.style.maxHeight !== next) el.style.maxHeight = next;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(fit);
    };
    fit();
    const ro = new ResizeObserver(schedule);
    ro.observe(card);
    if (root) ro.observe(root);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [anchor]);

  // Keep the keyboard-highlighted row in view, only when the index moves.
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  // New query, back to the top: the best match is first.
  useEffect(() => {
    list.current?.scrollTo?.({ top: 0 });
  }, [query]);

  const searching = Boolean(query.trim());
  // Column width in ch, like the reference's --slash-menu-name (name plus
  // the slash); see Composer for how the catalog length is chosen.
  const nameCh = Math.min(28, Math.max(6, (nameChars ?? Math.max(0, ...items.map((item) => itemName(item).length))) + 1));

  const groups: { key: string; label: string | null; rows: { item: SlashItem; index: number }[] }[] = [];
  items.forEach((item, index) => {
    const key = searching ? 'results' : index < recentCount ? 'recent' : itemGroup(item);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: searching ? null : GROUP_LABEL[key as keyof typeof GROUP_LABEL], rows: [] };
      groups.push(group);
    }
    group.rows.push({ item, index });
  });

  const menu = (
    <div className="slash-anchor" ref={pin}>
      <section
        className="slash-menu"
        data-state={closing ? 'closing' : 'open'}
        aria-label="Commands and skills"
        style={{ '--slash-name': `${nameCh}ch` } as CSSProperties}
      >
        <div
          className="slash-list"
          ref={list}
          role="listbox"
          id="slash-listbox"
          aria-label="Commands and skills"
          aria-activedescendant={showActive && items[active] ? `slash-opt-${active}` : undefined}
        >
          {items.length === 0 ? (
            <p className="slash-empty">
              {status === 'loading'
                ? <Shine text="Loading skills from your Mac" />
                : <>Nothing matches <span className="slash-empty-query">/{query}</span></>}
            </p>
          ) : (
            groups.map((group) => (
              <div className="slash-group" role="group" aria-label={group.label ?? 'Results'} key={`${group.key}-${group.rows[0].index}`}>
                {group.label ? <div className="slash-group-label" aria-hidden>{group.label}</div> : null}
                {group.rows.map(({ item, index }) => {
                  const on = showActive && index === active;
                  return (
                    <button
                      key={slashKey(item)}
                      type="button"
                      role="option"
                      id={`slash-opt-${index}`}
                      data-index={index}
                      aria-selected={on}
                      tabIndex={-1}
                      className={`slash-row${on ? ' is-active' : ''}`}
                      // Keep the textarea focused (and the keyboard up) through the tap.
                      onPointerDown={(e) => e.preventDefault()}
                      onMouseMove={() => index !== active && onActive(index)}
                      onClick={() => onPick(item)}
                    >
                      <Mark item={item} />
                      <span className="slash-name"><span className="slash-slash">/</span>{itemName(item)}</span>
                      <span className="slash-desc">{itemDescription(item)}</span>
                      {on && enterHint ? <kbd className="slash-enter" aria-hidden>↵</kbd> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        {status === 'offline' ? (
          <p className="slash-status" role="status">
            <span className="slash-status-dot" aria-hidden />
            Showing your saved list. Reconnecting to your Mac.
          </p>
        ) : null}
      </section>
    </div>
  );
  return createPortal(menu, document.body);
}
