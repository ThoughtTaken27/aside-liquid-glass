import { Sheet } from './Sheet';
import { ArrowUpRight } from './Icons';
import { openExternal } from '../telegram';
import type { CitationMark } from '../utils/citations';
import type { CitationSource } from '../types';

/** Source catalogs are data, not permission to navigate arbitrary schemes. */
function webUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.href : null;
  } catch { return null; }
}

/** One compact, independently wrapping badge per cited source. */
export function CitationBadges({ mark, sources, onOpen }: {
  mark: CitationMark;
  sources: Record<string, CitationSource>;
  onOpen?: (mark: CitationMark) => void;
}) {
  return <span className="cite-badges">{mark.refs.map((ref) => {
    const source = sources[ref];
    if (!source || !webUrl(source.url)) return null;
    const label = source.domain || 'Source';
    const content = <span className="cite-chip-label">{label}</span>;
    const shared = { className: 'cite-chip', title: source.title, 'aria-label': 'Open source: ' + label };
    return onOpen ? (
      <button key={ref} {...shared} type="button"
        onClick={() => onOpen({ ...mark, refs: [ref] })}>{content}</button>
    ) : (
      <a key={ref} {...shared} href={webUrl(source.url)!}
        target="_blank" rel="noopener noreferrer">{content}</a>
    );
  })}</span>;
}

/**
 * The sheet behind a citation chip.
 *
 * One row per source the tag named, each opening the page it came from.
 * The quoted passage, when the tag carried one, sits above the list --
 * that is the sentence the answer is standing behind.
 */
export function CitationSheet({
  mark,
  sources,
  onClose,
}: {
  mark: CitationMark;
  sources: Record<string, CitationSource>;
  onClose: () => void;
}) {
  const resolved = mark.refs
    .map((ref) => sources[ref])
    .filter((source): source is CitationSource => Boolean(source) && Boolean(webUrl(source.url)));

  return (
    <Sheet
      side="bottom"
      title={resolved.length === 1 ? 'Source' : 'Sources'}
      onClose={onClose}
    >
      {mark.quote ? <blockquote className="cite-quote">{mark.quote}</blockquote> : null}
      <ul className="cite-list">
        {resolved.map((source) => (
          <li key={source.id}>
            <button
              type="button"
              className="cite-source"
              onClick={() => openExternal(source.url)}
            >
              <span className="cite-source-title">{source.title}</span>
              <span className="cite-source-domain">
                {source.domain}
                <ArrowUpRight size={12} strokeWidth={1.75} />
              </span>
              {source.excerpt ? (
                <span className="cite-source-excerpt">{source.excerpt}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
