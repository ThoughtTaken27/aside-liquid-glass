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
import { CopyIcon } from './Icons';
import { IconMorph, RollText } from './Affect';
import { cachedHighlight, onHighlight, requestHighlight } from '../utils/highlightClient';
import { colorScheme, haptic, onThemeChanged } from '../telegram';
import { copyText } from '../utils/clipboard';

export function CodeBlock({ code, lang, open = false }: { code: string; lang: string; open?: boolean }) {
  // Re-render when a highlight lands. The work itself happens in a worker
  // (highlightClient), so asking costs this frame nothing.
  const [, forceUpdate] = useState(0);
  useEffect(() => onHighlight(() => forceUpdate((n) => n + 1)), []);

  // Follows THIS app's own theme switch (telegram.ts), not
  // `prefers-color-scheme` independently -- a code block cannot disagree
  // with the rest of the app about which theme is active.
  const [dark, setDark] = useState(() => colorScheme() === 'dark');
  useEffect(() => onThemeChanged(() => setDark(colorScheme() === 'dark')), []);

  const html = cachedHighlight(code, lang, dark);
  // A fence still being typed stays plain: colouring every chunk would
  // flicker between plain and tinted as each new line arrived. It colours
  // once, when its closing fence lands.
  useEffect(() => {
    if (!html && !open) requestHighlight(code, lang, dark);
  }, [html, open, code, lang, dark]);

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
  open,
}: {
  code: string;
  /** Highlighter language, when this app knows the grammar. */
  lang?: string | null;
  /** Fence tag as written (`ts`, `rust`), shown even when we cannot tint it. */
  label?: string;
  /** Still being streamed (no closing fence yet). */
  open?: boolean;
}) {
  const shown = (label || lang || '').replace(/[^\w.+-]/g, '').toLowerCase();
  return (
    <div className="code-fence">
      <div className="code-fence-bar">
        {shown ? <span className="code-fence-lang">{shown}</span> : <span />}
        <FenceCopy text={code} />
      </div>
      {lang ? (
        <CodeBlock code={code} lang={lang} open={open} />
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
      <IconMorph on={state === 'done'} size={13} idle={<CopyIcon size={13} strokeWidth={1.75} />} />
      <RollText text={label} />
    </button>
  );
}
