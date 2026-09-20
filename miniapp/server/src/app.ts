/**
 * Fastify app: auth spine, read API, write API, and the SPA host.
 *
 * Everything under /api except /api/auth and /api/health requires a bearer
 * JWT in the Authorization header or the HttpOnly session cookie; the
 * WebSocket authenticates the same way via its first `{type:"auth"}` frame
 * or the cookie on the upgrade. Tokens in query strings are refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import {
  EFFORT_LABELS,
  EFFORT_LEVELS,
  EFFORT_MENU,
  type MiniappConfig,
} from './config.js';
import {
  FacadeCache,
  peekDefaultModel,
  fetchRoutines,
  fetchSession,
  markSessionRead,
  archiveSession,
} from './facade.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  buildCatalog,
  contextWindowFor,
  modelLabel,
  readProviderIds,
} from './catalog.js';
import { readDesktopState, type DesktopModelRef } from './desktop.js';
import { TranscribeError, transcribeAudio } from './transcribe.js';
import { WhisperServer } from './whisperserver.js';
import { PairingCodeStore } from './pair.js';
import { StateDb, isFullAccess, isSuspended } from './statedb.js';
import { SettingsStore, defaultSettingsPath, resolveNewSessionModel } from './settings.js';
import { stripAgentDirectives, withPreamble, withReminder } from './preamble.js';
import {
  answerMessage,
  pendingNativeQuestion,
  recoveryPrompt,
} from './questions.js';
import { ThreadStore, buildParentView, fileStamp } from './threadstore.js';
import { SubagentIndex, toChildSession } from './subagents.js';
import {
  MAX_ARTIFACT_BYTES,
  isArtifactGroup,
  artifactContentType,
  listArtifacts,
  resolveArtifact,
  type ArtifactGroup,
} from './artifacts.js';
import {
  MAX_LOCAL_IMAGE_BYTES,
  localFileRoots,
  localFileStatus,
  resolveLocalFile,
} from './localfiles.js';
import {
  PERMISSION_MENU,
  applyPermission,
  isPermissionMode,
} from './permission.js';
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  UploadError,
  defaultUploadsDir,
  promptWithAttachments,
  saveUpload,
  sweepUploadDirectory,
  type SavedUpload,
} from './uploads.js';
import {
  InitDataError,
  MAX_AUTH_AGE_SECONDS,
  validateInitData,
} from './initdata.js';
import {
  LONG_TOKEN_TTL_SECONDS,
  REFRESH_BELOW_SECONDS,
  TokenError,
  bearerFrom,
  cookieFrom,
  mintToken,
  secondsRemaining,
  sessionCookie,
  verifyToken,
} from './auth.js';
import { SuggestClient } from './suggest.js';
import { VisitStore } from './visits.js';
import { buildOmnibox, buildZeroState } from './omnibox.js';
import { asUrl } from './urlguess.js';
import { HistoryReader } from './history.js';
import { parseTranscript, transcriptIsLive } from './transcript.js';
import { buildThread } from './thread.js';
import { readHistory } from './jsonl.js';
import {
  firstUserText,
  isMobileSession,
  isPlaceholderTitle,
  isValidSessionId,
  listSessionRows,
  resolveSessionDir,
  sessionMsgFile,
  titleFromTranscript,
  waitForTranscript,
} from './sessions.js';
import { SoftConfirmStore, defaultSoftConfirmPath } from './softconfirm.js';
import { TurnRunner } from './exec.js';
import { WatcherRegistry } from './watcher.js';
import { attachWebSocket } from './ws.js';
import { OwnedTurns } from './ownedturns.js';
import { ActiveViewers } from './viewers.js';
import { Notifier, LONG_RUNNING_THRESHOLD_MS } from './notify.js';
import type { ThreadItem } from './thread.js';
import {
  BrowserError,
  CaptureGate,
  captureTab,
  closeTab as closeBrowserTab,
  listTabs,
  openNewTab,
  snapshotTab,
} from './browser.js';
import { defaultAsideRoot } from './config.js';
import {
  buildMemoryTree,
  readMemoryFile,
  resolveMemoryFile,
} from './memorybrowser.js';
import { searchTranscripts } from './search.js';
import { applySessionModel } from './sessionmodel.js';

const MAX_MESSAGE_CHARS = 32_000;
const DEFAULT_ENTRY_LIMIT = 800;

/** Ceiling on a transcript read whole into memory. See the /messages route. */
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

/** Upload receipts older than this are dropped, with their bytes. */
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;
const UPLOAD_SWEEP_MS = 30 * 60 * 1000;
/** Hard ceiling on live receipts, so a flood cannot grow the map forever. */
const MAX_UPLOAD_RECEIPTS = 200;

/**
 * Strip the query string out of a logged URL.
 *
 * Query strings are still redacted even though `?token=` is refused now:
 * Fastify's default `req` serializer logs `req.url` verbatim, which used
 * to write a live bearer token into miniapp.log in cleartext on every
 * download carrying one. Observed directly; the path is all the log needs.
 */
/**
 * iOS launch screens.
 *
 * Without these, tapping the home-screen icon shows a white rectangle
 * until the bundle has parsed and React has painted. iOS will not derive
 * one from the manifest's `background_color` the way Android does; the
 * only way to control that first frame is to hand it a matching image per
 * device, selected by media query.
 *
 * Portrait only, because the manifest locks the app to portrait, so the
 * landscape variants could never be shown. Generated by
 * `scripts/gen-splash.mjs` -- regenerate rather than hand-editing, and add
 * a row here when Apple ships a new display size.
 */
const APPLE_LAUNCH_SCREENS: string[] = (
  [
    [440, 956, 3, 'iphone-16-pro-max'],
    [402, 874, 3, 'iphone-16-pro'],
    [430, 932, 3, 'iphone-15-pro-max'],
    [393, 852, 3, 'iphone-15-pro'],
    [428, 926, 3, 'iphone-13-pro-max'],
    [390, 844, 3, 'iphone-13-pro'],
    [375, 812, 3, 'iphone-x'],
    [414, 896, 3, 'iphone-xs-max'],
    [414, 896, 2, 'iphone-xr'],
    [375, 667, 2, 'iphone-se'],
    [414, 736, 3, 'iphone-8-plus'],
    [320, 568, 2, 'iphone-se1'],
  ] as [number, number, number, string][]
).map(
  ([w, h, ratio, name]) =>
    `  <link rel="apple-touch-startup-image" media="(device-width: ${w}px) and ` +
    `(device-height: ${h}px) and (-webkit-device-pixel-ratio: ${ratio}) and ` +
    `(orientation: portrait)" href="/splash/${name}.png" />`,
);

export function redactedRequest(request: {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  ip?: string;
  socket?: { remotePort?: number };
}): Record<string, unknown> {
  const raw = String(request.url ?? '');
  const cut = raw.indexOf('?');
  return {
    method: request.method,
    url: cut === -1 ? raw : `${raw.slice(0, cut)}?<redacted>`,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

export interface BuiltServer {
  app: FastifyInstance;
  runner: TurnRunner;
  watchers: WatcherRegistry;
  subagents: SubagentIndex;
}

export interface BuildOptions {
  /** Absolute path to the built SPA; static hosting is skipped if absent. */
  webDist?: string;
  jwtSecret: string;
  logger?: boolean;
  /**
   * The current public tunnel URL, read lazily.
   *
   * A function rather than a value because a quick tunnel rotates its
   * hostname while the server runs, so a snapshot taken at boot would be
   * wrong within the hour. The settings screen shows it; nothing depends
   * on it.
   */
  publicUrl?: () => string | null;
  /** Shown on the settings screen, so the owner can tell builds apart. */
  version?: string;
  /**
   * Where the loopback-only pairing listener lives, for the pointer this
   * app serves at `/pair`. Defaults to one above the app's own port.
   */
  pairPort?: number;
  /**
   * Stable tailnet hostname for this Mac, read lazily.
   *
   * Unlike `publicUrl` this one does not rotate, which is the entire reason
   * an installed app can exist: a home-screen icon bakes its URL at install
   * time and has no way to learn a new one.
   */
  tailnetHost?: () => string | null;
  /**
   * Shared one-time enrollment codes, issued by the loopback pairing page
   * and spent here. Injected so tests can issue and spend against the same
   * store; production wires one store through both listeners in index.ts.
   */
  pairingCodes?: PairingCodeStore;
}

export async function buildServer(
  config: MiniappConfig,
  opts: BuildOptions,
): Promise<BuiltServer> {
  const app = Fastify({
    logger: opts.logger
      ? { serializers: { req: redactedRequest } }
      : (opts.logger ?? false),
    /**
     * `trustProxy` is deliberately OFF.
     *
     * It used to be `true`, which made `request.ip` the leftmost
     * `X-Forwarded-For` entry -- a header any client past the tunnel can
     * write. Since @fastify/rate-limit keys its buckets on `request.ip`,
     * that turned every limit in this file into a no-op: 30 `/api/auth`
     * attempts with a rotating `X-Forwarded-For` drew zero 429s. Verified
     * against this server, and pinned by a test.
     *
     * With it off, `request.ip` is the real socket peer -- the cloudflared
     * process on loopback -- so every request shares one bucket. For a
     * single-owner app that is the correct granularity anyway, and it is
     * the only one an attacker cannot choose for themselves.
     */
    trustProxy: false,
  });
  const startedAt = Date.now();

  // Read-only reader for the daemon's session table: the list, and each
  // session's permission mode, final-confirm flag, pinned model and status.
  // Declared before the runner because the runner's suspend watchdog reads
  // status through it.
  const stateDb = new StateDb(config.stateDbPath);
  // `node:sqlite` has a noticeable one-time import cost. Pay it while the
  // service is starting, before parallel home/thread requests can all queue
  // behind that import on the event loop.
  await stateDb.warm();

  const runner = new TurnRunner({
    asideCli: config.asideCli,
    sessionsDir: config.sessionsDir,
    execTimeoutMs: config.execTimeoutMs,
    defaultModel: config.defaultModel,
    defaultEffort: config.defaultEffort,
    modelAliases: config.modelAliases,
    grantFullAccess: process.env.MINIAPP_GRANT_FULL_ACCESS === '1',
    /**
     * The suspend watchdog's eyes. A session blocked on a native question
     * tool goes to `status=suspended` and the driver we spawned would
     * otherwise hang forever waiting for a desktop-only answer.
     *
     * The cache is invalidated first because `StateDb.read` holds a row for
     * 5s and the watchdog's entire job is to notice a transition promptly.
     */
    readStatus: async (sessionId) => {
      stateDb.invalidate(sessionId);
      return (await stateDb.read(sessionId)).status;
    },
  });
  const watchers = new WatcherRegistry();
  // Defaults for sessions this app creates, in this app's own store. See
  // settings.ts for why nothing here writes Aside's global settings.
  const settings = new SettingsStore(
    defaultSettingsPath(config.miniapp.stateDir),
  );
  // "Confirm before acting" for sessions driven from a phone. It is NOT
  // the daemon's `finalConfirm`: that one mandates the native confirmation
  // tool, which is the thing that bricks a mobile session. See
  // softconfirm.ts.
  const softConfirm = new SoftConfirmStore(
    defaultSoftConfirmPath(config.miniapp.stateDir),
  );
  // Every facade call spawns the CLI binary, so reads go through a
  // short-TTL, in-flight-coalescing cache rather than straight to it.
  const facade = new FacadeCache({ asideCli: config.asideCli });
  // Threads are built from the transcript on disk, so a rebuild is a file
  // read rather than a process spawn -- cheap enough to redo per write.
  const threads = new ThreadStore((file) =>
    fileStamp(file, (p) => fs.statSync(p, { throwIfNoEntry: false }) || undefined),
  );
  const uploadsDir = defaultUploadsDir();

  // The catalog USED to be built once, on the assumption that its inputs
  // could not change while we run. That assumption was wrong: the desktop
  // app rewrites ~/.aside/u/0/models.json whenever a provider or model is
  // edited, so a catalog frozen at boot goes stale the moment the owner
  // touches their model list -- which is exactly how the phone ended up
  // offering models that no longer existed and hiding ones that did.
  //
  // Rebuilding is two small cached-by-the-OS file reads, but it is on the
  // thread-render path, so it is memoised for a few seconds. Short enough
  // that a change in the desktop shows up on the phone almost at once, long
  // enough that a burst of requests does not re-read per item.
  const CATALOG_TTL_MS = 5_000;
  let catalogCache: ReturnType<typeof buildCatalog> = [];
  let catalogAt = 0;
  let catalogDefault: DesktopModelRef | null = null;

  function currentCatalog(): ReturnType<typeof buildCatalog> {
    const now = Date.now();
    if (now - catalogAt < CATALOG_TTL_MS && catalogCache.length) {
      return catalogCache;
    }
    const desktop = readDesktopState(config.sessionsDir);
    catalogDefault = desktop.defaultModel;
    catalogCache = buildCatalog(
      readProviderIds(config.credentialsPath),
      config.modelCatalogOverrides as any,
      desktop.providers,
      [
        desktop.defaultModel,
        // `aside` is an internal category binding, not a selectable provider
        // in the Mac model picker. Surfacing it created a fake fifth row on
        // the phone containing a duplicate GPT model.
        ...Object.values(desktop.categories).filter(
          (ref) => ref.provider !== 'aside',
        ),
      ],
    );
    catalogAt = now;
    return catalogCache;
  }

  /** Context denominator when a session has not written its own model yet. */
  function defaultContextWindow(): number {
    const liveCatalog = currentCatalog();
    let ref = catalogDefault;
    if (!ref && config.defaultModel.includes('/')) {
      const split = config.defaultModel.indexOf('/');
      ref = {
        provider: config.defaultModel.slice(0, split),
        modelId: config.defaultModel.slice(split + 1),
        thinkingLevel: '',
      };
    }
    return ref
      ? contextWindowFor(liveCatalog, ref.provider, ref.modelId)
      : DEFAULT_CONTEXT_WINDOW;
  }

  /**
   * Kept as a getter-backed alias so the many existing `catalog` readers
   * below pick up refreshes without each one having to remember to call
   * `currentCatalog()`.
   */
  const catalog = new Proxy([] as ReturnType<typeof buildCatalog>, {
    get(_target, prop, receiver) {
      return Reflect.get(currentCatalog(), prop, receiver);
    },
    has(_target, prop) {
      return Reflect.has(currentCatalog(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(currentCatalog());
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(currentCatalog(), prop);
    },
  }) as ReturnType<typeof buildCatalog>;

  /**
   * Subagents of a session, read from the daemon's table and kept warm so
   * the synchronous thread build can see them. See `SubagentIndex`.
   */
  /** Tracks turns this server ran, so their tail is not read as liveness. */
  const ownedTurns = new OwnedTurns();

  /**
   * A resident whisper.cpp, started on the first dictation and kept warm.
   *
   * See `whisperserver.ts`: roughly half of every transcription's wall
   * clock was the same model being loaded off disk again. Lazy, so a user
   * who never dictates never pays the memory for it.
   */
  const whisperServer = new WhisperServer({
    modelPath: config.whisperModelPath,
    language: config.whisperLanguage || 'en',
  });
  app.addHook('onClose', async () => whisperServer.dispose());

  const subagents = new SubagentIndex(async (parentId) => {
    const rows = await stateDb.children(parentId);
    if (!rows) return null;
    return rows.map((row) =>
      toChildSession(row, (provider, modelId) =>
        modelLabel(catalog, provider, modelId),
      ),
    );
  });

  // --- Day 2: outbound pushes for a turn nobody is watching --------------
  // Reference-counts who is actively subscribed over the WS, so a push
  // never duplicates what is already on screen (plan 6.6).
  const viewers = new ActiveViewers();
  const notifier = new Notifier({
    botToken: config.botToken,
    // Nothing to push to without a bot. The Notifier still runs so mute
    // state and read tracking behave the same; it just never calls out.
    enabled: !config.standalone,
    chatId: config.allowedUserId,
    stateDir: config.miniapp.stateDir,
    deepLinkBase: config.miniapp.deepLinkBase,
    isBeingViewed: (sessionId) => viewers.isActive(sessionId),
    onError: (context, err) =>
      app.log.warn({ err, context }, 'notify failed'),
  });

  /** The last final-answer bubble's text, trimmed for a push notification. */
  function lastAssistantSummary(items: ThreadItem[]): string {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item.kind !== 'answer') continue;
      const text = String(item.text || '').replace(/\s+/g, ' ').trim();
      return text.length > 240 ? `${text.slice(0, 239)}…` : text;
    }
    return '';
  }

  /** Tool names this codebase's browser-driving steps show up under. Kept as a loose keyword match rather than an exact enum -- the exact tool registry lives outside this server, and a false negative (skipping a thumbnail) is a far cheaper mistake than a false positive (capturing an unrelated tab). */
  const BROWSER_TOOL_HINTS = [
    'browser',
    'tab',
    'snapshot',
    'screenshot',
    'navigate',
    'click',
    'scroll',
    'openurl',
    'open_tab',
  ];

  function turnTouchedBrowser(items: ThreadItem[]): boolean {
    for (const item of items) {
      if (item.kind !== 'work') continue;
      for (const workItem of item.items) {
        if (workItem.kind !== 'step') continue;
        const tool = String(workItem.tool || '').toLowerCase();
        if (BROWSER_TOOL_HINTS.some((hint) => tool.includes(hint))) return true;
      }
    }
    return false;
  }

  /**
   * Plan 7.5: if the turn drove the browser, the completion push carries
   * visual proof. Best-effort in every direction -- no open tabs, a
   * capture failure, anything -- just means the plain text notice ships
   * instead, never a broken push.
   */
  async function captureCompletionThumbnail(
    items: ThreadItem[],
  ): Promise<string | null> {
    if (!turnTouchedBrowser(items)) return null;
    try {
      const tabs = await listTabs(facade);
      const target = tabs.find((tab) => tab.active) || tabs[0];
      if (!target) return null;
      const result = await captureTab(facade, target.targetId, { quality: 55 });
      return result.base64;
    } catch {
      return null;
    }
  }

  const longRunningTimers = new Map<string, NodeJS.Timeout>();

  runner.on('turn_started', (turn) => {
    ownedTurns.markStarted(turn.sessionId);
    notifier.beginTurn(turn.sessionId, turn.startedAt);
    const existingTimer = longRunningTimers.get(turn.sessionId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      longRunningTimers.delete(turn.sessionId);
      if (!runner.isBusy(turn.sessionId)) return;
      void fetchSession(facade, turn.sessionId).then(
        (session) => {
          void notifier.notifyLongRunning(
            { id: turn.sessionId, title: session?.title || 'Session' },
            Date.now() - turn.startedAt,
          );
        },
        () => {},
      );
    }, LONG_RUNNING_THRESHOLD_MS);
    timer.unref?.();
    longRunningTimers.set(turn.sessionId, timer);
  });

  runner.on('turn_finished', (turn) => {
    // Before anything else: our child is gone, so the transcript's freshly
    // bumped mtime is our own tail and must not keep the composer showing
    // a stop control for the next thirty seconds.
    ownedTurns.markFinished(
      turn.sessionId,
      sessionMsgFile(config.sessionsDir, turn.sessionId),
    );
    const existingTimer = longRunningTimers.get(turn.sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      longRunningTimers.delete(turn.sessionId);
    }
    // A stopped turn is the user's own deliberate tap -- nothing to say
    // that they do not already know. Everything else is worth a push.
    if (turn.stopped) return;
    void (async () => {
      try {
        const session = await fetchSession(facade, turn.sessionId).catch(
          () => null,
        );
        const notifySession = { id: turn.sessionId, title: session?.title || 'Session' };

        if (turn.alert && !turn.suspended) {
          await notifier.notifyError(notifySession, turn.alert);
          return;
        }

        const msgFile = sessionMsgFile(config.sessionsDir, turn.sessionId);
        if (msgFile && fs.existsSync(msgFile)) {
          const snapshot = threads.build(
            turn.sessionId,
            msgFile,
            false,
            subagents.snapshot(turn.sessionId, false),
          );
          const last = snapshot.items[snapshot.items.length - 1];
          if (
            last &&
            last.kind === 'question' &&
            last.status === 'pending' &&
            last.answerable &&
            last.questions[0]
          ) {
            notifier.setWaiting(turn.sessionId, true);
            await notifier.notifyBlocked(notifySession, last.questions[0], last.id);
            return;
          }
          const summary = lastAssistantSummary(snapshot.items);
          const thumbnail = await captureCompletionThumbnail(snapshot.items);
          if (thumbnail) {
            await notifier.notifyFinishedWithPhoto(notifySession, summary, thumbnail);
          } else {
            await notifier.notifyFinished(notifySession, summary);
          }
          return;
        }
        await notifier.notifyFinished(notifySession, '');
      } catch (err) {
        app.log.warn({ err }, 'turn_finished notify failed');
      }
    })();
  });

  /*
   * Security headers on every response.
   *
   * Set in an `onSend` hook rather than per route so a route added later
   * cannot forget them, and skipped when a route has already set its own
   * `content-security-policy` -- the artifact and local-file routes serve
   * attacker-influenced bytes under a much stricter `sandbox` policy, and
   * this must not loosen it.
   *
   * `frame-ancestors` is the interesting one. `'none'` is right for a
   * standalone install, but Telegram Web runs a mini app inside an iframe
   * on `web.telegram.org`, so a blanket `'none'` would break the very mode
   * this project started in. The allowance is therefore tied to whether
   * Telegram is configured at all.
   */
  const frameAncestors = config.standalone
    ? "'none'"
    : "'self' https://web.telegram.org https://*.telegram.org";
  const scriptSrc = config.standalone
    ? "script-src 'self'"
    : "script-src 'self' https://telegram.org";
  const contentSecurityPolicy = (requestHost: string | undefined): string => {
    // Name the exact same host explicitly for browsers that do not treat
    // CSP 'self' as matching ws:/wss:. Never grant arbitrary socket origins.
    const safeHost = requestHost && /^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::\d+)?$/.test(requestHost)
      ? requestHost
      : '';
    const sockets = safeHost ? ` ws://${safeHost} wss://${safeHost}` : '';
    return [
    "default-src 'self'",
    // The installed app strips Telegram's bridge and stays self-only. The
    // Telegram mini-app entry retains the one exact origin it loads from.
    scriptSrc,
    // Shiki writes per-token colours as inline styles, and React sets
    // style attributes, both of which this blocks without 'unsafe-inline'.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    // Same-origin REST plus the exact WebSocket host.
    `connect-src 'self'${sockets}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
    ].join('; ');
  };

  app.addHook('onSend', async (request, reply, payload) => {
    if (!reply.getHeader('content-security-policy')) {
      reply.header(
        'content-security-policy',
        contentSecurityPolicy(request.headers.host),
      );
    }
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    /*
     * HSTS. Browsers ignore this over plain http, so sending it on the
     * loopback listener costs nothing; over the tailnet, where Tailscale
     * terminates real TLS, it is the one that matters. No `preload`: this
     * hostname is private and does not belong in a browser's preload list.
     */
    reply.header('strict-transport-security', 'max-age=31536000');
    return payload;
  });

  /**
   * Compress JSON and text responses on the way out.
   *
   * The static bundle is precompressed at build time (see `preCompressed`
   * below), but the API was not compressed at all, and the API is what the
   * phone fetches constantly. A real thread payload measured against this
   * service on 2026-09-01 was 383KB of JSON for one open, and the session
   * list is 12KB on every poll. JSON of this shape -- thousands of
   * repeated keys -- compresses roughly six to one, so this is most of a
   * phone's transfer time on every screen.
   *
   * Deliberately hand-rolled rather than pulling in `@fastify/compress`:
   * the rule needed here is small and the failure modes of getting it
   * wrong are large, so it is easier to read all of it. The guards are the
   * point:
   *
   *  - only string and Buffer payloads, so streamed file downloads and
   *    image responses pass through untouched;
   *  - never when something upstream already set `content-encoding`, which
   *    is exactly what the precompressed static handler does;
   *  - only above a size where the framing overhead is worth it;
   *  - `vary: accept-encoding` always, so a cache can never serve a
   *    compressed body to a client that did not ask for one.
   */
  const COMPRESSIBLE_TYPE = /^(?:application\/(?:json|javascript)|text\/)/i;
  const COMPRESS_MIN_BYTES = 1024;
  app.addHook('onSend', async (request, reply, payload) => {
    const isText = typeof payload === 'string';
    if (!isText && !Buffer.isBuffer(payload)) return payload;
    if (reply.getHeader('content-encoding')) return payload;

    const type = String(reply.getHeader('content-type') || '');
    if (!COMPRESSIBLE_TYPE.test(type)) return payload;

    const body = isText ? Buffer.from(payload, 'utf8') : (payload as Buffer);
    // `vary` goes on every compressible response, not just the ones that
    // end up compressed, or an intermediary could cache the uncompressed
    // answer under a key that also matches a client asking for brotli.
    reply.header('vary', 'accept-encoding');
    if (body.byteLength < COMPRESS_MIN_BYTES) return payload;

    const accepted = String(request.headers['accept-encoding'] || '');
    let encoded: Buffer;
    let encoding: string;
    if (/\bbr\b/.test(accepted)) {
      encoding = 'br';
      encoded = zlib.brotliCompressSync(body, {
        params: {
          // Quality 5, not 11: this runs per request on live data, where
          // the extra few percent costs more milliseconds than it saves.
          // The build-time pass over the static bundle uses 11.
          [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
        },
      });
    } else if (/\bgzip\b/.test(accepted)) {
      encoding = 'gzip';
      encoded = zlib.gzipSync(body, { level: 6 });
    } else {
      return payload;
    }

    if (encoded.byteLength >= body.byteLength) return payload;
    reply.header('content-encoding', encoding);
    reply.header('content-length', encoded.byteLength);
    return encoded;
  });

  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
    // Belt and braces alongside `trustProxy: false`: the bucket key is read
    // off the socket, never off a header, so no request can choose it.
    keyGenerator: (request) =>
      (request.raw.socket?.remoteAddress as string | undefined) || 'unknown',
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: MAX_UPLOAD_FILES,
      // Only files are expected; a stray text field is not a reason to 500.
      fields: 4,
    },
  });

  /*
   * True when the browser will accept a `Secure` cookie for this request.
   *
   * Tailscale terminates TLS and proxies to plain loopback, so Fastify sees
   * http on a request the phone made over https. The forwarded header is
   * what carries the truth; falling back to the request protocol keeps
   * local testing over 127.0.0.1 working.
   */
  /**
   * Should the session cookie carry `Secure`?
   *
   * `X-Forwarded-Proto` is the only way to know, because Tailscale
   * terminates TLS and forwards plain http to loopback, so `request.protocol`
   * says `http` for a request the phone made over https.
   *
   * The header is trusted ONLY from a loopback peer. That is not a
   * formality: `trustProxy` is off precisely because headers are
   * client-writable, and the same reasoning has to apply here. A loopback
   * peer is either our own reverse proxy or a client on this machine, and a
   * client on this machine can only mislead itself about its own cookie.
   */
  const wantsSecureCookie = (request: FastifyRequest): boolean => {
    const peer = String(request.ip || '');
    const fromLoopback =
      peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    if (fromLoopback) {
      const fwd = request.headers['x-forwarded-proto'];
      const proto = Array.isArray(fwd) ? fwd[0] : fwd;
      if (proto) return String(proto).split(',')[0].trim() === 'https';
    }
    return request.protocol === 'https';
  };

  /**
   * Hand back a session cookie when the caller does not already have a
   * healthy one.
   *
   * This is what makes the installed app stop asking to be paired. Any
   * authenticated request is proof the client holds a valid token, so the
   * server takes that moment to write the durable copy it can recover from
   * later, and refreshes it well before expiry so ordinary use renews the
   * session without the owner ever seeing a pairing screen again.
   */
  const refreshSessionCookie = (
    request: FastifyRequest,
    reply: any,
    claims: { sub: string; uid: number; name?: string },
  ): void => {
    const existing = cookieFrom(request.headers.cookie);
    if (existing && secondsRemaining(existing) > REFRESH_BELOW_SECONDS) return;
    const fresh = mintToken(
      opts.jwtSecret,
      {
        sub: claims.sub,
        uid: claims.uid,
        // The name is re-read from config rather than carried forward, so a
        // token minted before the greeting knew the owner's name still ends
        // up naming them after one launch.
        name: claims.name || config.miniapp.ownerName || undefined,
      },
      LONG_TOKEN_TTL_SECONDS,
    );
    reply.header(
      'set-cookie',
      sessionCookie(fresh, LONG_TOKEN_TTL_SECONDS, wantsSecureCookie(request)),
    );
  };

  /**
   * Token gate for every /api route except auth, pair and health.
   *
   * Accepts the bearer header first (Telegram launches and the freshly
   * paired app both have one in memory) and falls back to the session
   * cookie, which is the copy that survives a cleared localStorage.
   */
  const requireAuth = async (request: FastifyRequest, reply: any) => {
    const fromQuery = (request.query as { token?: unknown }).token;
    if (typeof fromQuery === 'string' && fromQuery) {
      return reply.code(401).send({ error: 'unauthorized', reason: 'token_in_query' });
    }
    const presented =
      bearerFrom(request.headers.authorization) ??
      cookieFrom(request.headers.cookie);
    try {
      const claims = verifyToken(
        presented,
        opts.jwtSecret,
        config.allowedUserId,
      );
      (request as any).user = claims;
      refreshSessionCookie(request, reply, claims);
    } catch (err) {
      const code = err instanceof TokenError ? err.code : 'invalid';
      return reply.code(401).send({ error: 'unauthorized', reason: code });
    }
  };

  app.get('/api/health', async () => ({ ok: true }));

  /**
   * Standalone pairing (home-screen PWA).
   *
   * Telegram's initData is a bootstrap credential, not the session itself:
   * a valid launch mints the JWT that every other route actually checks.
   * Installed to the home screen there is no Telegram to launch from, so
   * this offers a second bootstrap into the same spine and mints the same
   * kind of token, just with a longer life so the app is not re-pairing
   * every day.
   *
   * The loopback pairing page issues a random, one-time, ten-minute code
   * into the shared in-memory store. This route spends it once. The route is
   * reachable only over the private tailnet, so the network
   * is a second gate behind this one.
   *
   * The loopback-only listener issues opaque codes into the shared store;
   * this route spends each code once and never derives one from the JWT key.
   */
  const pairingCodes = opts.pairingCodes ?? new PairingCodeStore();

  app.post(
    '/api/pair',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = (request.body || {}) as { key?: unknown };
      const code = String(body.key ?? '');
      // One-time enrollment: a code works once, then it is gone. Expired or
      // already-spent codes fail exactly like a wrong key, so a replayed or
      // stale link gives nothing away about which failure it was.
      if (!code || !pairingCodes.consume(code)) {
        return reply.code(401).send({ error: 'pair_failed' });
      }
      // 90 days: long enough that the phone is not a daily chore, short
      // enough that a lost device stops working inside a season.
      const ttl = LONG_TOKEN_TTL_SECONDS;
      // Telegram supplies the owner's first name on every launch; there is no
      // equivalent here, so it comes from config and falls back to nothing
      // rather than to a placeholder the greeting would read out loud.
      const name = config.miniapp.ownerName || undefined;
      const token = mintToken(
        opts.jwtSecret,
        { sub: String(config.allowedUserId), uid: config.allowedUserId, name },
        ttl,
      );
      // Written as a cookie as well as returned in the body. The body copy
      // is what the running page uses; the cookie is what survives the app
      // being closed, storage being evicted, or the pairing link having been
      // opened in a different browser than the one that installed the app.
      reply.header(
        'set-cookie',
        sessionCookie(token, ttl, wantsSecureCookie(request)),
      );
      return { token, name, expiresIn: ttl };
    },
  );

  /**
   * Recover a session without re-pairing.
   *
   * The installed app calls this at boot when it has no usable token of its
   * own. If the browser still holds the session cookie, it gets a fresh
   * token back and the owner never sees a pairing screen. If it does not,
   * this 401s and the app falls through to asking for a pairing link, which
   * is the only case where re-pairing is genuinely required.
   */
  app.get(
    '/api/session',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const presented =
        bearerFrom(request.headers.authorization) ??
        cookieFrom(request.headers.cookie);
      let claims;
      try {
        claims = verifyToken(presented, opts.jwtSecret, config.allowedUserId);
      } catch (err) {
        const code = err instanceof TokenError ? err.code : 'invalid';
        return reply.code(401).send({ error: 'unauthorized', reason: code });
      }
      const name = claims.name || config.miniapp.ownerName || undefined;
      const token = mintToken(
        opts.jwtSecret,
        { sub: claims.sub, uid: claims.uid, name },
        LONG_TOKEN_TTL_SECONDS,
      );
      reply.header(
        'set-cookie',
        sessionCookie(
          token,
          LONG_TOKEN_TTL_SECONDS,
          wantsSecureCookie(request),
        ),
      );
      return { token, name, expiresIn: LONG_TOKEN_TTL_SECONDS };
    },
  );

  /*
   * The Aside browser's own visit history.
   *
   * Read straight out of the desktop profile's Chromium history database,
   * so this is the same history the Mac shows rather than a separate log.
   * Read-only and immutable; see history.ts for why that matters while the
   * browser holds the file open.
   */
  const historyReader = new HistoryReader();

  app.get(
    '/api/history/browser',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const q = request.query as { q?: unknown; limit?: unknown };
      const query = typeof q.q === 'string' ? q.q.slice(0, 120) : '';
      const limit = Number(q.limit) || 40;
      const entries = await historyReader.recent({ query, limit });
      if (!entries.length && historyReader.error) {
        // An empty list and a broken reader look identical to the client
        // otherwise, and they need very different messages.
        return reply
          .code(503)
          .send({ error: 'history_unavailable', reason: historyReader.error });
      }
      return { entries, query };
    },
  );

  /*
   * Address-bar suggestions.
   *
   * Google's suggest endpoint plus both devices' history, blended by
   * `omnibox.ts`. The rate limit is high because this fires per keystroke
   * (debounced on the client), and a typeahead that starts 429ing halfway
   * through a word is worse than no typeahead at all.
   */
  const suggestClient = new SuggestClient();
  const visitStore = new VisitStore();
  app.addHook('onClose', async () => visitStore.stop());

  app.get(
    '/api/omnibox',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
    },
    async (request) => {
      const params = request.query as { q?: unknown };
      const query = String(params.q ?? '').slice(0, 200).trim();

      if (!query) {
        const [history, visits] = await Promise.all([
          historyReader.recent({ limit: 40 }),
          visitStore.recent({ limit: 40 }),
        ]);
        return { query, items: buildZeroState(history, visits) };
      }

      /*
       * The local half never waits on the network half.
       *
       * `suggest()` already resolves to `[]` rather than rejecting, so a
       * slow or unreachable Google degrades this to a history-only list on
       * its own schedule instead of holding the keystroke.
       */
      const [history, visits, suggestions] = await Promise.all([
        historyReader.recent({ query, limit: 200 }),
        visitStore.recent({ limit: 400 }),
        suggestClient.suggest(query),
      ]);

      return {
        query,
        items: buildOmnibox({
          query,
          history,
          visits,
          suggestions,
          directUrl: asUrl(query),
        }),
      };
    },
  );

  /*
   * Record what the phone did, so the address bar on either device can see
   * it. Deliberately not a write into Chromium's own database; see
   * `visits.ts` for why that would be the wrong kind of clever.
   */
  app.post(
    '/api/browse/visit',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as {
        kind?: unknown;
        title?: unknown;
        url?: unknown;
      };
      const kind = body.kind === 'search' ? 'search' : 'page';
      const url = String(body.url ?? '').trim();
      if (!url) return reply.code(400).send({ error: 'missing_url' });
      if (!/^https?:\/\//i.test(url)) {
        return reply.code(400).send({ error: 'bad_url' });
      }
      const visit = await visitStore.record({
        kind,
        title: String(body.title ?? '').trim(),
        url,
      });
      return { visit };
    },
  );

  /** Unified recent history across both devices, newest first. */
  app.get(
    '/api/browse/recent',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request) => {
      const params = request.query as { q?: unknown; limit?: unknown };
      const query = String(params.q ?? '').slice(0, 120);
      const limit = Math.min(Number(params.limit) || 60, 200);
      const [history, visits] = await Promise.all([
        historyReader.recent({ query, limit }),
        visitStore.recent({ query, limit }),
      ]);
      return { items: buildZeroState(history, visits, limit), query };
    },
  );

  /*
   * There is deliberately no server-side search route.
   *
   * There used to be one: it drove the Mac's browser over `aside repl`,
   * navigated Google, scraped the result page and shipped the pieces back
   * as JSON. It worked, and it was the wrong shape for the problem. Every
   * query paid for a CLI child, a tab, a page load and an extraction
   * before the phone saw anything, which is where "waking browser /
   * searching Google / reading results" came from, and what came back was
   * a list of links with none of the surfaces that make a result page
   * useful.
   *
   * Search now happens on the phone, because that is where a browser
   * already is. The Android shell opens a Chrome Custom Tab, which is real
   * Chrome on real Chrome cookies, so the owner is signed in and the Mac
   * is not in the critical path at all. What the server still does is the
   * half a phone genuinely cannot: `/api/omnibox` blends Google's
   * suggestions with the Mac's own Chromium history, which is the one
   * thing Chrome on the phone has no way to see.
   */

  /**
   * Speech to text, decoded on this machine.
   *
   * The composer posts one recording and gets prose back. Deliberately not
   * streaming: a spoken message is a few seconds of audio, the round trip is
   * comparable to the pause after letting go of the button, and a partial
   * transcript that rewrites itself mid-sentence is worse to watch than a
   * brief spinner.
   */
  app.post(
    '/api/transcribe',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      let audio: Buffer | null = null;
      let language: string | undefined;
      try {
        for await (const part of (request as any).parts()) {
          if (part.type === 'file' && !audio) {
            audio = await part.toBuffer();
          } else if (part.type === 'field' && part.fieldname === 'language') {
            language = String(part.value || '') || undefined;
          }
        }
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.code(413).send({ error: 'audio_too_large' });
        }
        request.log.error({ err }, 'transcribe upload failed');
        return reply.code(400).send({ error: 'bad_upload' });
      }

      if (!audio || audio.length === 0) {
        return reply.code(400).send({ error: 'empty_audio' });
      }

      try {
        const { text, ms } = await transcribeAudio(audio, {
          modelPath: config.whisperModelPath,
          language: language || config.whisperLanguage || 'en',
          // Null when the resident server is unavailable, in which case
          // `transcribeAudio` runs the CLI exactly as it always did.
          serverPort: whisperServer.portIfReady(),
        });
        request.log.info({ ms, chars: text.length }, 'transcribed');
        return { text, ms };
      } catch (err) {
        if (err instanceof TranscribeError) {
          const status =
            err.code === 'audio_too_large' ? 413
            : err.code === 'timeout' ? 504
            : err.code.endsWith('_missing') ? 503
            : 500;
          request.log.error({ code: err.code, msg: err.message }, 'transcribe failed');
          return reply.code(status).send({ error: err.code, reason: err.message });
        }
        request.log.error({ err }, 'transcribe crashed');
        return reply.code(500).send({ error: 'internal' });
      }
    },
  );

  /**
   * Load the speech model while the user is still talking.
   *
   * The client calls this the moment the mic button goes down. Cold start
   * is dominated by reading the model into memory, and a dictation takes
   * seconds -- so doing the two concurrently means the FIRST take after a
   * restart is as quick as every one after it, instead of being the one
   * that feels broken.
   *
   * Returns immediately either way: this is a hint, not a dependency.
   */
  app.post(
    '/api/transcribe/warm',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async () => {
      whisperServer.warm();
      return { ok: true };
    },
  );

  // --- Phase 0: the auth spine ------------------------------------------
  app.post(
    '/api/auth',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      /*
       * Refused outright without a bot token, and this is load-bearing.
       *
       * `validateInitData` HMACs with the bot token as the key. An empty
       * token is a key everyone knows, so accepting this route in
       * standalone mode would let anyone who can reach the port mint a
       * full session. Pairing is the only bootstrap when there is no
       * Telegram identity to check.
       */
      if (config.standalone) {
        return reply.code(404).send({ error: 'telegram_not_configured' });
      }
      const body = (request.body || {}) as { initDataRaw?: unknown };
      try {
        const validated = validateInitData(
          String(body.initDataRaw ?? ''),
          config.botToken,
          config.allowedUserId,
          { maxAgeSeconds: MAX_AUTH_AGE_SECONDS },
        );
        const token = mintToken(opts.jwtSecret, {
          sub: String(validated.user.id),
          uid: validated.user.id,
          name: validated.user.first_name,
        });
        return {
          token,
          user: {
            id: validated.user.id,
            firstName: validated.user.first_name,
            username: validated.user.username,
          },
          expiresIn: 24 * 60 * 60,
        };
      } catch (err) {
        if (err instanceof InitDataError) {
          const status = err.code === 'forbidden_user' ? 403 : 401;
          return reply.code(status).send({ error: 'auth_failed', reason: err.code });
        }
        request.log.error({ err }, 'auth failure');
        return reply.code(500).send({ error: 'internal' });
      }
    },
  );

  // --- Phase 1: read API -------------------------------------------------
  app.get(
    '/api/sessions',
    { preHandler: requireAuth },
    async (request) => {
      const query = request.query as { limit?: string };
      const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 200);
      const { rows, source } = await listSessionRows(
        facade,
        config.sessionsDir,
        limit,
        stateDb,
      );
      // "Waiting on you": suspended on a native tool (the daemon's own
      // status), or sitting on an answerable soft-marker question nobody
      // has tapped (notifier's tracked state -- see the turn_finished
      // hook above). Cheap either way: no extra transcript reads.
      const sessions = rows.map((row) => {
        // Current daemon status is primary; transcript activity supports older hosts.
        const msgFile = sessionMsgFile(config.sessionsDir, row.id);
        const live =
          row.status === 'running' || runner.isBusy(row.id) ||
          (msgFile ? transcriptIsLive(msgFile) : false);
        return {
          ...row,
          status: live ? 'running' : row.status,
          waiting: isSuspended(row.status) || notifier.isWaiting(row.id),
        };
      });
      return { sessions, source };
    },
  );

  /** Per-session mute for push notifications (plan 6.6). */
  app.post(
    '/api/sessions/:id/mute',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      const body = (request.body || {}) as { hours?: number };
      const hours = Math.min(Math.max(Number(body.hours) || 24, 1), 24 * 30);
      notifier.mute(id, hours * 60 * 60 * 1000);
      return { ok: true, mutedForHours: hours };
    },
  );

  /**
   * Delete a chat from the phone.
   *
   * "Delete" here means `aside.sessions.archive`, which is the only
   * non-destructive verb the daemon exposes and the only one that is safe
   * to call from a remote client -- see `archiveSession` for why reaching
   * into the daemon's sqlite was rejected. `sessions.list()` already skips
   * archived rows, so the effect on this app is total: the chat is gone
   * from history, from search, and from notifications.
   *
   * DELETE rather than POST because it is idempotent: archiving an already
   * archived session is a no-op, so a retry after a flaky phone connection
   * cannot do damage.
   */
  app.delete(
    '/api/sessions/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      try {
        await archiveSession(facade, id);
      } catch (error) {
        request.log.error({ err: error, id }, 'archive failed');
        return reply.code(502).send({ error: 'archive_failed' });
      }
      // A deleted chat must not keep buzzing the phone about a turn it can
      // no longer be opened to read.
      notifier.unmute(id);
      notifier.setWaiting(id, false);
      return { ok: true, id };
    },
  );

  app.post(
    '/api/sessions/:id/unmute',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      notifier.unmute(id);
      return { ok: true };
    },
  );

  /**
   * The thread as the sidepanel draws it: user bubbles, work folds, and
   * final answers. Opening a thread also clears its unread state, so the
   * dot disappears here and in the browser together.
   *
   * The transcript on disk is the source, NOT `aside.sessions.messages()`.
   * The facade returns the agent's current CONTEXT rather than the
   * conversation: on a long session it begins mid-turn, after compaction,
   * with a `system-message` and a wall of tool activity and no user message
   * in front of it. Built from that, a real session renders as one bare
   * work fold with no bubbles and no answers -- which is exactly what the
   * owner saw. messages.jsonl holds the whole history and the same record
   * shape, so it is what gets parsed here.
   */
  app.get(
    '/api/sessions/:id/thread',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }

      /*
       * Wait for a transcript that is still being written rather than
       * 404ing on it. See `waitForTranscript`: this is the same rule the
       * WebSocket already used, and its absence here is what made a brand
       * new chat flash "404: session_not_found" before it settled.
       */
      const msgFile = await waitForTranscript(config.sessionsDir, id, (sid) =>
        runner.isBusy(sid),
      );
      if (!msgFile) {
        return reply.code(404).send({ error: 'session_not_found' });
      }

      /**
       * The session's title, status, permission mode and pinned model,
       * read straight from the daemon's own SQLite.
       *
       * This route USED to await `fetchSession(facade, id)` as well, for
       * nothing but the title and the status -- both of which are columns
       * in the row being read here. That call spawns the ~139MB CLI, and
       * it is what made opening a chat on the phone take between eleven
       * and twenty seconds. Measured against the live service on
       * 2026-09-01, over five real sessions: 11427ms, 13278ms, 20039ms,
       * 20039ms, and 3ms for the one empty session. The three that took
       * twenty seconds hit the facade's own timeout exactly -- that is the
       * "it often doesn't even load" case, and it got WORSE the more the
       * desktop was doing, because a busy daemon answers a repl spawn more
       * slowly. The same requests warm off the cache in 7-9ms.
       *
       * The daemon's table is not a second-best source here. It is the
       * same store the facade would have queried, one process closer.
       */
      const state = await stateDb.read(id);
      const status = state.status || 'idle';
      // Daemon running status remains authoritative during quiet thinking/tool calls.
      const running =
        status === 'running' || runner.isBusy(id) ||
        isSuspended(status) ||
        (!ownedTurns.settled(id, msgFile) && transcriptIsLive(msgFile));
      // A thread open is the one place worth paying for a fresh child read
      // rather than whatever the index happens to hold.
      const children = await subagents.refresh(id);
      const snapshot = buildParentView(
        threads,
        config.sessionsDir,
        id,
        msgFile,
        running,
        children,
      );

      // Best-effort; a failure here must not block the read.
      void markSessionRead(facade, id);

      /**
       * A session started from a phone: this app's own, or bridge.py's.
       *
       * The switch in the permission popover means the SOFT protocol on
       * one of these, so what it shows has to come from the soft store --
       * the daemon's own flag is held at false there on purpose. See the
       * permission route.
       */
      const mobile = isMobileSession(config.sessionsDir, id);

      /**
       * The daemon titles every CLI-created session "Aside CLI", and every
       * session this app starts is CLI-created -- so the header on a
       * brand-new thread read "Aside CLI" rather than what the
       * conversation was about. The session LIST already worked around
       * this (see `isPlaceholderTitle` + `localScan`); the thread route
       * did not, so the same session showed a real title in the list and a
       * placeholder once opened. Same rule, applied in both places now.
       */
      const rawTitle = state.title || '';
      const title = isPlaceholderTitle(rawTitle)
        ? titleFromTranscript(config.sessionsDir, id) || rawTitle
        : rawTitle;

      return {
        sessionId: id,
        title,
        status,
        /** Blocked on a desktop-only question; see `isSuspended`. */
        suspended: isSuspended(status),
        /**
         * Whether the block above has an actual answerable/recoverable
         * question behind it. `suspended` alone can be true with nothing
         * for the composer's recover button to act on -- the driver that
         * hit the native tool can be reaped before the write that would
         * have produced a clean question item lands. The client uses this
         * to decide whether tapping "Continue in a new session" can work
         * before it tries, instead of finding out from a 409.
         */
        hasRecoverableQuestion: pendingNativeQuestion(snapshot.items as any) !== null,
        /** Push notifications silenced for this session -- see notify.ts. */
        muted: notifier.isMuted(id),
        items: snapshot.items,
        stats: snapshot.stats,
        sources: snapshot.sources,
        /** Replayed `write_todos` state, for the task-list section. */
        todos: snapshot.todos,
        // From the snapshot, not from `children`: these carry the palette
        // slot of the spawn row each child came from, so the panel and the
        // thread draw the same creature colour.
        subagents: snapshot.subagents,
        /** Each subagent's timeline tail, so its card renders on first paint. */
        subagentSteps: snapshot.children,
        /** Set when this session is itself a subagent of another. */
        parentId: state.parentId,
        contextWindow: state.model
          ? contextWindowFor(catalog, state.model.provider, state.model.modelId)
          : defaultContextWindow(),
        busy: running,
        /** CLI 1.26.902 can also stop a desktop-daemon-owned turn. */
        stoppable: running && !isSuspended(status),
        queued: runner.queuedCount(id),
        permission: state.permission,
        permissionMode: state.permissionMode,
        finalConfirm: mobile ? softConfirm.has(id) : state.finalConfirm,
        /** True when the confirm toggle means the soft protocol. */
        softConfirm: mobile,
        model: state.model
          ? {
              provider: state.model.provider,
              modelId: state.model.modelId,
              label: modelLabel(
                catalog,
                state.model.provider,
                state.model.modelId,
              ),
              effort: state.model.thinkingLevel || null,
              effortLabel: state.model.thinkingLevel
                ? EFFORT_LABELS[state.model.thinkingLevel] ||
                  state.model.thinkingLevel
                : null,
            }
          : null,
      };
    },
  );

  /**
   * Raw transcript entries. The thread endpoint above is the primary read;
   * this stays as the live-streaming delta source during a running turn,
   * where tailing the jsonl beats re-spawning the CLI per token.
   */
  app.get(
    '/api/sessions/:id/messages',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { afterLine?: string; limit?: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      const msgFile = sessionMsgFile(config.sessionsDir, id);
      if (!msgFile || !fs.existsSync(msgFile)) {
        return reply.code(404).send({ error: 'session_not_found' });
      }
      const afterLine = Number.isFinite(Number(query.afterLine))
        ? Number(query.afterLine)
        : -1;
      const limit = Math.min(
        Math.max(Number(query.limit) || DEFAULT_ENTRY_LIMIT, 1),
        5000,
      );

      // This reads the whole transcript into memory before it can honour
      // `afterLine`, because line offsets are the cursor. A real session
      // reaches 57MB on the owner's machine, so the read is capped rather
      // than left to allocate whatever is on disk -- an oversized transcript
      // is reported as truncated instead of being turned into a 180MB
      // allocation per request.
      const size = fs.statSync(msgFile, { throwIfNoEntry: false })?.size ?? 0;
      if (size > MAX_TRANSCRIPT_BYTES) {
        return reply.code(413).send({ error: 'transcript_too_large' });
      }
      const buffer = fs.readFileSync(msgFile, 'utf8');
      const { entries, lastLine } = parseTranscript(buffer, { afterLine });
      const truncated = entries.length > limit;
      return {
        sessionId: id,
        entries: truncated ? entries.slice(-limit) : entries,
        truncated,
        lastLine,
        busy: runner.isBusy(id),
        queued: runner.queuedCount(id),
      };
    },
  );

  /**
   * The session's own files: what the agent wrote, and what came in with a
   * message. Both groups are always reported so the panel can say "no
   * files yet" rather than omitting a section that exists but is empty.
   */
  app.get(
    '/api/sessions/:id/artifacts',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const dir = isValidSessionId(id)
        ? resolveSessionDir(config.sessionsDir, id)
        : null;
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      if (!dir) return reply.code(404).send({ error: 'session_not_found' });

      return {
        sessionId: id,
        groups: [
          { id: 'artifacts', files: listArtifacts(dir, 'artifacts') },
          { id: 'attachments', files: listArtifacts(dir, 'attachments') },
        ],
      };
    },
  );

  /**
   * One file's bytes.
   *
   * The path is resolved and realpath-checked against the group directory
   * before anything is read, so neither `../` nor a symlink can name a file
   * elsewhere on the machine -- see `resolveArtifact`.
   */
  app.get(
    '/api/sessions/:id/artifacts/file',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { path?: string; group?: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      const group: ArtifactGroup = isArtifactGroup(query.group)
        ? query.group
        : 'artifacts';
      const dir = resolveSessionDir(config.sessionsDir, id);
      if (!dir) return reply.code(404).send({ error: 'session_not_found' });

      const file = resolveArtifact(dir, group, String(query.path ?? ''));
      if (!file) return reply.code(403).send({ error: 'forbidden_path' });

      // The agent owns this directory and may be rewriting it right now, so
      // the file can disappear between the resolve above and this stat. That
      // is a 404, not an unhandled throw turning into a 500.
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile()) {
        return reply.code(404).send({ error: 'file_not_found' });
      }
      if (stat.size > MAX_ARTIFACT_BYTES) {
        return reply.code(413).send({ error: 'file_too_large' });
      }

      /*
       * The agent owns this directory and may be rewriting it right now,
       * so the file can vanish between the stat above and the open below.
       * Unguarded, that ENOENT surfaced as an unhandled 500; a file that
       * has just been deleted is a 404.
       */
      let stream: fs.ReadStream;
      try {
        stream = fs.createReadStream(file);
      } catch {
        return reply.code(404).send({ error: 'file_not_found' });
      }
      stream.on('error', () => stream.destroy());

      return reply
        .header('content-type', artifactContentType(file))
        .header('cache-control', 'private, no-store')
        // These bytes are agent output; nothing here should ever be treated
        // as markup for our own origin.
        .header('content-security-policy', "sandbox; default-src 'none'")
        .header('x-content-type-options', 'nosniff')
        .send(stream);
    },
  );

  /**
   * A local image an answer points at, by absolute path.
   *
   * Answers routinely contain `![shot](/Users/…/shot.png)`, because the
   * agent writes markdown for a reader who is on the same machine it is.
   * The webview is not, so without this the bubble renders a broken-image
   * icon -- reported from a live run, where the same screenshot displayed
   * fine in the work timeline (transcript data URIs) and not in the answer
   * above it.
   *
   * Deliberately NOT a general file route: `resolveLocalFile` accepts
   * three roots, images only, 10 MB, realpath-contained. Images are fetched
   * with credentials into blob URLs, so no `?token=` is accepted here.
   */
  app.get(
    '/api/sessions/:id/file',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { path?: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      const dir = resolveSessionDir(config.sessionsDir, id);
      if (!dir) return reply.code(404).send({ error: 'session_not_found' });

      const roots = localFileRoots({
        sessionDir: dir,
        uploadsDir,
        mediaDir: config.mediaDir,
      });
      const found = resolveLocalFile(roots, query.path, MAX_LOCAL_IMAGE_BYTES);
      if (!found.ok) {
        return reply
          .code(localFileStatus(found.reason))
          .send({ error: found.reason });
      }

      return reply
        .header('content-type', found.contentType)
        .header('cache-control', 'private, no-store')
        // Same posture as the artifact route: these bytes are agent output
        // and must never be treated as markup for our own origin.
        .header('content-security-policy', "sandbox; default-src 'none'")
        .header('x-content-type-options', 'nosniff')
        .send(fs.createReadStream(found.file));
    },
  );

  // --- Phase 2: write API ------------------------------------------------

  /**
   * Accept files from the phone and hand back the paths they landed on.
   *
   * Upload is a separate step from send, deliberately: the composer shows
   * chips the moment the OS picker returns, so the bytes are on their way
   * while the user is still typing, and a send with attachments is a plain
   * JSON call carrying paths.
   *
   * The paths returned here are the ONLY ones a later send will accept --
   * see `resolveAttachments`. A client cannot name an arbitrary file on the
   * machine and have it read out to the agent.
   */
  /**
   * Receipts for files this server stored, keyed by the path it handed out.
   *
   * Bounded in both directions. Left unbounded (which is how this started)
   * it is a map that only ever grows in a process meant to run for weeks,
   * and the bytes behind it accumulate under the uploads root with nothing
   * ever removing them. Entries age out after UPLOAD_TTL_MS -- comfortably
   * longer than the pick-then-send window the composer needs -- and the
   * oldest are evicted past MAX_UPLOAD_RECEIPTS regardless.
   */
  const uploadTokens = new Map<string, { saved: SavedUpload; at: number }>();

  const dropUpload = (key: string): boolean => {
    const entry = uploadTokens.get(key);
    if (!entry) return false;
    uploadTokens.delete(key);
    // Receipts and bytes have one lifecycle. Evicting only the map entry
    // used to leave private uploads accumulating on disk indefinitely.
    try {
      fs.rmSync(entry.saved.path, { force: true });
    } catch {
      // A file already gone is exactly the state we wanted.
    }
    return true;
  };

  const sweepUploads = (now = Date.now()): number => {
    let dropped = 0;
    for (const [key, entry] of uploadTokens) {
      if (now - entry.at < UPLOAD_TTL_MS) continue;
      if (dropUpload(key)) dropped += 1;
    }
    // Map iteration is insertion-ordered, so the head is the oldest.
    while (uploadTokens.size > MAX_UPLOAD_RECEIPTS) {
      const oldest = uploadTokens.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      if (dropUpload(oldest)) dropped += 1;
    }
    return dropped;
  };

  // Reclaim files whose in-memory receipts vanished in a prior process.
  sweepUploadDirectory(uploadsDir, UPLOAD_TTL_MS);
  const uploadSweeper = setInterval(() => {
    sweepUploads();
    sweepUploadDirectory(uploadsDir, UPLOAD_TTL_MS);
  }, UPLOAD_SWEEP_MS);
  uploadSweeper.unref?.();

  const takeUploads = async (
    request: FastifyRequest,
  ): Promise<{ files: SavedUpload[]; error?: string; status?: number }> => {
    const files: SavedUpload[] = [];
    try {
      for await (const part of (request as any).files()) {
        if (files.length >= MAX_UPLOAD_FILES) {
          return { files, error: 'too_many_files', status: 413 };
        }
        const data: Buffer = await part.toBuffer();
        // @fastify/multipart flags a stream it had to truncate rather than
        // throwing, so the cap is checked explicitly too.
        if (part.file?.truncated || data.length > MAX_UPLOAD_BYTES) {
          return { files, error: 'file_too_large', status: 413 };
        }
        const saved = saveUpload(
          uploadsDir,
          part.filename,
          data,
          part.mimetype,
        );
        uploadTokens.set(saved.path, { saved, at: Date.now() });
        sweepUploads();
        files.push(saved);
      }
    } catch (err) {
      if (err instanceof UploadError) {
        return {
          files,
          error: err.code === 'too_large' ? 'file_too_large' : err.code,
          status: 413,
        };
      }
      // @fastify/multipart enforces its own limits by throwing a coded
      // error rather than returning, and those are the same two conditions
      // as above -- so they get the same 413 rather than a generic 400.
      const code = (err as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') {
        return { files, error: 'file_too_large', status: 413 };
      }
      if (code === 'FST_FILES_LIMIT') {
        return { files, error: 'too_many_files', status: 413 };
      }
      request.log.error({ err }, 'upload failed');
      return { files, error: 'upload_failed', status: 400 };
    }
    if (!files.length) return { files, error: 'no_files', status: 400 };
    return { files };
  };

  /** Only paths this server itself handed out are ever passed to the agent. */
  const resolveAttachments = (raw: unknown): SavedUpload[] => {
    if (!Array.isArray(raw)) return [];
    const out: SavedUpload[] = [];
    for (const value of raw.slice(0, MAX_UPLOAD_FILES)) {
      const hit = typeof value === 'string' ? uploadTokens.get(value) : undefined;
      if (hit) out.push(hit.saved);
    }
    return out;
  };

  const uploadReply = async (request: FastifyRequest, reply: any) => {
    const { files, error, status } = await takeUploads(request);
    if (error) {
      // Multipart may have saved earlier parts before a later part failed.
      // A failed request issues no usable receipt, so reclaim those bytes now.
      for (const file of files) dropUpload(file.path);
      return reply.code(status || 400).send({ error });
    }
    return {
      files: files.map((f) => ({
        path: f.path,
        name: f.name,
        size: f.size,
        mimeType: f.mimeType,
      })),
    };
  };

  app.post(
    '/api/sessions/:id/attachments',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      return uploadReply(request, reply);
    },
  );

  /** The home composer has no session yet, so uploads are not scoped to one. */
  app.post(
    '/api/attachments',
    { preHandler: requireAuth },
    async (request, reply) => uploadReply(request, reply),
  );

  app.post(
    '/api/sessions/new',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = (request.body || {}) as Record<string, unknown>;
      const text = String(body.text ?? '').trim();
      const attachments = resolveAttachments(body.attachments);
      if (!text && !attachments.length) {
        return reply.code(400).send({ error: 'empty_text' });
      }
      if (text.length > MAX_MESSAGE_CHARS) {
        return reply.code(413).send({ error: 'text_too_long' });
      }
      const stored = settings.read();
      /**
       * "Confirm before acting", as the composer's switch now means it.
       *
       * It used to become `runtimeConfig.finalConfirm = true`, i.e. the
       * daemon-level mandate to call `request_action_confirmation` -- the
       * one tool that suspends a session on a prompt no phone can answer.
       * A switch whose ON position guarantees a dead session is not a
       * safety feature. It is a stronger line in the preamble instead.
       */
      const strictConfirm =
        typeof body.finalConfirm === 'boolean'
          ? body.finalConfirm
          : Boolean(stored.defaultFinalConfirm);
      const mode = isPermissionMode(body.permissionMode)
        ? body.permissionMode
        : (stored.defaultPermissionMode ?? undefined);
      try {
        const { sessionId } = await runner.createSession(
          {
            // The mobile-session preamble rides on the first prompt only.
            // It is what stops the agent calling `ask_user_question`, which
            // suspends the session on a question no phone can answer -- see
            // preamble.ts. It is stripped back out for display.
            text: withPreamble(
              promptWithAttachments(text, attachments.map((f) => f.path)),
              { strictConfirm },
            ),
            // An explicit pick from the composer wins; the stored default is
            // only consulted when the client sent nothing.
            model: runner.resolveModel(
              resolveNewSessionModel(stored, body.model),
            ),
            effort: runner.resolveEffort(body.effort ?? stored.defaultEffort),
          },
          {
            // CLI 1.26.902 can bind Guard/full-access before the first turn.
            // Read-only is still applied through the daemon update below.
            permissionMode: mode,
          },
        );

        softConfirm.set(sessionId, strictConfirm);

        // A permission choice made on the home composer applies to the
        // session the send just created. CLI-supported modes now bind on
        // that first turn; this update keeps the daemon row authoritative
        // and still handles read-only.
        //
        // The stored default backs the composer's choice rather than
        // overriding it, and stays null unless the owner set one -- this
        // app does not widen permissions on its own. See settings.ts.
        /**
         * Always OFF, on every session this app creates.
         *
         * Not "leave it alone": the account-level default is inherited by
         * a new session, so an owner who has `finalConfirm` on for their
         * desktop work gets it on a session started from their phone too
         * -- and that is a SYSTEM instruction requiring the native
         * confirmation tool, which outranks the preamble above and bricks
         * the session the first time the agent touches anything external.
         * Writing false explicitly is the only way to be sure.
         *
         * Residual risk, stated honestly: `finalConfirm` still has no CLI
         * creation flag, so clearing an inherited desktop default binds on
         * the NEXT spawn. The mobile preamble remains the cover for the
         * first turn and names the incompatible tools explicitly.
         */
        void applyPermission(
          {
            facade,
            readRuntimeConfig: async (sid) =>
              (await stateDb.read(sid)).runtimeConfig,
          },
          sessionId,
          { mode, finalConfirm: false },
        )
          .then(() => stateDb.invalidate(sessionId))
          .catch((err) =>
            request.log.error({ err }, 'new-session permission apply failed'),
          );

        return { sessionId, accepted: true, softConfirm: strictConfirm };
      } catch (err) {
        request.log.error({ err }, 'new session failed');
        return reply
          .code(502)
          .send({ error: 'session_create_failed', reason: (err as Error).message });
      }
    },
  );

  app.post(
    '/api/sessions/:id/send',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body || {}) as Record<string, unknown>;
      const text = String(body.text ?? '').trim();
      const attachments = resolveAttachments(body.attachments);
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      if (!text && !attachments.length) {
        return reply.code(400).send({ error: 'empty_text' });
      }
      if (text.length > MAX_MESSAGE_CHARS) {
        return reply.code(413).send({ error: 'text_too_long' });
      }
      if (!sessionMsgFile(config.sessionsDir, id)) {
        return reply.code(404).send({ error: 'session_not_found' });
      }

      /**
       * Refuse rather than jam.
       *
       * A session suspended on a native `ask_user_question` accepts an
       * `aside exec` and then never returns from it -- verified today
       * against the live CLI. Queuing one turns a recoverable state into a
       * permanently wedged session, so it is a 409 with a reason the client
       * can put on screen instead.
       */
      stateDb.invalidate(id);
      const live = await stateDb.read(id);
      if (isSuspended(live.status)) {
        return reply.code(409).send({
          error: 'session_suspended',
          reason:
            'This session is waiting on a question that can only be answered from Aside on your computer.',
        });
      }

      const { queued } = runner.send(id, {
        /**
         * The one-line reminder rides on every follow-up.
         *
         * The preamble is on the first message only, and a long session
         * gets compacted -- the instruction is exactly the kind of
         * housekeeping a summariser drops, after which the next question
         * is a native tool call and the session is unrecoverable. See
         * `MOBILE_FOLLOWUP_REMINDER`. It is appended, so it composes with
         * the attachment header (which is prepended) and cannot make the
         * prompt dash-leading.
         */
        text: withReminder(
          promptWithAttachments(text, attachments.map((f) => f.path)),
          { strictConfirm: softConfirm.has(id) },
        ),
        model: runner.resolveModel(body.model),
        effort: runner.resolveEffort(body.effort),
      });
      return { accepted: true, queued, busy: runner.isBusy(id) };
    },
  );

  /**
   * Stop the turn a session is running.
   *
   * Phone-owned turns still stop by their exact child PID. CLI 1.26.902
   * added `aside session stop`, so a live turn started on the Mac can now be
   * aborted through the daemon too. No process-name matching is used.
   */
  app.post(
    '/api/sessions/:id/stop',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      if (runner.stop(id)) {
        return { ok: true, stopping: true, owner: 'mobile' };
      }

      const msgFile = sessionMsgFile(config.sessionsDir, id);
      const state = await stateDb.readFresh(id);
      const appearsLive = !isSuspended(state.status) && (
        state.status === 'running' || (Boolean(msgFile) &&
        !ownedTurns.settled(id, msgFile) && transcriptIsLive(msgFile!)));
      if (!appearsLive) {
        return reply.code(409).send({ error: 'not_running' });
      }
      if (!(await runner.stopRemote(id))) {
        return reply.code(502).send({ error: 'stop_failed' });
      }

      // Suppress the transcript-mtime liveness heuristic immediately. A
      // later write clears this mark, so a genuine new turn is still seen.
      ownedTurns.markFinished(id, msgFile);
      return { ok: true, stopping: true, owner: 'desktop' };
    },
  );

  /**
   * Answer a soft-protocol question by sending the choice as a message.
   *
   * Deliberately its own route rather than a plain send: it is the one
   * place that must never be pointed at a suspended session (a native
   * pending tool cannot be answered this way, and trying is what hangs a
   * driver), and having a named endpoint keeps that check in one place.
   */
  app.post(
    '/api/sessions/:id/answer',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body || {}) as Record<string, unknown>;
      const label = String(body.label ?? '').trim();
      const header = String(body.header ?? '').trim();
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      if (!label) return reply.code(400).send({ error: 'empty_answer' });
      if (!sessionMsgFile(config.sessionsDir, id)) {
        return reply.code(404).send({ error: 'session_not_found' });
      }

      stateDb.invalidate(id);
      const live = await stateDb.read(id);
      if (isSuspended(live.status)) {
        return reply.code(409).send({
          error: 'session_suspended',
          reason:
            'This question is waiting on Aside on your computer and cannot be answered from here.',
        });
      }

      const { queued } = runner.send(id, {
        // Same reminder as an ordinary send. Appended, so the answer text
        // still leads the prompt and the `--` terminator still covers a
        // label that begins with a dash.
        text: withReminder(answerMessage(header, label), {
          strictConfirm: softConfirm.has(id),
        }),
        model: runner.resolveModel(body.model),
        effort: runner.resolveEffort(body.effort),
      });
      return { accepted: true, queued, busy: runner.isBusy(id) };
    },
  );

  /**
   * Carry on from a session that is stuck on a desktop-only question.
   *
   * There is no unsticking one. The daemon holds it suspended waiting for
   * an answer over the sidepanel's authenticated channel, and nothing this
   * server can send reaches that channel -- verified against the live CLI
   * in every form. So the way forward is sideways: a NEW session, carrying
   * the full mobile preamble, seeded with what was asked and what the user
   * just tapped. See `recoveryPrompt`.
   *
   * The stuck session is left exactly as it is. It is still readable, and
   * pretending otherwise would be the same dishonesty the read-only banner
   * exists to avoid.
   */
  const recoveryFlights = new Set<string>();
  const recoveryResults = new Map<string, { sessionId: string; accepted: boolean; from: string }>();
  app.post(
    '/api/sessions/:id/recover',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body || {}) as Record<string, unknown>;
      const answer = String(body.answer ?? '').trim();
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      const msgFile = sessionMsgFile(config.sessionsDir, id);
      if (!msgFile) {
        return reply.code(404).send({ error: 'session_not_found' });
      }

      // The question comes from the server's own thread build rather than
      // from the request body: the client could send anything, and what
      // the new session is told the old one asked has to be true.
      const pendingItems = buildThread(readHistory(msgFile), false);
      const requestedQuestion = typeof body.questionId === 'string' ? body.questionId : '';
      const question = requestedQuestion
        ? pendingNativeQuestion(pendingItems.filter(item => item.id === requestedQuestion) as any)
        : pendingNativeQuestion(pendingItems as any);
      if (!question) {
        return reply.code(409).send({ error: 'no_pending_question' });
      }

      const recoveryKey = id + ':' + question.id;
      const existingRecovery = recoveryResults.get(recoveryKey);
      if (existingRecovery) return existingRecovery;
      if (recoveryFlights.has(recoveryKey)) {
        return reply.code(409).send({ error: 'recovery_in_progress' });
      }
      const stored = settings.read();
      const strictConfirm = softConfirm.has(id);
      const seed = recoveryPrompt({
        sourceSessionId: id,
        sourceTranscriptPath: msgFile,
        question,
        answer,
        firstMessage: stripAgentDirectives(firstUserText(msgFile)),
      });

      recoveryFlights.add(recoveryKey);
      try {
        const { sessionId } = await runner.createSession({
          text: withPreamble(seed, { strictConfirm }),
          model: runner.resolveModel(
            resolveNewSessionModel(stored, body.model),
          ),
          effort: runner.resolveEffort(body.effort ?? stored.defaultEffort),
        });
        softConfirm.set(sessionId, strictConfirm);
        // Same reasoning as the create route: never inherit the account's
        // native final-confirm onto a session driven from a phone.
        void applyPermission(
          {
            facade,
            readRuntimeConfig: async (sid) =>
              (await stateDb.read(sid)).runtimeConfig,
          },
          sessionId,
          {
            mode: stored.defaultPermissionMode ?? undefined,
            finalConfirm: false,
          },
        )
          .then(() => stateDb.invalidate(sessionId))
          .catch((err) =>
            request.log.error({ err }, 'recovery permission apply failed'),
          );
        const result = { sessionId, accepted: true, from: id };
        recoveryResults.set(recoveryKey, result);
        if (recoveryResults.size > 256) recoveryResults.delete(recoveryResults.keys().next().value!);
        return result;
      } catch (err) {
        request.log.error({ err }, 'recovery session failed');
        return reply
          .code(502)
          .send({ error: 'session_create_failed', reason: (err as Error).message });
      } finally {
        recoveryFlights.delete(recoveryKey);
      }
    },
  );

  // --- settings ----------------------------------------------------------

  app.get('/api/settings', { preHandler: requireAuth }, async () => ({
    settings: settings.read(),
  }));

  /**
   * Partial update. Only the keys the body carries are touched, so a client
   * that knows about one field cannot blank the others.
   */
  app.post(
    '/api/settings',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return reply.code(400).send({ error: 'bad_body' });
      }
      return { settings: settings.write(body) };
    },
  );

  /**
   * Change a session's permission mode and/or its confirm-before-acting
   * toggle.
   *
   * Honest about scope: the daemon reads both when it spawns the next
   * `aside exec`, so a change takes effect from the next message rather
   * than reaching into a turn already running. The UI says the same.
   *
   * The confirm toggle forks on where the session came from. On one this
   * app or bridge.py started -- a session being DRIVEN FROM A PHONE -- the
   * native `finalConfirm` flag is never set true, because it is the
   * daemon-level mandate to call `request_action_confirmation` and that
   * tool can only be answered from the desktop sidepanel. Turning a safety
   * switch on must not be the thing that kills the session. It writes the
   * soft flag instead (see softconfirm.ts), which becomes a stronger line
   * in the preamble and in every follow-up reminder.
   *
   * On a session started at the owner's desk the sidepanel IS there, so
   * the switch keeps its original meaning and writes the daemon's flag.
   */
  app.post(
    '/api/sessions/:id/permission',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body || {}) as Record<string, unknown>;
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      if (!sessionMsgFile(config.sessionsDir, id)) {
        return reply.code(404).send({ error: 'session_not_found' });
      }

      const hasMode = body.mode !== undefined;
      const hasConfirm = body.finalConfirm !== undefined;
      if (!hasMode && !hasConfirm) {
        return reply.code(400).send({ error: 'nothing_to_change' });
      }
      if (hasMode && !isPermissionMode(body.mode)) {
        return reply.code(400).send({ error: 'bad_mode' });
      }
      if (hasConfirm && typeof body.finalConfirm !== 'boolean') {
        return reply.code(400).send({ error: 'bad_final_confirm' });
      }

      const mobile = isMobileSession(config.sessionsDir, id);
      const wanted = hasConfirm ? (body.finalConfirm as boolean) : undefined;
      if (hasConfirm && mobile) softConfirm.set(id, Boolean(wanted));

      try {
        await applyPermission(
          {
            facade,
            readRuntimeConfig: async (sid) =>
              (await stateDb.read(sid)).runtimeConfig,
          },
          id,
          {
            mode: hasMode ? (body.mode as any) : undefined,
            // On a mobile session the native flag is forced OFF rather
            // than left alone: it may already be true, inherited from the
            // account default, and this is the moment to clear it.
            finalConfirm: hasConfirm ? (mobile ? false : wanted) : undefined,
          },
        );
      } catch (err) {
        request.log.error({ err }, 'permission update failed');
        return reply.code(502).send({ error: 'permission_update_failed' });
      }

      // The write went through the daemon, so every cached read of this
      // session is now stale.
      stateDb.invalidate(id);
      facade.invalidate(`session:${id}`);

      const state = await stateDb.read(id);
      return {
        ok: true,
        permission: state.permission,
        permissionMode: state.permissionMode,
        /**
         * What the switch shows. On a mobile session that is the soft flag
         * -- reporting the daemon's (always false) value would flick the
         * switch back off under the owner's thumb.
         */
        finalConfirm: mobile ? softConfirm.has(id) : state.finalConfirm,
        /** True when the toggle means the soft protocol, not the daemon's. */
        softConfirm: mobile,
        fullAccess: isFullAccess(state.permission),
        /** The change binds on the next spawn, not on the running turn. */
        appliesFrom: 'next-message',
      };
    },
  );

  /** Persist a thread's model and reasoning level in the desktop daemon. */
  app.post(
    '/api/sessions/:id/model',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body || {}) as Record<string, unknown>;
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      if (!sessionMsgFile(config.sessionsDir, id)) {
        return reply.code(404).send({ error: 'session_not_found' });
      }
      const provider = String(body.provider || '').trim();
      const modelId = String(body.modelId || '').trim();
      const thinkingLevel = String(body.effort || '').trim();
      const providerEntry = currentCatalog().find((entry) => entry.id === provider);
      if (!providerEntry?.models.some((entry) => entry.id === modelId)) {
        return reply.code(400).send({ error: 'bad_model' });
      }
      if (!EFFORT_LEVELS.includes(thinkingLevel as any)) {
        return reply.code(400).send({ error: 'bad_effort' });
      }

      const current = await stateDb.readFresh(id);
      try {
        await applySessionModel(
          facade,
          id,
          { provider, modelId, thinkingLevel },
          current.model,
        );
      } catch (err) {
        request.log.error({ err }, 'session model update failed');
        return reply.code(502).send({ error: 'model_update_failed' });
      }
      stateDb.invalidate(id);
      facade.invalidate(`session:${id}`);

      // The daemon owns the result. Read it back instead of echoing a wish.
      const state = await stateDb.readFresh(id);
      const actual = state.model;
      return {
        ok: true,
        model: actual
          ? {
              provider: actual.provider,
              modelId: actual.modelId,
              label: modelLabel(catalog, actual.provider, actual.modelId),
              effort: actual.thinkingLevel || null,
              effortLabel: actual.thinkingLevel
                ? EFFORT_LABELS[actual.thinkingLevel] || actual.thinkingLevel
                : null,
            }
          : null,
        appliesFrom: 'next-message',
      };
    },
  );

  app.get('/api/status', { preHandler: requireAuth }, async () => {
    const status = runner.status();

    // Aside's own current default, so the pills open showing what the
    // browser shows rather than a config guess.
    //
    // Three sources, most authoritative first. settings.json is the same
    // value the daemon would report, read straight off disk, so it is a far
    // better second than the hand-maintained config -- the config had gone
    // stale enough that the phone showed a model the desktop had not used
    // in days.
    //
    // The daemon is PEEKED, not awaited. Asking it costs a ~139MB process
    // spawn, and this route is fetched during app boot: measured against
    // the live service on 2026-09-01, awaiting it made `/api/status` take
    // 6562ms while `/api/sessions` next to it took 39ms. Since the disk
    // copy answers the same question, waiting bought nothing and cost the
    // whole boot. The peek serves the last value and refreshes behind the
    // response, so the daemon's answer is still what shows -- one request
    // later at worst.
    const daemonDefault = peekDefaultModel(facade);
    const desktop = readDesktopState(config.sessionsDir);
    const fallback = desktop.defaultModel;

    /*
     * A phone-side override outranks everything above it.
     *
     * Not for correctness of the pill alone -- for honesty. `resolveNewSessionModel`
     * already prefers this override when it starts a session, so a status
     * route that ignored it advertised one model in the composer and then
     * ran a different one. The pill has to name the model that will
     * actually answer, or it is worse than no pill.
     */
    const override = settings.read();
    const hasOverride = Boolean(
      override.defaultProvider && override.defaultModelId,
    );

    const configuredSplit = config.defaultModel.indexOf('/');
    const configuredModelId = configuredSplit > 0
      ? config.defaultModel.slice(configuredSplit + 1)
      : config.defaultModel;
    const configuredProvider = configuredSplit > 0
      ? config.defaultModel.slice(0, configuredSplit)
      : catalog.find((entry) =>
          entry.models.some((model) => model.id === configuredModelId),
        )?.id || '';
    const provider = hasOverride
      ? override.defaultProvider
      : daemonDefault?.provider || fallback?.provider || configuredProvider;
    const modelId = hasOverride
      ? override.defaultModelId
      : daemonDefault?.modelId || fallback?.modelId || configuredModelId;
    const effort =
      (hasOverride && override.defaultEffort) ||
      daemonDefault?.thinkingLevel ||
      fallback?.thinkingLevel ||
      config.defaultEffort;

    return {
      uptimeMs: Date.now() - startedAt,
      inFlight: status.inFlight,
      queued: status.queued,
      catalog,
      efforts: EFFORT_LEVELS,
      /** What the Reasoning popover offers, in Aside's order. */
      effortMenu: EFFORT_MENU.map((id) => ({ id, label: EFFORT_LABELS[id] })),
      /** What the Permission popover offers, in Aside's order. */
      permissionMenu: PERMISSION_MENU,
      uploads: { maxFiles: MAX_UPLOAD_FILES, maxBytes: MAX_UPLOAD_BYTES },
      defaults: {
        provider,
        modelId,
        modelLabel: modelLabel(catalog, provider, modelId),
        effort,
        effortLabel: EFFORT_LABELS[effort] || effort,
      },
      permission: process.env.MINIAPP_GRANT_FULL_ACCESS === '1'
        ? 'Full access'
        : 'Guard',
      /**
       * What the settings screen's Connection section reports.
       *
       * Deliberately free of anything sensitive: no token, no user id, no
       * absolute paths. `bridgeRunning` is inferred from whether the Python
       * bridge's config directory is on disk, which is all this process can
       * honestly say about a service it does not own.
       */
      service: {
        version: opts.version || '',
        /** `cloudflared` or `none`, straight from the config. */
        tunnel: config.miniapp.tunnel,
        tunnelUrl: opts.publicUrl?.() || null,
        port: config.port,
        // The daemon answering the facade at all is the useful signal.
        asideReachable: daemonDefault !== null,
        bridgeConfigured: fs.existsSync(
          path.join(config.miniapp.stateDir, 'config.json'),
        ),
      },
    };
  });

  // --- SPA hosting -------------------------------------------------------
  if (opts.webDist && fs.existsSync(opts.webDist)) {
    const webDist = opts.webDist;
    /*
     * `index: false` because `/` is handled explicitly below. Left on, the
     * static plugin answers `/` with the raw `index.html` and there is no
     * way to register a route that gets there first.
     */
    await app.register(fastifyStatic, {
      root: webDist,
      index: false,
      /**
       * Serve the `.br` / `.gz` the build emits alongside each asset.
       *
       * Without this the phone downloaded the bundle raw: measured against
       * this service, the main chunk was 512KB with no content-encoding at
       * all, out of 1.99MB of emitted JS and CSS. Compressed that set is
       * 522KB. Over a tailnet from a phone this was the single largest
       * component of "everything loads slow", and it was paid again on
       * every new build because the URLs are content-hashed.
       *
       * Precompressed rather than on-the-fly: these files never change, so
       * the CPU cost belongs in the build, not in the request path.
       */
      preCompressed: true,
      /*
       * The APK has no Content-Disposition without this, and mobile Chrome
       * is inconsistent about turning a bare `application/vnd.android.
       * package-archive` response into an actual file-manager download
       * without one -- it can just sit there looking like nothing
       * happened. Everything else served from here is meant to be
       * navigated to, not saved, so this only touches the one file.
       */
      setHeaders: (reply, filePath) => {
        if (filePath.endsWith('.apk')) {
          reply.header(
            'Content-Disposition',
            `attachment; filename="${path.basename(filePath)}"`,
          );
        }
        /*
         * Vite content-hashes everything under /assets/ (and the icon set
         * under /icons/ never changes without a filename change either),
         * so these are safe to cache forever -- a changed file gets a new
         * URL, it never overwrites the old one in place. Without this
         * every launch revalidates ~575KB over the tailnet for bytes that
         * cannot have changed. HTML (`/`, `/app`) deliberately keeps the
         * default no-cache behavior below since that's what points at the
         * current hashed asset names.
         */
        const rel = path.relative(webDist, filePath);
        if (rel.startsWith(`assets${path.sep}`) || rel.startsWith(`icons${path.sep}`)) {
          reply.header('cache-control', 'public, max-age=31536000, immutable');
        }
      },
    });

    /**
     * Standalone entry for the installed app.
     *
     * Same bundle as `/`, one tag lighter. Loading Telegram's bridge script
     * outside Telegram is actively harmful rather than merely useless: it
     * defines `window.Telegram.WebApp.CloudStorage`, whose callbacks are
     * answered by the Telegram host and by nothing else. Off-Telegram those
     * promises never settle, so the boot `await cloudStorage.getItem(...)`
     * hangs and the app sits on its spinner forever. With the tag gone the
     * shim's own fallbacks (localStorage, window.confirm, no-op haptics)
     * take over and everything works.
     */
    const indexPath = path.join(opts.webDist, 'index.html');
    let standaloneHtml: string | null = null;
    let standaloneMtime = 0;

    function renderStandalone(): string {
      const mtime = fs.statSync(indexPath).mtimeMs;
      if (!standaloneHtml || mtime !== standaloneMtime) {
        standaloneMtime = mtime;
        standaloneHtml = fs
          .readFileSync(indexPath, 'utf8')
          .replace(
            /<script\b[^>]*\bsrc=["']https:\/\/telegram\.org\/js\/telegram-web-app\.js["'][^>]*>\s*<\/script>/i,
            '<!-- standalone build: Telegram bridge deliberately omitted -->',
          )
          .replace(
            '</head>',
            [
              '  <link rel="manifest" href="/manifest.webmanifest" />',
              '  <meta name="theme-color" content="#f9f9f7" />',
              '  <meta name="mobile-web-app-capable" content="yes" />',
              '  <meta name="apple-mobile-web-app-capable" content="yes" />',
              /*
               * `default`, not `black-translucent`.
               *
               * Translucent is the one that looks better in screenshots:
               * the page runs edge to edge underneath the clock and
               * battery. It also requires the layout to pad itself by
               * `env(safe-area-inset-top)`, and this one does not -- every
               * inset it honours is a bottom inset. Choosing translucent
               * would slide the top of the header under the status bar on
               * every notched iPhone. `default` leaves iOS to reserve that
               * strip and tint it with the theme colour.
               */
              '  <meta name="apple-mobile-web-app-status-bar-style" content="default" />',
              '  <meta name="apple-mobile-web-app-title" content="Aside" />',
              /*
               * The purpose-built 180x180, which is the size iOS asks for.
               * This pointed at the 192x192 PWA icon, which works only
               * because iOS rescales it, and rescaling a rounded-square app
               * icon is exactly where softness shows.
               */
              '  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />',
              ...APPLE_LAUNCH_SCREENS,
              '</head>',
            ].join('\n'),
          );
      }
      return standaloneHtml;
    }

    app.get('/app', async (_request, reply) => {
      return reply.type('text/html; charset=utf-8').send(renderStandalone());
    });

    /**
     * The bare origin.
     *
     * A standalone install has exactly one front door and it is `/app`.
     * Serving the unmodified `index.html` here, which is what the static
     * plugin did, hands a phone the Telegram build: it pulls a script from
     * telegram.org and, more to the point, carries no `manifest.webmanifest`
     * link, so iOS Add to Home Screen produces a plain bookmark instead of
     * an installed web app. That in turn costs push and the storage
     * exemption, which is most of the reason to install it at all.
     *
     * Typing the tailnet hostname with no path is the obvious thing to do,
     * so redirect rather than document a path nobody will read. 302 and not
     * 301: configuring a bot token later makes `/` meaningful again, and a
     * permanent redirect would already be cached on every phone.
     */
    app.get('/', async (_request, reply) => {
      if (config.standalone) return reply.redirect('/app', 302);
      return reply.sendFile('index.html');
    });

    /**
     * Pairing page: moved, and this is the sign on the door.
     *
     * The real page is on a separate loopback-only listener (see `pair.ts`).
     * It is not served here at any IP, for anyone, because this port is the
     * one `tailscale serve` proxies -- and behind that proxy every request
     * looks like it came from `127.0.0.1`, so an IP check here decides
     * nothing. Refusing unconditionally is the only honest answer this
     * listener can give.
     */
    app.get('/pair', async (_request, reply) => {
      const pairPort = opts.pairPort ?? config.port + 1;
      return reply.code(403).type('text/html; charset=utf-8').send(
        '<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:2rem">' +
          '<h1>Not here</h1><p>The pairing page is only served on the Mac itself, ' +
          'on a port nothing proxies. Open it there:</p>' +
          `<p><code>http://127.0.0.1:${pairPort}/pair</code></p></body>`,
      );
    });

    /*
     * SPA fallback. Same reasoning as `/`: in standalone mode every deep
     * link has to land on the standalone shell, or a stale icon, a shared
     * link or a service-worker miss drops the phone onto the Telegram build.
     */
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (config.standalone) {
        return reply.type('text/html; charset=utf-8').send(renderStandalone());
      }
      return reply.sendFile('index.html');
    });
  }

  /**
   * Inbound side of the Day 2 control loop (plan 6.2/6.3).
   *
   * bridge.py owns the ONLY `getUpdates` poller against this bot token
   * (see 4.2 -- a second poller steals the first one's updates). When a
   * tap lands on one of THIS app's push notifications, bridge.py relays
   * the callback data here rather than acting on it itself.
   *
   * Gated by loopback origin plus a shared secret -- the same HS256
   * signing secret this server already keeps at `config.secretPath` --
   * rather than a bearer JWT, because the caller is a local process on the
   * same machine, not a phone that went through /api/auth.
   */
  app.post('/api/internal/callback', async (request, reply) => {
    const ip = String(request.ip || '');
    const fromLoopback =
      ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!fromLoopback) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const given = Buffer.from(String(request.headers['x-internal-secret'] || ''));
    const expected = Buffer.from(opts.jwtSecret);
    const authorized =
      given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!authorized) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const body = (request.body || {}) as { data?: string };
    const data = String(body.data || '');

    if (data.startsWith('stop:')) {
      const id = data.slice('stop:'.length);
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      const stopped = runner.stop(id);
      if (stopped) void notifier.resolveInPlace(id, '⏹ Stopped from Telegram.');
      return { ok: true, stopped };
    }

    if (data.startsWith('q:')) {
      const [, sessionId, questionId, indexRaw] = data.split(':');
      if (!sessionId || !isValidSessionId(sessionId)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      const msgFile = sessionMsgFile(config.sessionsDir, sessionId);
      if (!msgFile || !fs.existsSync(msgFile)) {
        return reply.code(404).send({ error: 'session_not_found' });
      }
      const busy = runner.isBusy(sessionId);
      const snapshot = threads.build(
        sessionId,
        msgFile,
        busy,
        subagents.snapshot(sessionId, busy),
      );
      const item = snapshot.items.find(
        (candidate) => candidate.kind === 'question' && candidate.id === questionId,
      );
      if (
        !item ||
        item.kind !== 'question' ||
        item.status !== 'pending' ||
        !item.answerable
      ) {
        // Already answered -- most likely from the mini app itself while
        // the push was in flight -- or stale. Say so instead of
        // double-sending a follow-up the agent never asked for again.
        void notifier.resolveInPlace(
          sessionId,
          'This question was already answered.',
        );
        return { ok: true, stale: true };
      }
      const block = item.questions[0];
      const option = block?.options[Number(indexRaw)];
      if (!block || !option) {
        return reply.code(400).send({ error: 'bad_option' });
      }
      runner.send(sessionId, {
        text: withReminder(answerMessage(block.header, option.label), {
          strictConfirm: softConfirm.has(sessionId),
        }),
        model: runner.resolveModel(undefined),
        effort: runner.resolveEffort(undefined),
      });
      void notifier.resolveInPlace(
        sessionId,
        `${block.header ? `${block.header}: ` : ''}${option.label} ✓`,
      );
      return { ok: true };
    }

    return reply.code(400).send({ error: 'unknown_callback' });
  });

  // --- Day 3: the browser surfaces (plan section 7) ----------------------
  // Every route here goes through the same facade every read in this file
  // already uses -- no new transport, no new failure mode.
  const captureGate = new CaptureGate();

  const isValidTargetId = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);

  const sendBrowserError = (reply: any, err: unknown) => {
    if (err instanceof BrowserError) {
      const status =
        err.code === 'bad_url'
          ? 400
          : err.code === 'not_found'
            ? 404
            : err.code === 'rate_limited'
              ? 429
              : err.code === 'capture_busy'
                ? 409
                : 502;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    app.log.warn({ err }, 'browser route failed');
    return reply.code(502).send({ error: 'upstream' });
  };

  app.get('/api/tabs', { preHandler: requireAuth }, async () => ({
    tabs: await listTabs(facade),
  }));

  app.post(
    '/api/tabs',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = (request.body || {}) as { url?: string };
      try {
        const opened = await openNewTab(facade, String(body.url || ''));
        return opened;
      } catch (err) {
        return sendBrowserError(reply, err);
      }
    },
  );

  app.delete(
    '/api/tabs/:targetId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { targetId } = request.params as { targetId: string };
      if (!isValidTargetId(targetId)) {
        return reply.code(400).send({ error: 'bad_target_id' });
      }
      try {
        const closed = await closeBrowserTab(facade, targetId);
        return { closed };
      } catch (err) {
        return sendBrowserError(reply, err);
      }
    },
  );

  app.get(
    '/api/tabs/:targetId/capture',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { targetId } = request.params as { targetId: string };
      if (!isValidTargetId(targetId)) {
        return reply.code(400).send({ error: 'bad_target_id' });
      }
      const query = request.query as { q?: string };
      const quality = Number(query.q) || undefined;
      try {
        const result = await captureGate.run(targetId, () =>
          captureTab(facade, targetId, { quality }),
        );
        return {
          dataUrl: `data:image/webp;base64,${result.base64}`,
          url: result.url,
          capturedAt: result.capturedAt,
        };
      } catch (err) {
        return sendBrowserError(reply, err);
      }
    },
  );

  app.get(
    '/api/tabs/:targetId/snapshot',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { targetId } = request.params as { targetId: string };
      if (!isValidTargetId(targetId)) {
        return reply.code(400).send({ error: 'bad_target_id' });
      }
      try {
        return await snapshotTab(facade, targetId);
      } catch (err) {
        return sendBrowserError(reply, err);
      }
    },
  );

  /**
   * The same capture as `/capture`, but as raw `image/webp` bytes fetched
   * with credentials into a blob URL. Story sharing is retired, so nothing
   * needs a server-fetchable URL anymore.
   */
  app.get(
    '/api/tabs/:targetId/capture.webp',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { targetId } = request.params as { targetId: string };
      if (!isValidTargetId(targetId)) {
        return reply.code(400).send({ error: 'bad_target_id' });
      }
      const query = request.query as { q?: string };
      const quality = Number(query.q) || undefined;
      try {
        const result = await captureGate.run(targetId, () =>
          captureTab(facade, targetId, { quality }),
        );
        reply.header('cache-control', 'no-store');
        return reply
          .type('image/webp')
          .send(Buffer.from(result.base64, 'base64'));
      } catch (err) {
        return sendBrowserError(reply, err);
      }
    },
  );

  // --- Day 4: depth (plan section 8) --------------------------------------

  /** Read-only memory browser (8.1). No write route exists anywhere in this file, on purpose -- see memorybrowser.ts's own header. */
  const memoryRoot = path.join(defaultAsideRoot(), 'memory');

  app.get('/api/memory', { preHandler: requireAuth }, async () => ({
    tree: buildMemoryTree(memoryRoot),
  }));

  app.get(
    '/api/memory/file',
    { preHandler: requireAuth },
    async (request, reply) => {
      const query = request.query as { path?: string };
      const file = resolveMemoryFile(memoryRoot, query.path);
      if (!file) return reply.code(404).send({ error: 'not_found' });
      try {
        return { content: readMemoryFile(file) };
      } catch {
        return reply.code(404).send({ error: 'not_found' });
      }
    },
  );

  /**
   * Read-only routines (8.2). The facade's own surface is `list`/`get`
   * ONLY -- verified against the live daemon, see the build plan's section
   * 1.4. Create/update/delete (and, in practice, pause/resume: the facade
   * exposes no mutation at all) would need a full `aside exec` turn calling
   * the `routine_update` tool, which is a different cost model entirely and
   * is deliberately not wired up here.
   */
  app.get('/api/routines', { preHandler: requireAuth }, async () => ({
    routines: await fetchRoutines(facade),
  }));

  /** Full-text search across transcripts on disk (8.7). */
  app.get(
    '/api/search',
    { preHandler: requireAuth },
    async (request) => {
      const query = request.query as { q?: string };
      return { hits: searchTranscripts(config.sessionsDir, String(query.q || '')) };
    },
  );

  /**
   * PDF text (8.3), scoped to a session's own artifacts/attachments --
   * exactly the same containment `resolveArtifact` already gives the
   * download route, so this adds no new filesystem surface.
   */
  app.get(
    '/api/sessions/:id/pdf',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { path?: string; group?: string };
      if (!isValidSessionId(id)) {
        return reply.code(400).send({ error: 'bad_session_id' });
      }
      const group: ArtifactGroup = isArtifactGroup(query.group)
        ? query.group
        : 'artifacts';
      const dir = resolveSessionDir(config.sessionsDir, id);
      if (!dir) return reply.code(404).send({ error: 'session_not_found' });
      const file = resolveArtifact(dir, group, String(query.path ?? ''));
      if (!file || path.extname(file).toLowerCase() !== '.pdf') {
        return reply.code(403).send({ error: 'forbidden_path' });
      }
      try {
        const text = await facade.mutate(
          `aside.pdf.read(${JSON.stringify(file)})`,
        );
        return { text };
      } catch (err) {
        app.log.warn({ err }, 'pdf read failed');
        return reply.code(502).send({ error: 'pdf_read_failed' });
      }
    },
  );

  attachWebSocket({
    app,
    config,
    runner,
    watchers,
    threads,
    subagents,
    jwtSecret: opts.jwtSecret,
    viewers,
    readSessionState: async (id) => {
      const state = await stateDb.readFresh(id);
      const file = sessionMsgFile(config.sessionsDir, id);
      const status = state.status || 'idle';
      const mobile = isMobileSession(config.sessionsDir, id);
      const rawTitle = state.title || '';
      const title = isPlaceholderTitle(rawTitle)
        ? titleFromTranscript(config.sessionsDir, id) || rawTitle
        : rawTitle;
      const model = state.model
        ? {
            provider: state.model.provider,
            modelId: state.model.modelId,
            label: modelLabel(catalog, state.model.provider, state.model.modelId),
            effort: state.model.thinkingLevel || null,
            effortLabel: state.model.thinkingLevel
              ? EFFORT_LABELS[state.model.thinkingLevel] || state.model.thinkingLevel
              : null,
          }
        : null;
      const busy =
        status === 'running' || runner.isBusy(id) ||
        isSuspended(status) ||
        (!ownedTurns.settled(id, file) &&
          Boolean(file && transcriptIsLive(file)));
      return {
        title,
        status,
        busy,
        stoppable: busy && !isSuspended(status),
        queued: runner.queuedCount(id),
        permission: state.permission,
        permissionMode: state.permissionMode,
        finalConfirm: mobile ? softConfirm.has(id) : state.finalConfirm,
        softConfirm: mobile,
        model,
        contextWindow: state.model
          ? contextWindowFor(catalog, state.model.provider, state.model.modelId)
          : defaultContextWindow(),
        suspended: isSuspended(status),
      };
    },
  });

  app.addHook('onClose', async () => {
    clearInterval(uploadSweeper);
    watchers.closeAll();
    runner.shutdown();
  });

  return { app, runner, watchers, subagents };
}
