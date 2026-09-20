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
