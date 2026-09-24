/**
 * A fenced code block, syntax highlighted once Shiki has loaded.
 *
 * Renders plain monospace text (this app's existing `.md pre`/`.md code`
 * styling, unchanged) until the highlighter is ready -- never a spinner
 * inside a code block, and never a layout jump: the highlighted version
 * replaces the plain one in place once it exists. See `utils/highlighter.ts`
 * for why loading is lazy and scoped to eight languages.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, CopyIcon } from './Icons';
import {
  getReadyHighlighter,
  highlightToHtml,
  onHighlighterReady,
} from '../utils/highlighter';
import { colorScheme, haptic, onThemeChanged } from '../telegram';
import { copyText } from '../utils/clipboard';

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

/**
 * The chrome around a fence: a language chip and a copy control.
 *
 * Both sit outside the scrolling code so a long line does not carry the
 * button away with it. The button keeps a fixed width across Copy / Copied
 * / Failed -- a label that grows on success shoves the chip, and the chip
 * is the thing a reader uses to recognise the block.
 */
export function FencedCode({
  code,
  lang,
  label,
}: {
  code: string;
  /** Highlighter language, when this app knows the grammar. */
  lang?: string | null;
  /** Fence tag as written (`ts`, `rust`), shown even when we cannot tint it. */
  label?: string;
}) {
  const shown = (label || lang || '').replace(/[^\w.+-]/g, '').toLowerCase();
  return (
    <div className="code-fence">
      <div className="code-fence-bar">
        {shown ? <span className="code-fence-lang">{shown}</span> : <span />}
        <FenceCopy text={code} />
      </div>
      {lang ? (
        <CodeBlock code={code} lang={lang} />
      ) : (
        <pre className="md-pre">
          <code className="md-code">{code}</code>
        </pre>
      )}
    </div>
  );
}

function FenceCopy({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    const ok = await copyText(text);
    haptic(ok ? 'light' : 'error');
    setState(ok ? 'done' : 'failed');
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1600);
  };

  const label = state === 'done' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy';

  return (
    <button
      type="button"
      className={`code-fence-copy${state === 'done' ? ' is-done' : ''}${state === 'failed' ? ' is-failed' : ''}`}
      onClick={() => void copy()}
      aria-label={state === 'idle' ? 'Copy code' : label}
    >
      {state === 'done' ? (
        <Check size={13} strokeWidth={2} />
      ) : (
        <CopyIcon size={13} strokeWidth={1.75} />
      )}
      <span>{label}</span>
    </button>
  );
}
