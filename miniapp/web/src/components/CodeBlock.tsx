/**
 * A fenced code block, syntax highlighted once Shiki has loaded.
 *
 * Renders plain monospace text (this app's existing `.md pre`/`.md code`
 * styling, unchanged) until the highlighter is ready -- never a spinner
 * inside a code block, and never a layout jump: the highlighted version
 * replaces the plain one in place once it exists. See `utils/highlighter.ts`
 * for why loading is lazy and scoped to eight languages.
 */
import { useEffect, useState } from 'react';
import {
  getReadyHighlighter,
  highlightToHtml,
  onHighlighterReady,
} from '../utils/highlighter';
import { colorScheme, onThemeChanged } from '../telegram';

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  // Re-render exactly once, when the shared highlighter finishes loading --
  // not a poll, not a per-block load. Multiple code blocks on screen all
  // share the one `warmHighlighter()` call `Markdown.tsx` makes after first
  // paint.
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (getReadyHighlighter()) return undefined;
    return onHighlighterReady(() => forceUpdate((n) => n + 1));
  }, []);

  // Follows THIS app's own theme switch (telegram.ts), not
  // `prefers-color-scheme` independently -- a code block cannot disagree
  // with the rest of the app about which theme is active.
  const [dark, setDark] = useState(() => colorScheme() === 'dark');
  useEffect(() => onThemeChanged(() => setDark(colorScheme() === 'dark')), []);

  const html = highlightToHtml(code, lang, dark);

  if (!html) {
    return (
      <pre className="md-pre">
        <code className="md-code">{code}</code>
      </pre>
    );
  }

  // Shiki's own HTML carries a real `<pre class="shiki">`; this app's CSS
  // neutralises its baked-in background (see `.md pre.shiki` in
  // components.css) so the surrounding card chrome -- border, padding,
  // font -- stays this app's own tokens, and only the per-token colours
  // (which come from the theme JSON, not from a component) are Shiki's.
  return <div className="md-pre-shiki" dangerouslySetInnerHTML={{ __html: html }} />;
}
