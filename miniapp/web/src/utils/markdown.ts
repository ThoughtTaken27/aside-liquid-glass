/**
 * Making a half-arrived markdown buffer safe to render.
 *
 * Streaming text is rendered through the same markdown pipeline as finished
 * text, so the answer does not visibly reflow when the transcript catches
 * up. The one construct that genuinely breaks is an unterminated code
 * fence: everything after it renders as code until the closer arrives, so
 * the whole tail of the message flickers into a grey block and back.
 *
 * Closing the fence for the render only fixes that, and nothing else needs
 * a guard -- an unclosed `**` or `_` renders as the literal characters,
 * which is what it will briefly look like in Aside too.
 */

/** Append a closing fence when the buffer ends inside an open one. */
export function closeOpenFence(text: string): string {
  const lines = String(text || '').split('\n');
  let fence: string | null = null;
  for (const line of lines) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!match) continue;
    if (fence === null) fence = match[1][0].repeat(3);
    else if (line.trimStart().startsWith(fence)) fence = null;
  }
  return fence ? `${text}\n${fence}` : text;
}

/**
 * The fence tags a piece of markdown opens, in order of first appearance.
 *
 * Used to decide which syntax grammars are worth downloading. Deliberately
 * a cheap regular expression rather than a parse: a false positive costs
 * one small grammar chunk, and a false negative costs a code block that
 * renders as plain monospace, which is already the fallback.
 */
export function fenceLanguages(markdown: string): string[] {
  const found: string[] = [];
  const fence = /^[ \t]*(?:```|~~~)[ \t]*([A-Za-z0-9_+-]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown)) !== null) {
    const tag = match[1].toLowerCase();
    if (!found.includes(tag)) found.push(tag);
  }
  return found;
}

const TABLE_DELIMITER = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;
const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').length;

/**
 * The single `*` or `_` emphasis left open at the end of a line, if any.
 *
 * Only a real opener counts: at the start or after a space or punctuation,
 * and followed by a word character. So `2 * 3` (spaced), `snake_case`
 * (inside a word) and a `* ` list marker are left alone; closing those
 * would add a visible stray character instead of preventing a flip.
 */
function openSingleEmphasis(line: string): string {
  const text = line.replace(/\\[*_]/g, '').replace(/\*\*/g, '').replace(/^\s*[*+-]\s+/, '');
  const open: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '*' && ch !== '_') continue;
    const before = text[i - 1] ?? ' ';
    const after = text[i + 1] ?? ' ';
    if (open.includes(ch) && /\S/.test(before) && !/\w/.test(after)) {
      // Closing an outer marker closes anything left open inside it.
      open.length = open.lastIndexOf(ch);
    } else if (!/\w/.test(before) && /\w/.test(after)) {
      open.push(ch);
    }
  }
  // Innermost first, so the closers nest the way the openers did.
  return open.reverse().join('');
}

/**
 * Hold back the part of a streaming answer whose shape is not decided yet.
 *
 * Markdown decides what a block IS from text that may not have arrived:
 * a table is a paragraph of pipes until its delimiter row lands, a `**`
 * is a literal asterisk until it closes, a lone `#` is a paragraph until
 * the heading text follows. Each of those renders one way, then snaps to
 * another -- traced as a 24-36px jump when a table header became a table.
 *
 * So, while streaming only:
 *  - a table appears once its header and delimiter rows are complete, and
 *    each body row appears when it is whole;
 *  - an emphasis or inline code span still being typed is shown closed;
 *  - a bare heading or list marker waits for its first word.
 * Nothing inside an open code fence is touched; that is code.
 */
export function holdUnsettledTail(text: string): string {
  if (!text || closeOpenFence(text) !== text) return text;
  const lines = text.split('\n');
  let start = lines.length - 1;
  while (start > 0 && lines[start - 1].trim() !== '') start -= 1;
  const block = lines.slice(start);
  const before = () => lines.slice(0, start).join('\n').trimEnd();

  if (block[0].trim().startsWith('|')) {
    const header = block[0];
    const delimiter = block[1]?.trim();
    const settledDelimiter =
      delimiter !== undefined &&
      block.length > 2 &&
      TABLE_DELIMITER.test(delimiter) &&
      cells(delimiter) === cells(header);
    if (!settledDelimiter) return before();
    // The last row is still arriving until another line starts after it.
    return lines.slice(0, -1).join('\n');
  }

  const lastIndex = lines.length - 1;
  let last = lines[lastIndex];
  if (/^\s{0,3}(#{1,6}|[-*+]|\d{1,3}[.)])\s*$/.test(last)) {
    lines[lastIndex] = '';
    return lines.join('\n').trimEnd();
  }
  // Inline spans on the line being typed. Code first: asterisks inside a
  // code span are not emphasis.
  const ticks = (last.match(/`/g) || []).length;
  if (ticks % 2 === 1) {
    last = /`\s*$/.test(last) ? last.replace(/`\s*$/, '').trimEnd() : `${last}\``;
  } else {
    const bare = last.replace(/`[^`]*`/g, '');
    if ((bare.match(/\*\*/g) || []).length % 2 === 1) {
      last = /\*\*\s*$/.test(last) ? last.replace(/\*\*\s*$/, '').trimEnd() : `${last.trimEnd()}**`;
    } else {
      const open = openSingleEmphasis(bare);
      if (open) last = `${last.trimEnd()}${open}`;
    }
  }
  lines[lastIndex] = last;
  return lines.join('\n');
}
