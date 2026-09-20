import { lazy, memo, Suspense } from 'react';
import type { CitationMark } from '../utils/citations';
import type { CitationSource } from '../types';

/**
 * The markdown renderer, off the first-paint critical path.
 *
 * Measured on this Mac, cold, service worker cleared: the four critical
 * assets finish arriving at 45ms and the first contentful paint lands at
 * 240ms. Almost none of that gap is network and almost none of it is the
 * app's own work -- module parse, compile and evaluate accounts for ~137ms
 * of it, and React's mount and paint for the remaining ~58ms.
 *
 * So first paint is bound by how much JavaScript the critical path has to
 * evaluate, not by how fast it arrives. `react-markdown` and the whole
 * remark/micromark chain is 166.9KB raw of that path, about a third of it,
 * and the home screen -- a greeting, a composer and a list of chat titles
 * -- renders no markdown at all.
 *
 * Splitting it out would normally trade a faster launch for a flash of
 * nothing the first time a thread renders. Two things prevent that:
 *
 *   1. `warmMarkdown()` is called once the first screen is on-screen, so
 *      the chunk is fetched during the idle window the app already spends
 *      waiting on `/api/thread` (measured: 84-105ms of TTFB on that call
 *      alone). By the time there is a message to draw, the renderer is
 *      there.
 *   2. If it somehow is not -- a slow link, a cold cache -- the fallback
 *      renders the raw text rather than a spinner or a blank. Markdown
 *      source is still readable prose; a paragraph that starts unstyled
 *      and upgrades a frame later is a far smaller insult than an empty
 *      box where an answer should be.
 *
 * `preserve-wrap` keeps the fallback's newlines, so the shape of the text
 * survives the upgrade and nothing reflows more than it has to.
 */
const MarkdownImpl = lazy(() =>
  import('./Markdown').then((m) => ({ default: m.Markdown })),
);

/** Warmed after first paint. Idempotent: the module cache dedupes it. */
export function warmMarkdown(): void {
  void import('./Markdown');
}

export interface MarkdownProps {
  text: string;
  streaming?: boolean;
  sources?: Record<string, CitationSource>;
  sessionId?: string;
  onOpenCitation?: (mark: CitationMark) => void;
}

export const Markdown = memo(function Markdown(props: MarkdownProps) {
  return (
    <Suspense
      fallback={<div className="md md-pending">{props.text}</div>}
    >
      <MarkdownImpl {...props} />
    </Suspense>
  );
});
