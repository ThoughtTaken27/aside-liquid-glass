import {
  memo,
  isValidElement,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { CodeBlock } from './CodeBlock';
import { openImage } from './ImageLightbox';
import { normalizeLang, warmHighlighter } from '../utils/highlighter';
import {
  citationIndexFrom,
  dropPartialCitation,
  transformCitations,
  type CitationMark,
} from '../utils/citations';
import { localImagePath } from '../utils/images';
import { closeOpenFence, fenceLanguages } from '../utils/markdown';
import type { CitationSource } from '../types';

/**
 * An image inside rendered markdown.
 *
 * A src naming a local absolute path is pointed at the authenticated file
 * route -- see `localImagePath` for why only absolute paths qualify.
 * Anything the route refuses (outside the allowed roots, not an image, too
 * big) or that simply is not there any more collapses to a small caption
 * rather than the browser's broken-image icon, which is what the owner
 * was actually looking at.
 *
 * `loading="lazy"` matters here: these are individual HTTP fetches rather
 * than data URIs inlined in the thread payload, so an answer with a dozen
 * screenshots costs nothing until they scroll into view. The transcript
 * image budgets (per-image, per-step, per-thread) are about payload size
 * and do not apply; the route's own 10 MB cap does.
 */
function MarkdownImage({
  src,
  alt,
  sessionId,
}: {
  src: string;
  alt: string;
  sessionId?: string;
}) {
  const local = localImagePath(src);
  // Local bytes are fetched with credentials, then shown as a blob: URL so
  // the credential never appears in the DOM or a URL string.
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const mounted = useRef(true);
  const activeObjectUrl = useRef<string | null>(null);
  const viewedObjectUrls = useRef(new Set<string>());
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    let alive = true;
    let url = '';
    setObjectUrl(null);
    setLoadFailed(false);
    if (local && sessionId) {
      void api
        .localFileObjectUrl(sessionId, local)
        .then((u) => {
          if (!alive) {
            URL.revokeObjectURL(u);
            return;
          }
          url = u;
          activeObjectUrl.current = u;
          setObjectUrl(u);
        })
        .catch(() => {
          if (alive) setLoadFailed(true);
        });
    }
    return () => {
      alive = false;
      if (activeObjectUrl.current === url) activeObjectUrl.current = null;
      // The global lightbox can outlive this virtualized thread row. Its
      // release callback owns the URL until the modal closes.
      if (url && !viewedObjectUrls.current.has(url)) URL.revokeObjectURL(url);
    };
  }, [local, sessionId]);
  const resolved = local ? (objectUrl ?? '') : src;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [resolved]);

  if (local && (!sessionId || loadFailed)) {
    return (
      <span className="image-unavailable">
        {alt ? `Image unavailable: ${alt}` : 'Image unavailable'}
      </span>
    );
  }
  // Do not flash a false "unavailable" error while the authenticated fetch
  // is still in flight. The image appears once its blob URL is ready.
  if (local && !objectUrl) return null;
  if (!resolved || failed) {
    return (
      <span className="image-unavailable">
        {alt ? `Image unavailable: ${alt}` : 'Image unavailable'}
      </span>
    );
  }
  /*
   * A button, not a bare image.
   *
   * A screenshot the agent produced is rendered at thread width, which on a
   * phone is far too small to read one. Tapping it did nothing at all, so
   * the only way to see the detail was to go to the Mac. It opens the
   * pinch-zoom viewer now; keeping it a real `<button>` means the keyboard
   * and screen readers get the same affordance the thumb does.
   */
  return (
    <button
      type="button"
      className="md-image-button"
      aria-label={alt ? `View image: ${alt}` : 'View image'}
      onClick={() => {
        if (!local) {
          openImage({ src: resolved, alt });
          return;
        }
        const held = resolved;
        viewedObjectUrls.current.add(held);
        openImage({
          src: held,
          alt,
          onClose: () => {
            viewedObjectUrls.current.delete(held);
            if (!mounted.current || activeObjectUrl.current !== held) {
              URL.revokeObjectURL(held);
            }
          },
        });
      }}
    >
      <img
        className="md-image"
        src={resolved}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
      />
    </button>
  );
}

/**
 * The plugin list, hoisted.
 *
 * Written inline (`remarkPlugins={[remarkGfm]}`) this is a new array on
 * every render, and react-markdown treats new plugin identities as new
 * configuration. The plugins never change, so they are a module constant.
 */
const REMARK_PLUGINS = [remarkGfm];

/**
 * Assistant text as clean markdown.
 *
 * react-markdown does not render raw HTML unless rehype-raw is added, which
 * it deliberately is not -- transcript text is untrusted enough (tool output,
 * quoted web pages) that giving it HTML would be a mistake. That is also why
 * `<citation>` tags cannot simply be left in place: they arrive as literal
 * text. They are rewritten to `cite:` links first and drawn here as
 * superscript chips.
 *
 * `streaming` renders a buffer that is still arriving: the only guard it
 * needs is a temporary closing code fence, so the tail of a message does not
 * flicker in and out of a code block while it types.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming,
  sources,
  sessionId,
  onOpenCitation,
}: {
  text: string;
  streaming?: boolean;
  sources?: Record<string, CitationSource>;
  /** Needed to rewrite local image paths onto that session's file route. */
  sessionId?: string;
  onOpenCitation?: (mark: CitationMark) => void;
}) {
  /*
   * The citation transform only asks which source refs EXIST, so it is
   * keyed on the key set rather than the record identity. `thread_meta`
   * hands this component a fresh `sources` object on every tick with the
   * same keys in it; depending on the identity would re-parse every
   * visible answer and mint a new `marks` array -- and a new `components`
   * map below -- each time, remounting every code block and link.
   */
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const sourceKeys = useMemo(
    () => Object.keys(sources ?? {}).sort().join('\n'),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key set is the dep, deliberately, not the identity
    [sources],
  );
  const { markdown, marks } = useMemo(() => {
    const body = streaming
      ? closeOpenFence(dropPartialCitation(text))
      : text;
    return transformCitations(body, (ref) => Boolean(sourcesRef.current?.[ref]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the note above: key set, not identity
  }, [text, streaming, sourceKeys]);

  /*
   * The languages this particular message actually contains.
   *
   * Scanning the source for fence tags is far cheaper than downloading a
   * grammar nobody asked for. A message with no fences -- the overwhelming
   * majority -- yields an empty list and costs the highlighter nothing at
   * all, which is the point: the previous version warmed every grammar and
   * the WASM engine from every mounted message.
   */
  const fenceLangs = useMemo(() => fenceLanguages(markdown), [markdown]);

  // After first paint, never at module scope: importing this component
  // costs nothing until a message with code in it has rendered.
  useEffect(() => {
    if (!fenceLangs.length) return undefined;
    const id = window.setTimeout(() => warmHighlighter(fenceLangs), 0);
    return () => window.clearTimeout(id);
  }, [fenceLangs]);

  const imageRenderer = useMemo(
    () =>
      function MarkdownImageSlot({ src, alt }: { src?: unknown; alt?: unknown }) {
        return (
          <MarkdownImage
            src={typeof src === 'string' ? src : ''}
            alt={typeof alt === 'string' ? alt : ''}
            sessionId={sessionId}
          />
        );
      },
    [sessionId],
  );

  /*
   * Stable on purpose. react-markdown uses whatever is in this map AS the
   * element type, so an arrow function written inline here is a new type on
   * every render -- which unmounts and remounts every image (losing the
   * "this one failed" state and re-requesting the file), every code block
   * and every link, each time the streaming answer ticks or a `thread_meta`
   * event hands down a fresh `sources` identity. Memoised, the map only
   * changes when the text -- and therefore the marks -- actually changed.
   */
  const urlTransform = useCallback(
    // react-markdown drops any href outside its safe-protocol list, so
    // `cite:` links arrive with an empty href and render as ordinary
    // text. Only our own scheme is let past; everything else still goes
    // through the default sanitiser, which is what blocks `javascript:`.
    // A local absolute path is let past for `src` only. The default
    // transform drops `file:` (not a safe protocol) and would otherwise
    // hand the image renderer an empty src, so the rewrite would never
    // get a chance to run. Scoping it to `src` keeps `file:` links out
    // of `href`, where nothing wants them.
    (url: string, key?: string) => {
      if (url.startsWith('cite:')) return url;
      if (key === 'src' && localImagePath(url)) return url;
      return defaultUrlTransform(url);
    },
    [],
  );

  const components = useMemo(
    () => ({
      img: imageRenderer,
      // `CodeBlock` renders its OWN `<pre>` (plain, or Shiki's), so the
      // default `pre` wrapper is passed through unwrapped here rather
      // than nesting a second `<pre>` around it. Inline code (no fence,
      // no language) is untouched -- rendered exactly as before.
      pre: ({ children }: { children?: React.ReactNode }) => {
        const child = isValidElement(children)
          ? children as ReactElement<{ className?: string; children?: React.ReactNode }>
          : null;
        // A fence without a language still needs block semantics and scrolling.
        if (child && !/language-/.test(child.props.className || '')) {
          return <pre className="md-pre"><code>{child.props.children}</code></pre>;
        }
        return <>{children}</>;
      },
      code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
        const match = /language-(\S+)/.exec(className || '');
        const codeText = String(children ?? '').replace(/\n$/, '');
        if (!match) return <code className="md-inline-code">{children}</code>;
        const lang = normalizeLang(match[1]);
        if (!lang) {
          return (
            <pre className="md-pre">
              <code className="md-code">{codeText}</code>
            </pre>
          );
        }
        return <CodeBlock code={codeText} lang={lang} />;
      },
      a: ({ node: _node, href, children, ...props }: { node?: unknown; href?: string; children?: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
        const index = citationIndexFrom(String(href || ''));
        if (index === null) {
          return (
            <a {...props} href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        }
        const mark = marks[index - 1];
        return (
          <button
            type="button"
            className="cite-chip"
            aria-label={`Open source ${index}`}
            onClick={() => mark && onOpenCitation?.(mark)}
          >
            {children}
          </button>
        );
      },
    }),
    [imageRenderer, marks, onOpenCitation],
  );

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        urlTransform={urlTransform}
        components={components}
      >
        {markdown}
      </ReactMarkdown>
      {streaming ? <span className="caret" aria-hidden /> : null}
    </div>
  );
});
