import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { FencedCode } from './CodeBlock';
import {
  composeVisual,
  localRefs,
  visualTitle,
  visualVars,
  VISUAL_VARS,
  type Scheme,
  type VisualGeneration,
  type VisualVars,
} from '../utils/visual';

/**
 * An Aside ```visual block, drawn as the page it is.
 *
 * The page is posted to `/api/visuals` and framed from there, because the
 * app's CSP would block every script in a `srcdoc` frame (see the server's
 * visuals.ts). The frame is sandboxed without `allow-same-origin`, so the
 * page runs in an opaque origin: it can draw and animate, never reach this
 * app's token, cookies or API.
 *
 * Threads are virtualized, so a block can mount many times. Heights and
 * served URLs are cached per block so a remount lands at its final size
 * instead of jumping, and does not re-post.
 */

interface Theme {
  vars: VisualVars;
  scheme: Scheme;
  key: string;
}

let current: Theme | null = null;
const listeners = new Set<() => void>();
let watching = false;

function schemeOf(color: string): Scheme {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d');
    if (ctx && color) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? 'dark' : 'light';
    }
  } catch {
    /* fall through */
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const resolved: VisualVars = {};
  for (const name of VISUAL_VARS) resolved[name] = cs.getPropertyValue(name);
  const scheme = schemeOf(cs.getPropertyValue('--background').trim());
  const vars = visualVars(resolved, scheme);
  return { vars, scheme, key: JSON.stringify(vars) + scheme };
}

function watch() {
  if (watching) return;
  watching = true;
  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const next = readTheme();
      if (next.key === current?.key) return;
      current = next;
      for (const l of listeners) l();
    });
  };
  new MutationObserver(refresh).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-fit', 'data-fit-pair', 'data-theme'],
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refresh);
}

function subscribe(fn: () => void) {
  watch();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function snapshot(): Theme {
  if (!current) current = readTheme();
  return current;
}

/*
 * Heights outlive the launch. In memory only, the first open of a chat after
 * the app started drew every visual as a 44px 'Loading visual' line, then a
 * 160px frame, then the page's real height: the answer grew by hundreds of
 * pixels while you watched, and a chat pinned to its end slid with it.
 * Stored per block and per column width, a reopened chat lands at its final
 * size. Bounded to the newest 400 blocks.
 */
const HEIGHTS_KEY = 'aside.visualHeights.v1';
const HEIGHTS_LIMIT = 400;
let heights: Map<string, number> | null = null;

function hashOf(text: string): string {
  // FNV-1a, 32-bit, twice with different seeds: a key, not a secret.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

function heightKey(html: string): string {
  const width = typeof window === 'undefined' ? 0 : Math.round(window.innerWidth / 8) * 8;
  return hashOf(html) + '@' + width;
}

function heightStore(): Map<string, number> {
  if (heights) return heights;
  heights = new Map();
  try {
    const raw = localStorage.getItem(HEIGHTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as [string, number][]) : [];
    if (Array.isArray(parsed)) for (const [k, v] of parsed) if (typeof v === 'number') heights.set(k, v);
  } catch {
    /* start empty */
  }
  return heights;
}

let saveQueued = false;
function rememberHeight(html: string, h: number): void {
  const store = heightStore();
  const key = heightKey(html);
  if (store.get(key) === h) return;
  store.delete(key);
  store.set(key, h);
  while (store.size > HEIGHTS_LIMIT) store.delete(store.keys().next().value as string);
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    try {
      localStorage.setItem(HEIGHTS_KEY, JSON.stringify([...heightStore()]));
    } catch {
      /* the in-memory copy still serves this launch */
    }
  }, 400);
}

export function knownVisualHeight(html: string): number | null {
  return heightStore().get(heightKey(html)) ?? null;
}

const urls = new Map<string, string>();

/*
 * The generation build plays once per visual, the first time it arrives
 * live on this device. Remembered across launches (bounded) so a chat
 * reopened tomorrow does not redraw what you already watched being drawn.
 */
const PLAYED_KEY = 'aside.visualGenerated.v1';
const PLAYED_LIMIT = 300;
let played: string[] | null = null;
function playedList(): string[] {
  if (played) return played;
  try {
    const raw = JSON.parse(localStorage.getItem(PLAYED_KEY) || '[]');
    played = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    played = [];
  }
  return played;
}
function hasPlayed(html: string): boolean {
  return playedList().includes(hashOf(html));
}
function markPlayed(html: string): void {
  const list = playedList();
  const key = hashOf(html);
  if (list.includes(key)) return;
  list.push(key);
  while (list.length > PLAYED_LIMIT) list.shift();
  try {
    localStorage.setItem(PLAYED_KEY, JSON.stringify(list));
  } catch {
    /* the in-memory list still prevents a replay this launch */
  }
}

/** The vendored runtime, fetched only when a live visual needs it. */
let generation: Promise<VisualGeneration> | null = null;
function loadGeneration(): Promise<VisualGeneration> {
  generation ??= Promise.all([
    import('../vendor/ui-generation/ui-generation.js?raw'),
    import('../vendor/ui-generation/ui-generation.css?raw'),
  ]).then(([js, css]) => ({ runtime: js.default, css: css.default }));
  generation.catch(() => {
    generation = null;
  });
  return generation;
}

async function toDataUrl(blobUrl: string): Promise<string> {
  const blob = await (await fetch(blobUrl)).blob();
  URL.revokeObjectURL(blobUrl);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function inlineLocalImages(html: string, sessionId?: string): Promise<string> {
  const refs = localRefs(html);
  if (!refs.length || !sessionId) return html;
  let out = html;
  for (const ref of refs) {
    try {
      const data = await toDataUrl(await api.localFileObjectUrl(sessionId, ref));
      out = out.split(ref).join(data);
    } catch {
      /* leave it; the page shows its own broken image */
    }
  }
  return out;
}

export function VisualBlock({
  html,
  streaming,
  sessionId,
  live,
}: {
  html: string;
  streaming?: boolean;
  sessionId?: string;
  /**
   * The message arrived while this thread was open (streamed in, or landed
   * in a live update), rather than being history. Only then does the page
   * play the generation build; see `markPlayed`.
   */
  live?: boolean;
}) {
  const theme = useSyncExternalStore(subscribe, snapshot);
  // Compose with the theme the block first appeared under; later changes
  // are pushed into the live frame rather than re-posting the page.
  const composedWith = useRef(theme);
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState<number | null>(() => knownVisualHeight(html));
  /*
   * Whether the page has drawn. The frame holds its final height either
   * way; the page fades into it instead of popping.
   */
  const [drawn, setDrawn] = useState(false);
  // A cached size reserves space; it is not proof this page is ready.
  const [ready, setReady] = useState(false);
  const verified = useRef(false);
  const paintFrame = useRef(0);

  /*
   * Decided once per mount, when the page is composed: a live arrival
   * nobody has watched being drawn yet gets the build.
   */
  const generate = useRef<boolean | null>(null);
  useEffect(() => {
    if (streaming) return undefined;
    let alive = true;
    const base = composedWith.current;
    if (generate.current === null) generate.current = Boolean(live) && !hasPlayed(html);
    const withBuild = generate.current;
    const key = base.key + '\n' + (withBuild ? 'gen\n' : '') + html;
    const known = urls.get(key);
    if (known) {
      setUrl(known);
      return undefined;
    }
    void (async () => {
      const source = await inlineLocalImages(html, sessionId);
      // A runtime that fails to load costs the build, never the visual.
      const build = withBuild ? await loadGeneration().catch(() => undefined) : undefined;
      // An unavailable visual service must not hold history forever.
      // On timeout the existing fenced-code fallback has a final height.
      let timeout: number | undefined;
      const res = await Promise.race([
        api.visual(composeVisual(source, base.vars, base.scheme, build)),
        new Promise<never>((_, reject) => { timeout = window.setTimeout(() => reject(new Error('visual preparation timed out')), 8000); }),
      ]).finally(() => window.clearTimeout(timeout));
      urls.set(key, res.url);
      if (build) markPlayed(html);
      if (alive) setUrl(res.url);
    })().catch(() => {
      if (alive) setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [html, streaming, sessionId, live]);

  /*
   * A page reports its height while it is still being parsed, so the first
   * reports are of half a page: measured here, 160px for a block that ends
   * at 1080px. Applying them shrank a correctly sized frame and grew it
   * back, a 900px slide on every relaunch. Reports before the frame's load
   * are provisional. With a remembered height the frame keeps it until the
   * page has had its own settle window (its script reports again at 300ms
   * and 1200ms after load); without one, the load-time height lands at once
   * while the frame is still invisible. Only later changes, such as a tab
   * inside the visual, ease.
   */
  const loadedAt = useRef<number | null>(null);
  const latest = useRef<number | null>(null);
  const settleTimer = useRef<number | null>(null);
  const apply = (h: number | null) => {
    if (h === null) return;
    rememberHeight(html, h);
    setHeight(h);
  };
  const applyAfterSettle = () => {
    if (settleTimer.current !== null || loadedAt.current === null) return;
    const wait = Math.max(0, loadedAt.current + 1300 - performance.now());
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      verified.current = true;
      apply(latest.current);
      // Commit the first corrected size with transitions OFF. Only once
      // that geometry has painted may the page fade in and animate edits.
      paintFrame.current = requestAnimationFrame(() => {
        paintFrame.current = requestAnimationFrame(() => { setReady(true); setDrawn(true); });
      });
    }, wait);
  };
  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
      if (paintFrame.current) cancelAnimationFrame(paintFrame.current);
    },
    [],
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as { type?: string; h?: unknown };
      if (m?.type !== 'aside-visual:h' || typeof m.h !== 'number' || !isFinite(m.h)) return;
      latest.current = Math.max(24, Math.min(6000, Math.round(m.h)));
      if (loadedAt.current === null) return;
      if (!verified.current) {
        applyAfterSettle();
        return;
      }
      apply(latest.current);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apply reads refs
  }, [html]);

  const onFrameLoad = () => {
    loadedAt.current = performance.now();
    verified.current = false;
    setReady(false);
    setDrawn(false);
    // Both cached and new frames wait for the page's 1200ms final report.
    // The 1300ms settle timer bounds a page that never reports at all.
    applyAfterSettle();
  };

  const pushTheme = () => {
    if (theme.key === composedWith.current.key) return;
    frame.current?.contentWindow?.postMessage(
      { type: 'aside-visual:theme', vars: theme.vars, scheme: theme.scheme },
      '*',
    );
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the theme changes
  useEffect(pushTheme, [theme.key]);

  if (failed) return <FencedCode code={html} lang="html" label="visual" />;

  const title = visualTitle(html);
  if (streaming || !url) {
    return (
      <div
        className="md-visual md-visual-pending"
        data-sized={height ? 'true' : undefined}
        style={height ? { height } : undefined}
        role="status"
      >
        <span>{streaming ? 'Drawing visual' : 'Loading visual'}</span>
      </div>
    );
  }
  return (
    <div className="md-visual" data-sized={height ? 'true' : undefined} data-ready={ready ? 'true' : undefined}>
      <iframe
        data-drawn={drawn ? 'true' : undefined}
        ref={frame}
        src={url}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={() => {
          pushTheme();
          onFrameLoad();

        }}
        style={{ height: height ?? 160, colorScheme: theme.scheme }}
      />
    </div>
  );
}
