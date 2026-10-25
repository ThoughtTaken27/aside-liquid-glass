import { CitationBadges } from './Citations';
import {
  createContext,
  memo,
  useContext,
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
import { FencedCode } from './CodeBlock';
import { VisualBlock } from './VisualBlock';
import { openImage } from './ImageLightbox';
import { normalizeLang } from '../utils/highlighter';
import { warmLanguages } from '../utils/highlightClient';
import {
  citationIndexFrom,
  dropPartialCitation,
  transformCitations,
  type CitationMark,
} from '../utils/citations';
import { localImagePath } from '../utils/images';
import { closeOpenFence, fenceLanguages, holdUnsettledTail } from '../utils/markdown';
import type { CitationSource } from '../types';
import { rehypeStreamWords, type StreamWordState } from '../utils/streamWords';

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
 * What a ```visual block needs from its message. A context rather than a
 * dependency of the `components` map, so the end of streaming does not
 * remount every code block and image in the answer.
 */
const VisualContext = createContext<{ streaming?: boolean; sessionId?: string; live?: boolean }>({});

function VisualSlot({ html }: { html: string }) {
  const { streaming, sessionId, live } = useContext(VisualContext);
  return <VisualBlock html={html} streaming={streaming} sessionId={sessionId} live={live} />;
}

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
  live,
}: {
  text: string;
  streaming?: boolean;
  sources?: Record<string, CitationSource>;
  /** Needed to rewrite local image paths onto that session's file route. */
  sessionId?: string;
  onOpenCitation?: (mark: CitationMark) => void;
  /** Arrived while the thread was open; visuals play their build. */
  live?: boolean;
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
  // Word reveal bookkeeping for this answer only; see streamWords.ts.
  const streamWords = useRef<StreamWordState>({ block: -1, shown: 0 });
  const rehypePlugins = useMemo(
    () => (streaming ? [[rehypeStreamWords, streamWords.current] as const] : []),
    [streaming],
  );
  const sourceKeys = useMemo(
    () => Object.keys(sources ?? {}).sort().join('\n'),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key set is the dep, deliberately, not the identity
    [sources],
  );
  const { markdown, marks, openFence } = useMemo(() => {
    const raw = streaming ? holdUnsettledTail(dropPartialCitation(text)) : text;
    const body = streaming ? closeOpenFence(raw) : text;
    const done = transformCitations(body, (ref) => Boolean(sourcesRef.current?.[ref]));
    return { ...done, openFence: body !== raw };
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
  /*
   * Where the fence that is still being typed ends, or -1. Read by the
   * code renderer through a ref so the components map (and every code
   * block and link it owns) is not rebuilt on each chunk.
   */
  const openFenceEnd = useRef(-1);
  openFenceEnd.current = openFence ? markdown.length : -1;

  const fenceLangs = useMemo(
    () => fenceLanguages(markdown).filter((lang) => lang !== 'visual'),
    [markdown],
  );

  // After first paint, never at module scope: importing this component
  // costs nothing until a message with code in it has rendered.
  useEffect(() => {
    if (!fenceLangs.length) return undefined;
    const id = window.setTimeout(() => warmLanguages(fenceLangs), 0);
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
      // `FencedCode` renders its own block, so a tagged fence's `pre`
      // wrapper is unwrapped rather than nested. Inline code (no fence)
      // is untouched.
      pre: ({ children }: { children?: React.ReactNode }) => {
        const child = isValidElement(children)
          ? children as ReactElement<{ className?: string; children?: React.ReactNode }>
          : null;
        // A fence without a language still needs the same chrome as one
        // with a tag. Tagged fences are owned by `code` below; this branch
        // only runs when that component was not given a language class.
        if (child && !/language-/.test(child.props.className || '')) {
          // Keep the trailing newline react-markdown hands us. Stripping it
          // here changed the block's text, which is what a selection copies.
          const codeText = String(child.props.children ?? '');
          return <FencedCode code={codeText} />;
        }
        return <>{children}</>;
      },
      code: ({ className, children, node }: { className?: string; children?: React.ReactNode; node?: { position?: { end?: { offset?: number } } } }) => {
        const match = /language-(\S+)/.exec(className || '');
        const codeText = String(children ?? '').replace(/\n$/, '');
        if (!match) return <code className="md-inline-code">{children}</code>;
        // Aside's inline visuals: a whole HTML page, drawn rather than listed.
        if (match[1].toLowerCase() === 'visual') return <VisualSlot html={codeText} />;
        const lang = normalizeLang(match[1]);
        // Unknown grammars still get the chip and the copy button.
        // Highlighting is a convenience; being able to take the code is the job.
        const end = node?.position?.end?.offset ?? -1;
        const open = openFenceEnd.current >= 0 && end >= openFenceEnd.current - 4;
        return <FencedCode code={codeText} lang={lang} label={match[1]} open={open} />;
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
        return mark ? (
          <CitationBadges mark={mark} sources={sourcesRef.current ?? {}} onOpen={onOpenCitation} />
        ) : null;
      },
    }),
    [imageRenderer, marks, onOpenCitation],
  );

  const visualContext = useMemo(() => ({ streaming, sessionId, live }), [streaming, sessionId, live]);

  return (
    <div className="md">
      <VisualContext.Provider value={visualContext}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unified's plugin tuple typing is not worth fighting here
        rehypePlugins={rehypePlugins as any}
        urlTransform={urlTransform}
        components={components}
      >
        {markdown}
      </ReactMarkdown>
      </VisualContext.Provider>
      {streaming ? <span className="caret" aria-hidden /> : null}
    </div>
  );
});
