/**
 * Citations, as Aside's transcripts carry them.
 *
 * Assistant text embeds `<citation refs="<id>[,<id>]">supporting text
 * </citation>`, sometimes with the supporting text wrapped in `<quote>`.
 * Rendered naively, the reader sees the raw tag -- which is exactly what
 * the mini app was doing.
 *
 * The transform here rewrites each tag into ordinary markdown plus a link
 * with a private `cite:` scheme, which the markdown renderer draws as a
 * tappable superscript chip. Doing it as a link rather than as a custom
 * remark plugin keeps inline formatting inside the quoted span working and
 * keeps this file testable on its own.
 *
 * Two rules that matter:
 *
 *  - A ref that resolves to no known source gets NO chip. Some models emit
 *    local markers (`refs="s1"`); a chip that opens an empty sheet is worse
 *    than plain prose.
 *  - A trailing, still-incomplete tag is dropped rather than shown. During
 *    streaming the buffer routinely ends mid-`<citation`, and flashing the
 *    raw markup for one frame is the bug this feature exists to fix.
 */

export interface CitationMark {
  /** 1-based, matching the superscript the reader taps. */
  index: number;
  /** Source ids in the tag that we could resolve. */
  refs: string[];
  /** The `<quote>` body, when the tag carried one. */
  quote: string;
}

export interface CitationResult {
  /** Markdown with the tags replaced by text plus `cite:` links. */
  markdown: string;
  /** One entry per rendered chip, indexed by the chip's number. */
  marks: CitationMark[];
}

/**
 * Every shape of citation markup seen in real transcripts, in one pass.
 *
 * The alternation matters, and so does the order of the branches:
 *
 *  1. A COMPLETE tag: `<citation refs="a,b">body</citation>`.
 *  2. An ORPHANED OPENING tag with no closer. Several models -- gpt-5.6
 *     among them, reproduced from a real thread on 2026-09-01 -- append
 *     the tag AFTER the sentence it supports and never close it. The old
 *     pattern required a closer, so none of these matched and the reader
 *     got a screenful of literal `<citation refs="NH9pusvrG-...">` in the
 *     middle of the prose. That is the "random citation refs that keep
 *     popping up" bug.
 *  3. An ORPHANED CLOSING tag, which is the same failure from the other
 *     end and is simply deleted.
 *
 * Complete tags are matched first so a well-formed pair is never split
 * into an orphaned open plus a stray close. Running all three in a single
 * `replace` keeps the chip numbering in document order, which a second
 * pass over the whole string would not.
 *
 * Attribute quoting is loose (double, single, or bare) because this is
 * model output, not a document format anyone validates.
 */
const REFS = String.raw`refs\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`;
const CITATION_RE = new RegExp(
  // 1-3: paired refs, 4: paired body
  `<citation\\s+${REFS}\\s*>([\\s\\S]*?)<\\/citation\\s*>` +
    // 5-7: orphaned refs, 8: a quote that trails it, which belongs to it
    `|<citation\\s+${REFS}\\s*>(?:\\s*<quote\\s*>([\\s\\S]*?)<\\/quote\\s*>)?` +
    `|<\\/citation\\s*>`,
  'gi',
);
const QUOTE_RE = /<quote\s*>([\s\S]*?)<\/quote\s*>/gi;
/** Quote tags left behind by an unclosed citation, unwrapped not shown. */
const STRAY_QUOTE_RE = /<\/?quote\s*>/gi;

const SUPERSCRIPTS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

/*
 * Some models fill a well-formed citation body with this exact scaffolding
 * instead of a quote. It conveys nothing to the reader and produced lines
 * such as “Supporting text quoted from that source¹” in real answers.
 * Match only the generic placeholder, not actual source text.
 */
const GENERIC_CITATION_BODY =
  /^(?:supporting\s+)?text\s+quoted\s+from\s+(?:that|the|this)\s+source[.!]?$/i;

export function isGenericCitationBody(text: string): boolean {
  return GENERIC_CITATION_BODY.test(text.trim());
}

/** `12` -> `¹²`, so the chip stays one line tall at any count. */
export function superscript(n: number): string {
  return String(n)
    .split('')
    .map((digit) => SUPERSCRIPTS[Number(digit)] ?? digit)
    .join('');
}

/** The href a chip carries; parsed back out by the renderer. */
export function citationHref(index: number): string {
  return `cite:${index}`;
}

export function citationIndexFrom(href: string): number | null {
  const match = /^cite:(\d+)$/.exec(href);
  return match ? Number(match[1]) : null;
}

/**
 * Rewrite every citation tag in `text`.
 *
 * `isKnown` decides whether a ref resolves; callers pass a lookup over the
 * session's collected search sources.
 */
export function transformCitations(
  text: string,
  isKnown: (ref: string) => boolean,
): CitationResult {
  const marks: CitationMark[] = [];

  const markdown = String(text || '')
    .replace(
      CITATION_RE,
      (
        _match,
        pairedDouble: string | undefined,
        pairedSingle: string | undefined,
        pairedBare: string | undefined,
        pairedBody: string | undefined,
        openDouble: string | undefined,
        openSingle: string | undefined,
        openBare: string | undefined,
        openQuote: string | undefined,
      ) => {
        const pairedRefs = pairedDouble ?? pairedSingle ?? pairedBare;
        const openRefs = openDouble ?? openSingle ?? openBare;
        const rawRefs = pairedRefs ?? openRefs;

        // Branch 3: a closing tag with nothing to close. Nothing to render
        // and nothing to keep -- it is markup that escaped its own pair.
        if (rawRefs === undefined) return '';

        // An orphaned opening tag has no body by definition -- the sentence
        // it supports is already in the prose before it -- but a `<quote>`
        // written straight after it is still that citation's quote, and it
        // belongs in the sheet rather than dumped into the paragraph.
        const body =
          pairedRefs !== undefined
            ? (pairedBody ?? '')
            : openQuote
              ? `<quote>${openQuote}</quote>`
              : '';

        const refs = rawRefs
          .split(',')
          .map((ref) => ref.trim())
          .filter((ref) => ref && isKnown(ref));

        // `<quote>` marks the passage the source actually said; the sheet
        // shows it, and the prose keeps whatever sat outside it.
        const quotes: string[] = [];
        const inlineBody = body
          .replace(QUOTE_RE, (_q, quoted: string) => {
            quotes.push(quoted.trim());
            return '';
          })
          .trim();
        const inline = isGenericCitationBody(inlineBody) ? '' : inlineBody;

        if (!refs.length) return inline;

        marks.push({ index: marks.length + 1, refs, quote: quotes.join(' ') });
        const chip = `[${superscript(marks.length)}](${citationHref(marks.length)})`;
        return inline ? `${inline}${chip}` : chip;
      },
    )
    // A `<quote>` whose citation never closed would otherwise survive as
    // literal markup for exactly the same reason the tag above did.
    .replace(STRAY_QUOTE_RE, '');

  return { markdown, marks };
}

/**
 * Drop a citation tag that has not finished arriving.
 *
 * Only applied to a streaming buffer: on completed text an unmatched tag is
 * genuinely malformed, and cutting the rest of the message off to hide it
 * would lose real content.
 */
export function dropPartialCitation(text: string): string {
  const open = text.lastIndexOf('<');
  if (open === -1) return text;
  const tail = text.slice(open);
  // A whole opening tag with no closer after it: the body is still coming.
  if (tail.startsWith('<citation')) {
    return tail.includes('</citation>') ? text : text.slice(0, open);
  }
  // Fewer characters than the tag name, but everything so far matches it --
  // `<cit` is one delta away from being a tag and must not flash on screen.
  // Case-insensitive for the same reason the tag pattern is: this is model
  // output. Compared against the LONGER of the two prefixes so a partial
  // `</cit` is caught as well as a partial `<cit`.
  const lower = tail.toLowerCase();
  const partial =
    '<citation'.startsWith(lower) || '</citation'.startsWith(lower);
  return partial ? text.slice(0, open) : text;
}
