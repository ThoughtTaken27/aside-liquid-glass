/**
 * Word-by-word reveal for a streaming answer.
 *
 * A rehype plugin, used only while an answer is streaming. It wraps each
 * word of the LAST block in a `<span class="sw">`, so React mounts a new
 * span exactly when a new word arrives and CSS can bring that word into
 * focus (opacity + a small blur, see refine.css). Words that were already
 * on screen keep their span at the same position, so React reconciles
 * them in place and nothing replays.
 *
 * Only the last block is wrapped: earlier paragraphs are finished and go
 * back to plain text, which keeps the node count bounded on long answers.
 * Code is never wrapped -- it has to stay byte-exact for copy and
 * highlighting.
 *
 * `--sw` staggers the words that arrived together in one chunk, capped so
 * a large chunk never takes longer than a beat to land.
 */

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

export interface StreamWordState {
  /** Index of the block that was last wrapped. */
  block: number;
  /** Words already shown in that block. */
  shown: number;
}

const SKIP = new Set(['code', 'pre', 'kbd', 'svg', 'math']);
const TEXT_ENDS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const STAGGER_MS = 8;
const STAGGER_CAP = 6;

export function rehypeStreamWords(state: StreamWordState) {
  return (tree: HastNode) => {
    const blocks = (tree.children || []).filter((node) => node.type === 'element');
    const lastIndex = blocks.length - 1;
    const last = blocks[lastIndex];
    if (!last || SKIP.has(last.tagName || '')) return;

    if (state.block !== lastIndex) {
      state.block = lastIndex;
      state.shown = 0;
    }
    const startFrom = state.shown;
    let count = 0;

    const wrap = (node: HastNode) => {
      if (!node.children) return;
      const next: HastNode[] = [];
      for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string') {
          for (const piece of child.value.split(/(\s+)/)) {
            if (!piece) continue;
            if (/^\s+$/.test(piece)) {
              next.push({ type: 'text', value: piece });
              continue;
            }
            const arrival = Math.max(0, count - startFrom);
            count += 1;
            next.push({
              type: 'element',
              tagName: 'span',
              properties: {
                className: ['sw'],
                style: `--sw:${Math.min(arrival, STAGGER_CAP) * STAGGER_MS}ms`,
              },
              children: [{ type: 'text', value: piece }],
            });
          }
        } else {
          if (child.type === 'element' && !SKIP.has(child.tagName || '')) wrap(child);
          next.push(child);
        }
      }
      node.children = next;
    };

    wrap(last);
    state.shown = count;

    /*
     * A small live dot at the exact end of the text (affectUI AI Answer),
     * inside the last paragraph or list item rather than on a line of its
     * own. While words keep arriving it is remounted at each new end and
     * holds still; it only starts to pulse once the stream pauses, which
     * is exactly when a reader needs to know the answer is not finished.
     */
    let target: HastNode = last;
    for (;;) {
      const kids = target.children || [];
      const tail = kids[kids.length - 1];
      if (tail && tail.type === 'element' && ['ul', 'ol', 'li', 'blockquote', 'p'].includes(tail.tagName || '')) {
        target = tail;
        continue;
      }
      if (tail && tail.type === 'element' && SKIP.has(tail.tagName || '')) return;
      break;
    }
    // Only ever at the end of a line of text. Inside a table it became a
    // stray row, inside a code wrapper an extra line: each added height
    // that vanished again when the next block began.
    if (!TEXT_ENDS.has(target.tagName || '')) return;
    (target.children ||= []).push({
      type: 'element',
      tagName: 'span',
      properties: { className: ['caret-dot'], ariaHidden: 'true' },
      children: [],
    });
  };
}
