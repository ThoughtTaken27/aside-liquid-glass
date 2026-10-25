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
import { clientRateKey, clientRateMax } from './client-rate.js';
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
import { isPublicOrigin, type OrderedRelay } from './relays.js';
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
import { VisualStore, VISUAL_CSP, VISUAL_CONNECTION_ALLOWLIST, VISUAL_STATIC_CSP, supportsVisualNetworkIsolation } from './visuals.js';
import { prepareVisual } from './visual-render.js';
import { SkillCatalog } from './skills.js';
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
  lastReplyText,
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
import { LiveView, SharedRepl, openMcpRepl, parseMarked } from './liveview.js';
import { OwnedTurns } from './ownedturns.js';
import { ActiveViewers } from './viewers.js';
import { Notifier, LONG_RUNNING_THRESHOLD_MS, escapeHtml as escHtml } from './notify.js';
import { PhonePush } from './push.js';
import { PushMonitor } from './push-monitor.js';
import { registerPhonePushRoutes } from './push-routes.js';
import { livePhase } from './live-phase.js';
import type { ThreadItem } from './thread.js';
import {
  BrowserError,
  CaptureGate,
  captureTab,
  closeTab as closeBrowserTab,
  type BrowserTab,
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
import { NextStore, feedsDir, schoologyNotesPath, tidyCourse, isPersonalMailId, isValidNextId, parseAction, type NextPlan } from './next.js';
import { backgroundModel, readOnlyRepl } from './guards.js';
import { PersonalSweeper, countsLine, jevPersonal, type PersonalCounts } from './personal.js';
import { WorkTrailReader } from './worktrail.js';
import { ACTION_HELPERS_ENABLED, agentPromptFor, researchPlanFor, researchPromptFor } from './brief.js';
import { ResearchStore, questionPrompt, readResearch, type ResearchBrief } from './research.js';
import {
  InboxSweeper,
  ReplyDrafter,
  cliRepl,
  readMailConfig,
  readPersonalMailConfig,
  jevDecider,
  routerEndpoint,
  sweepDue,
  concurrencyFor,
  readAgentModel,
  RETRY_MS,
  toollessCompleter,
  oneShotCompleter,
  type Completer,
  type Decider,
} from './inbox.js';
import { applySessionModel } from './sessionmodel.js';
import { Ledger, type LedgerActor } from './ledger.js';
import { ControlStore } from './control.js';
import { contextRoutes } from './context-routes.js';
import { AUTOMATIC, capabilities } from './capabilities.js';
import { ProjectStore, scheduleProject, projectRaws, type ProjectView } from './projects.js';
import { inspectorPrompt, readInspector } from './inspector.js';
import { TaskStore, taskRaw, projectRaw } from './tasks.js';
import { Jev, fileRoutes } from './jev.js';
import { ClefDoor, fileCreds } from './clef.js';
import { NextJev, applyHints } from './nextjev.js';
import { suggestSpace } from './spacehint.js';
import { NextNotify } from './nextnotify.js';
import { startJevSocket } from './jevsocket.js';
import { AsideContext, applyScreenDone } from './asidecontext.js';
import { startContextSocket } from './contextsocket.js';
import { quick as jevQuick, route as jevRoute } from './jevtools.js';
import { VoicePairCodes, voiceRoutes } from './voice/routes.js';
import { splitReply, taskPrompt, type VoiceAgent, type VoiceTaskKind, type VoiceTaskStatus } from './voice/agent.js';
import { freeVoiceModel } from './voice/brain.js';
import { execFile } from 'node:child_process';
import { scanMemory } from './memscan.js';
import { auditReport, publicFetcher, PUSHY_AT, SUPPORT_LOW } from './researchaudit.js';
import type { DoneSignal } from './inbox.js';
import { ArmedPool, countDenied, describeRules, kindForTask, rulesFor, slotKey, standbyMarker, type ArmedKind, type HelperKind } from './armed.js';

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
   * Verified public relay URLs in failover order (Funnel, then ngrok).
   *
   * Read lazily because relays verify asynchronously after boot: a snapshot
   * taken here would freeze the list at "nothing up yet". Two readers: the
   * CSP `connect-src` below, which must name every origin the client is
   * allowed to probe, and the standalone shell, which carries the same list
   * to the phone as a meta tag.
   */
  relayUrls?: () => OrderedRelay[];
  /**
   * Shared one-time enrollment codes, issued by the loopback pairing page
   * and spent here. Injected so tests can issue and spend against the same
   * store; production wires one store through both listeners in index.ts.
   */
  pairingCodes?: PairingCodeStore;
  /** Hey Aside phone pairing codes (8 digits), issued on the loopback page. */
  voicePairCodes?: VoicePairCodes;
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
     * With it off, anonymous callers are limited by the real socket peer.
     * Signed owner credentials get independent, finite device budgets;
     * shared loopback transport must not make passive desktop reads deny
     * the phone. Forwarding headers never select an identity.
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
    /**
     * A message typed on the phone while Aside on the Mac is mid-turn
     * waits for that turn, exactly like the desktop's own queue, instead
     * of resuming a busy session. See `TurnRunner.pump`.
     */
    holdWhileRunning: true,
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
  const telegramTaskAlertsEnabled = false;
  const notifier = new Notifier({
    botToken: config.botToken,
    // Nothing to push to without a bot. The Notifier still runs so mute
    // state and read tracking behave the same; it just never calls out.
    enabled: telegramTaskAlertsEnabled, // Keep Telegram chat; task alerts belong to the phone app.
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
    if (!telegramTaskAlertsEnabled) return;
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
    if (turn.stopped || !telegramTaskAlertsEnabled) return;
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
    /*
     * Exact relay origins the client may probe while failing over. Each
     * entry passed `isPublicOrigin` -- scheme, host and optional port only,
     * so no value here can smuggle in a wildcard, a path, or a second
     * directive. Computed per request because relays verify after boot.
     */
    const relaySources = (opts.relayUrls?.() ?? [])
      .map((relay) => relay.url)
      .filter(isPublicOrigin)
      .map((origin) => ` ${origin}`)
      .join('');
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
    `connect-src 'self'${sockets}${relaySources}`,
    "worker-src 'self' blob:",
    // Explicit: also constrains a visual iframe navigating itself.
    "frame-src 'self'",
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
    max: clientRateMax,
    timeWindow: '1 minute',
    keyGenerator: (request) => clientRateKey(request, opts.jwtSecret, config.allowedUserId),
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

  const phonePush = new PhonePush({ stateDir: config.miniapp.stateDir });
  registerPhonePushRoutes(app, {
    push: phonePush, auth: requireAuth,
    reply: async (id, text) => {
      if (!sessionMsgFile(config.sessionsDir, id)) throw new Error('Conversation no longer exists.');
      const state = await stateDb.readFresh(id);
      if (isSuspended(state.status)) throw new Error('Open the conversation to answer the waiting question.');
      runner.send(id, {
        text: withReminder(text, { strictConfirm: softConfirm.has(id) }),
        model: runner.resolveModel(state.model ? state.model.provider + '/' + state.model.modelId : undefined),
        effort: runner.resolveEffort(state.model?.thinkingLevel),
      });
    },
  });
  // Owned driver exits are stronger evidence than a daemon row still settling.
  const phoneOwnedEnds = new Map<string, string>();
  const pushMonitor = new PushMonitor({
    enabled: () => phonePush.count > 0,
    sessions: async () => (await stateDb.list(200))?.map(row => ({ ...row,
      status: runner.isBusy(row.id) ? 'running' : ownedTurns.settled(row.id, sessionMsgFile(config.sessionsDir, row.id)) ? phoneOwnedEnds.get(row.id) ?? row.status : row.status,
    })) ?? null,
    finalAnswerAt: async (id) => {
      const file = sessionMsgFile(config.sessionsDir, id); if (!file) return null;
      const snapshot = threads.build(id, file, false, subagents.snapshot(id, false));
      for (let i = snapshot.items.length - 1; i >= 0; i--) {
        const item = snapshot.items[i]; if (item.kind === 'answer') return item.ts;
      }
      return null;
    },
    muted: (id) => notifier.isMuted(id),
    send: notice => phonePush.deliver(notice),
    phase: async (id) => {
      const file = sessionMsgFile(config.sessionsDir, id);
      return file ? livePhase(threads.build(id, file, false, subagents.snapshot(id, false)).items) : null;
    },
    detail: async (id, kind) => {
      const file = sessionMsgFile(config.sessionsDir, id);
      if (!file) return '';
      const snapshot = threads.build(id, file, false, subagents.snapshot(id, false));
      const last = snapshot.items[snapshot.items.length - 1];
      if (kind === 'needs-input' && last?.kind === 'question' && last.questions[0]) return last.questions[0].question;
      if (kind === 'error') return last?.kind === 'error' ? last.text : '';
      return kind === 'ready' ? lastAssistantSummary(snapshot.items) : '';
    },
  });
  runner.on('turn_started', turn => { phoneOwnedEnds.delete(turn.sessionId); pushMonitor.begin(turn.sessionId, turn.startedAt); });
  runner.on('turn_finished', turn => {
    phoneOwnedEnds.set(turn.sessionId, turn.stopped ? 'interrupted' : turn.suspended ? 'suspended' : turn.alert || turn.error ? 'error' : 'idle');
    while (phoneOwnedEnds.size > 256) phoneOwnedEnds.delete(phoneOwnedEnds.keys().next().value!);
  });
  const phonePushTimer = setInterval(() => { void pushMonitor.tick().catch(() => app.log.warn('phone notification scan failed')); }, 5_000);
  phonePushTimer.unref?.();
  app.addHook('onClose', async () => clearInterval(phonePushTimer));

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
   * The loopback pairing page issues a random (192-bit), one-time,
   * ten-minute code into the shared in-memory store. This route spends it
   * once. This route used to be reachable only over the private tailnet, so
   * the network was a second gate behind this one; the public relays
   * removed that gate, and the code stands on its own instead -- 192 bits
   * of entropy, one attempt per code lifetime that matters (a code dies on
   * first spend), and 5 spends per minute per bucket. Brute force is not
   * a serious threat against that shape.
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
        // Never 502 from this server: Cloudflare replaces a 502 with its own
        // "bad gateway" page, and the front door reads 502 as "the tunnel is
        // down" -- it shows the phone "Mac offline" and replays the request.
        // An app-level failure is a 500 with a JSON reason.
        return reply.code(500).send({ error: 'archive_failed' });
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
        (parentId, active) => subagents.snapshot(parentId, active),
      );

      /** Identity of these exact items; see ThreadStore.keyOf and ws.ts. */
      const rev = snapshot.rev;

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
        rev,
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
        /** Messages waiting behind the running turn, for the composer cards. */
        queue: runner.queuedItems(id),
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
   * Answers routinely contain `![shot](~/shot.png)`, because the
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
          .code(500)
          .send({ error: 'session_create_failed', reason: (err as Error).message });
      }
    },
  );

  /**
   * Answer a session that is suspended on a native question, in place.
   *
   * The daemon only resolves a native `ask_user_question` over the
   * sidepanel's own channel, but it does honour `aside session stop` on a
   * suspended session: the pending tool is closed as interrupted and the
   * session drops to `interrupted`. A normal resume then carries the
   * answer into the SAME session with its full context -- which is what the
   * sidepanel itself does when you type a custom answer. Verified live on
   * Sep. 30, 2026 (stop -> "interrupted", resume -> same thread continues).
   *
   * Returns true once the session is no longer suspended, so the caller
   * can send. False means the daemon did not let go in time.
   */
  async function releaseSuspension(id: string): Promise<boolean> {
    stateDb.invalidate(id);
    if (!isSuspended((await stateDb.readFresh(id)).status)) return true;
    if (!(await runner.stopRemote(id))) return false;
    const msgFile = sessionMsgFile(config.sessionsDir, id);
    if (msgFile) ownedTurns.markFinished(id, msgFile);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      stateDb.invalidate(id);
      if (!isSuspended((await stateDb.readFresh(id)).status)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

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
       * A suspended session would swallow a plain resume forever, so a
       * typed reply to a waiting question first releases it (see
       * `releaseSuspension`) and then goes in as the answer.
       */
      if (!(await releaseSuspension(id))) {
        return reply.code(409).send({
          error: 'session_suspended',
          reason: 'Aside on your computer did not release the question. Try again in a moment.',
        });
      }

      const { queued, id: queuedId, held } = runner.send(id, {
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
        text: promptWithAttachments(text, attachments.map((f) => f.path)),
        // Wrapped at dispatch, once per turn -- see `TurnRequest.wrap`.
        wrap: (prompt) => withReminder(prompt, { strictConfirm: softConfirm.has(id) }),
        display: { text, attachments: attachments.map((f) => f.name) },
        model: runner.resolveModel(body.model),
        effort: runner.resolveEffort(body.effort),
      });
      const waiting = held || (await runner.isHeld(id, queuedId));
      return { accepted: true, queued, busy: runner.isBusy(id), queuedId, held: waiting };
    },
  );

  /**
   * The queued-message card's three controls, as on the desktop.
   *
   * A message sent while a turn runs waits in the runner's queue (see
   * `TurnRunner.send`) and goes on its own when the turn ends. These let
   * the owner change their mind before then:
   *
   *   GET    .../queue            the waiting list
   *   DELETE .../queue/:qid       Remove (and Edit, which removes and
   *                               hands the words back to the composer)
   *   POST   .../queue/:qid/now   Send now: steer the running turn
   *
   * A message that already left the queue answers `gone`, not an error --
   * its turn started between the tap and the request, which is the
   * outcome the owner wanted anyway. Never 502: see the front-door rule.
   */
  app.get(
    '/api/sessions/:id/queue',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isValidSessionId(id)) return reply.code(400).send({ error: 'bad_session_id' });
      return { items: runner.queuedItems(id) };
    },
  );

  app.delete(
    '/api/sessions/:id/queue/:qid',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id, qid } = request.params as { id: string; qid: string };
      if (!isValidSessionId(id)) return reply.code(400).send({ error: 'bad_session_id' });
      const item = runner.dequeue(id, String(qid || ''));
      return { ok: true, gone: !item, items: runner.queuedItems(id) };
    },
  );

  app.post(
    '/api/sessions/:id/queue/:qid/now',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id, qid } = request.params as { id: string; qid: string };
      if (!isValidSessionId(id)) return reply.code(400).send({ error: 'bad_session_id' });
      const item = runner.dequeue(id, String(qid || ''));
      if (!item) return { ok: true, mode: 'gone' as const };
      const prompt = item.wrap ? item.wrap(item.text) : item.text;

      // Busy by either owner: this server's child, or the daemon's status
      // for a turn started on the Mac.
      stateDb.invalidate(id);
      const status = (await stateDb.readFresh(id)).status;
      const busy = runner.isBusy(id) || status === 'running';
      if (!busy) {
        // The turn ended under the tap. Sending normally is what Send now
        // means for an idle session.
        runner.requeueFront(id, item);
        return { ok: true, mode: 'sent' as const };
      }
      if (await runner.steer(id, prompt)) {
        return { ok: true, mode: 'steered' as const };
      }
      // The CLI refused. Put the message back where it was so nothing the
      // owner typed is lost, and say so.
      runner.requeueFront(id, item);
      return reply.code(409).send({ error: 'steer_failed', items: runner.queuedItems(id) });
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
        return reply.code(500).send({ error: 'stop_failed' });
      }
      // Anything held behind the desktop turn goes too, as on a phone-owned
      // stop; the client puts the words back in the composer.
      runner.dropQueued(id);

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

      if (!(await releaseSuspension(id))) {
        return reply.code(409).send({
          error: 'session_suspended',
          reason: 'Aside on your computer did not release the question. Try again in a moment.',
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
          .code(500)
          .send({ error: 'session_create_failed', reason: (err as Error).message });
      } finally {
        recoveryFlights.delete(recoveryKey);
      }
    },
  );

  // --- settings ----------------------------------------------------------

  /**
   * Verified public relay URLs in failover order.
   *
   * The installed app reads this after boot to refresh the failover list it
   * was served with (relays can verify after the page loaded), and the
   * settings screen shows it so the owner can see which public addresses
   * are live. Authenticated like everything else: the URLs are public, but
   * their health is the owner's business, and an unauthenticated endpoint
   * that answers "which relays are up" is a free reconnaissance feed.
   */
  app.get(
    '/api/relays',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async () => ({
      relays: (opts.relayUrls?.() ?? [])
        .filter((relay) => isPublicOrigin(relay.url))
        .map((relay) => ({ kind: relay.kind, url: relay.url })),
    }),
  );

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
        return reply.code(500).send({ error: 'permission_update_failed' });
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
        return reply.code(500).send({ error: 'model_update_failed' });
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
    //
    // Disk FIRST since 2026-09-23. settings.json is rewritten the moment the
    // owner changes model or thinking level on the Mac, so reading it per
    // request makes the phone follow within one 8s poll, while the peek
    // could lag up to 30s behind. The peek also spawned a ~139MB helper
    // every 30s while the phone was open, which on an 8GB Mac in swap was
    // itself a source of stalls. The daemon is now asked only when the
    // disk copy has no default at all.
    const desktop = readDesktopState(config.sessionsDir);
    const diskDefault = desktop.defaultModel?.provider && desktop.defaultModel?.modelId
      ? desktop.defaultModel
      : null;
    const daemonDefault = diskDefault ?? peekDefaultModel(facade);
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
              '  <link rel="apple-touch-icon" href="/icons/aside-clay-touch-180.png" />',
              ...APPLE_LAUNCH_SCREENS,
              '</head>',
            ].join('\n'),
          );
      }
      /*
       * Failover list for the phone, injected per request rather than baked
       * into the cached shell: relays verify asynchronously after boot, so
       * the cached HTML would otherwise freeze the list at whatever was up
       * when the first phone happened to load it.
       *
       * A meta tag and not an inline script because `script-src 'self'`
       * forbids inline scripts. The values passed `isPublicOrigin`, whose
       * charset excludes quotes and angle brackets, so no entry can break
       * out of the attribute -- the filter IS the escaping.
       */
      const relayOrigins = (opts.relayUrls?.() ?? [])
        .map((relay) => relay.url)
        .filter(isPublicOrigin);
      if (!relayOrigins.length) return standaloneHtml;
      return standaloneHtml.replace(
        '</head>',
        `  <meta name="aside-relays" content="${relayOrigins.join(' ')}" />\n</head>`,
      );
    }

    /** Next's Mac page, for a pinned Aside tab. Signs in through /desk on the pairing port. */
    app.get('/desk', async (_request, reply) => {
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(fs.readFileSync(path.join(opts.webDist ?? '', 'desk.html'), 'utf8'));
    });

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
      if (!(await releaseSuspension(sessionId))) {
        return reply.code(409).send({ error: 'session_suspended' });
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

  /**
   * One warm browser REPL for the tab list and the live view. A tab-list
   * read through it is a ~30ms round trip; through the facade it was a
   * fresh ~139MB process on every 1.5s poll.
   */
  const browserRepl = new SharedRepl((signal) => openMcpRepl(config.asideCli, signal));
  app.addHook('onClose', async () => browserRepl.close());
  /**
   * Stale-while-revalidate. Aside's own `listBrowserTabs()` takes anywhere
   * from ~90ms to ~1.4s on a loaded Mac, so the route answers at once from
   * the last list (at most a couple of seconds old while the sheet polls)
   * and refreshes behind it. Opening or closing a tab drops the cache so
   * the next read waits for the truth.
   */
  let tabsCache: { at: number; tabs: BrowserTab[] } | null = null;
  let tabsInFlight: Promise<BrowserTab[]> | null = null;
  const refreshTabs = (): Promise<BrowserTab[]> => {
    if (tabsInFlight) return tabsInFlight;
    tabsInFlight = (async () => {
      if (!browserRepl.warm) {
        // Cold: starting the REPL takes seconds. Answer through a one-off
        // facade call (well under a second) and warm up behind it.
        browserRepl.warmUp();
        try {
          const tabs = await listTabs(facade);
          tabsCache = { at: Date.now(), tabs };
          return tabs;
        } finally {
          tabsInFlight = null;
        }
      }
      try {
        const out = await browserRepl.run(
          "console.log('@@LV' + JSON.stringify(await listBrowserTabs()));",
          2_500,
        );
        const rows = parseMarked<unknown>(out);
        const tabs = Array.isArray(rows)
          ? (rows.filter((row) => row && typeof (row as BrowserTab).targetId === 'string') as BrowserTab[])
          : [];
        tabsCache = { at: Date.now(), tabs };
        return tabs;
      } catch (err) {
        app.log.warn({ err }, 'fast tab list failed; using facade');
        const tabs = await listTabs(facade);
        tabsCache = { at: Date.now(), tabs };
        return tabs;
      } finally {
        tabsInFlight = null;
      }
    })();
    return tabsInFlight;
  };
  const fastTabs = async (): Promise<BrowserTab[]> => {
    const age = tabsCache ? Date.now() - tabsCache.at : Infinity;
    if (tabsCache && age < 15_000) {
      if (age > 600) void refreshTabs().catch(() => undefined);
      return tabsCache.tabs;
    }
    return refreshTabs();
  };
  const dropTabsCache = () => {
    tabsCache = null;
  };

  /**
   * Site icons, fetched by the Mac for the phone.
   *
   * The page CSP only allows same-origin images, so a remote favicon URL in
   * the list never rendered. Only URLs the browser itself reported for an
   * open tab may be fetched (no open proxy), responses must be small
   * images, and they are served sandboxed so an SVG cannot script this
   * origin if opened directly.
   */
  const faviconAllowed = new Set<string>();
  const faviconCache = new Map<string, { type: string; body: Buffer }>();
  const FAVICON_MAX_BYTES = 128 * 1024;
  const faviconFor = (raw: unknown): string => {
    const url = typeof raw === 'string' ? raw : '';
    if (url.startsWith('data:image/')) {
      // Small inline icons ride the list; big ones (Discord's is ~10KB)
      // are served once by hash so every 2s poll does not re-send them.
      if (url.length <= 2_000) return url;
      const key = crypto.createHash('sha1').update(url).digest('hex');
      if (!faviconCache.has(`h:${key}`)) {
        const m = /^data:(image\/[a-z0-9.+-]+)(;base64)?,(.*)$/is.exec(url);
        if (!m) return '';
        const body = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
        if (body.length > FAVICON_MAX_BYTES) return '';
        faviconCache.set(`h:${key}`, { type: m[1].toLowerCase(), body });
      }
      return `/api/tabs/favicon?h=${key}`;
    }
    if (!/^https?:\/\//i.test(url)) return '';
    faviconAllowed.add(url);
    return `/api/tabs/favicon?u=${encodeURIComponent(url)}`;
  };

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
                : 500;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    app.log.warn({ err }, 'browser route failed');
    return reply.code(500).send({ error: 'upstream' });
  };

  app.get('/api/tabs', { preHandler: requireAuth }, async (request, reply) => {
    const [tabs, owners] = await Promise.all([fastTabs(), stateDb.tabOwners()]);
    const payload = {
      tabs: tabs.map((tab) => {
        const owner = owners.get(tab.targetId);
        const title = owner
          ? isPlaceholderTitle(owner.title)
            ? titleFromTranscript(config.sessionsDir, owner.sessionId) || owner.title
            : owner.title
          : '';
        return {
          ...tab,
          faviconUrl: faviconFor(tab.faviconUrl),
          ...(owner ? { agent: { sessionId: owner.sessionId, title, running: owner.running } } : {}),
        };
      }),
    };
    // The sheet polls every 2s and the list rarely changes between polls:
    // an unchanged list goes back as a bodiless 304.
    const body = JSON.stringify(payload);
    const etag = `"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
    reply.header('etag', etag).header('cache-control', 'private, no-cache');
    const sent = String(request.headers['if-none-match'] || '').replace(/^W\//, '');
    if (sent === etag) return reply.code(304).send();
    return reply.type('application/json').send(body);
  });

  app.get('/api/tabs/favicon', { preHandler: requireAuth }, async (request, reply) => {
    const query = request.query as { u?: string; h?: string };
    const hashed = /^[a-f0-9]{40}$/.test(String(query.h || '')) ? `h:${query.h}` : '';
    const url = String(query.u || '');
    if (!hashed && !faviconAllowed.has(url)) return reply.code(404).send({ error: 'not_found' });
    let hit = faviconCache.get(hashed || url);
    if (!hit && hashed) return reply.code(404).send({ error: 'not_found' });
    if (!hit) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(4_000), redirect: 'follow' });
        const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const body = Buffer.from(await res.arrayBuffer());
        if (!res.ok || !type.startsWith('image/') || body.length > FAVICON_MAX_BYTES) {
          return reply.code(404).send({ error: 'not_found' });
        }
        hit = { type, body };
        faviconCache.set(url, hit);
        while (faviconCache.size > 300) {
          const oldest = faviconCache.keys().next().value as string;
          faviconCache.delete(oldest);
        }
      } catch {
        return reply.code(404).send({ error: 'not_found' });
      }
    }
    return reply
      .header('cache-control', 'private, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .type(hit.type)
      .send(hit.body);
  });

  /**
   * Inline `visual` blocks (see visuals.ts). The client posts the composed
   * page once and frames the returned URL; the GET serves it sandboxed.
   */
  const visuals = new VisualStore(
    path.join(config.miniapp.stateDir, 'visuals'),
    `visual:${opts.jwtSecret}`,
  );
  app.post(
    '/api/visuals',
    { preHandler: requireAuth, bodyLimit: 1024 * 1024 },
    async (request, reply) => {
      const html = (request.body as { html?: unknown } | null)?.html;
      if (typeof html !== 'string') return reply.code(400).send({ error: 'bad_request' });
      try {
        const id = visuals.put(html);
        return { id, url: `/api/visuals/v2/${id}` };
      } catch (err) {
        if (err instanceof RangeError) return reply.code(413).send({ error: 'too_large' });
        throw err;
      }
    },
  );
  for (const visualPath of ['/api/visuals/:id', '/api/visuals/v2/:id']) app.get(visualPath, async (request, reply) => {
    const html = visuals.get((request.params as { id: string }).id);
    if (html === null) return reply.code(404).type('text/plain').send('not found');
    const interactive = supportsVisualNetworkIsolation(request.headers['user-agent']);
    let rendered: string;
    try { rendered = prepareVisual(html, interactive); } catch {
      return reply.code(503).header('cache-control', 'no-store').type('text/plain').send('Visual unavailable. Rebuild the server and try again.');
    }
    return reply
      .header('cache-control', 'no-store')
      .header('vary', 'User-Agent')
      .header('connection-allowlist', VISUAL_CONNECTION_ALLOWLIST)
      .header('x-dns-prefetch-control', 'off')
      .header('content-security-policy', interactive ? VISUAL_CSP : VISUAL_STATIC_CSP)
      .type('text/html; charset=utf-8')
      .send(rendered);
  });

  /**
   * The "/" menu's skills (see skills.ts). `?v=` is the version the client
   * already holds; an unchanged catalog answers with no list at all, so
   * re-checking on every open of the menu costs a few bytes.
   */
  const skillCatalog = new SkillCatalog(
    path.join(defaultAsideRoot(), 'skills'),
    path.join(defaultAsideRoot(), 'settings.json'),
  );
  app.get('/api/skills', { preHandler: requireAuth }, async (request, reply) => {
    const snap = skillCatalog.get();
    reply.header('cache-control', 'no-store');
    const have = (request.query as { v?: unknown }).v;
    if (typeof have === 'string' && have === snap.version && !snap.stale) {
      return { version: snap.version, unchanged: true };
    }
    return snap;
  });

  app.post(
    '/api/tabs',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = (request.body || {}) as { url?: string };
      try {
        const opened = await openNewTab(facade, String(body.url || ''));
        dropTabsCache();
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
        dropTabsCache();
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
  /**
   * Next: the ranked to-do surface. Reads what the owner's routines wrote
   * and ranks it with arithmetic; no model call happens on this path.
   */
  const nextStore = new NextStore({
    asideRoot: defaultAsideRoot(),
    stateDir: config.miniapp.stateDir,
  });
  const workTrail = new WorkTrailReader();
  /**
   * The plan plus the two live inputs: the work trail (local browser
   * history, allowlisted work sites only) and what each handed-off agent is
   * doing right now. Both are read, never written.
   */
  /**
   * Projects, quick-add tasks, the activity ledger, and the pause switch.
   * Projects and tasks live beside the Next config so Aside can read them;
   * the ledger and switch live in the server's own state dir.
   */
  const nextDir = path.join(defaultAsideRoot(), 'next');
  const projectStore = new ProjectStore(path.join(nextDir, 'projects.json'));
  const taskStore = new TaskStore(path.join(nextDir, 'tasks.json'));
  const ledger = new Ledger(
    path.join(config.miniapp.stateDir, 'next-ledger.jsonl'),
    path.join(config.miniapp.stateDir, 'next-ledger.key'),
  );
  const control = new ControlStore(path.join(config.miniapp.stateDir, 'next-control.json'));
  const record = (
    actor: LedgerActor,
    kind: string,
    summary: string,
    extra: { itemId?: string; projectId?: string; sessionId?: string; detail?: Record<string, unknown>; risk?: 'none' | 'low' | 'high' } = {},
  ) => {
    try {
      ledger.append({ actor, kind, summary, ...extra });
    } catch (err) {
      app.log.error({ err, kind }, 'ledger append failed');
    }
  };
  const projectViews = (now = new Date()): ProjectView[] =>
    projectStore
      .list()
      .filter((p) => p.status !== 'archived')
      .map((p) => scheduleProject(p, now));
  const extraRaws = (now = new Date()) => [
    ...projectRaws(projectViews(now)).map(projectRaw),
    ...taskStore.list().map(taskRaw),
  ];
  const livePlan = async (): Promise<NextPlan> => {
    const now = new Date();
    const views = projectViews(now);
    let trail: Awaited<ReturnType<WorkTrailReader['read']>> = [];
    try {
      const memory = nextStore.contextMemory.status(now);
      // A memory source switch governs actual reading, not just UI visibility.
      if (!control.read().paused && memory.state === 'ready' && memory.preferences.sources.includes('work-trail')) trail = await workTrail.read();
    } catch { /* Unavailable context never falls back to ungated browser reading. */ }
    const plan = nextStore.plan(now, trail, [
      ...projectRaws(views).map(projectRaw),
      ...taskStore.list().map(taskRaw),
    ], false, control.read().paused);
    plan.control = control.read();
    try {
      plan.personalNote = readPersonalMailConfig(nextRoot)
        ? countsLine((JSON.parse(fs.readFileSync(personalFeed, 'utf8')) as { counts?: PersonalCounts }).counts)
        : null;
    } catch {
      plan.personalNote = null;
    }
    plan.projects = views
      .filter((v) => v.status === 'active')
      .map((v) => ({ id: v.id, space: v.space, title: v.title, health: v.health, line: v.line, deadlineISO: v.deadlineISO, done: v.done, total: v.total, todayMin: v.today?.minutes ?? 0 }));
    await Promise.all(
      plan.withAside.map(async (item) => {
        if (!item.sessionId) return;
        const run = runner.activityOf(item.sessionId);
        const tabs = (await stateDb.agentTabs(item.sessionId).catch(() => null)) ?? [];
        const tab = tabs.slice().sort((a, b) => b.at - a.at)[0] ?? null;
        const since = startedAtOf.get(item.sessionId) ?? 0;
        item.live = {
          busy: Boolean(run),
          step: run?.activity?.summary ?? null,
          startedAt: run ? new Date(run.startedAt).toISOString() : null,
          tab: tab ? { targetId: tab.targetId, url: tab.url } : null,
          result: run ? null : lastReplyText(sessionMsgFile(config.sessionsDir, item.sessionId), since, 700),
        };
      }),
    );
    // Log each hand-off's finish once, with what Aside refused along the way.
    for (const item of plan.withAside) {
      const sid = item.sessionId;
      if (!sid || item.live?.busy || finishLogged.has(sid)) continue;
      const mt = msgMtime(sid);
      if (!mt || Date.now() - mt < 60_000) continue;
      finishLogged.add(sid);
      const since = startedAtOf.get(sid) ?? Date.now() - 6 * 3_600_000;
      const d = countDenied(sessionMsgFile(config.sessionsDir, sid), since);
      const said = item.live?.result ?? null;
      // Only ping for helpers started in this run of the server (not old ones found at startup).
      if (startedAtOf.has(sid)) {
        void notifier
          .notifyText(`<b>Next finished:</b> ${escHtml(item.title)}\n\n${escHtml((said ?? 'It stopped without a reply. Open the task to see what it did.').slice(0, 700))}\n\nNothing was submitted. Check it in Next before you do.`)
          .catch(() => undefined);
      }
      record('agent', 'agent.finish', `Next's helper stopped on "${item.title}". Check its work before you submit.${d.denied ? ` It was blocked ${d.denied} time${d.denied === 1 ? '' : 's'} from going outside its limits.` : ''}`, {
        itemId: item.id,
        sessionId: sid,
        detail: { blocked: d.denied, ...(d.samples[0] ? { example: d.samples[0] } : {}) },
        risk: d.denied ? 'high' : 'none',
      });
    }
    // What Next found for each item, and any help waiting to start.
    const waitingFor = new Map(readWaiting().map((w) => [w.itemId, w]));
    const found = researchStore.latestByItem();
    for (const it of [plan.now, ...plan.next, ...plan.later, ...plan.unsure]) {
      if (!it) continue;
      const b = found.get(it.id);
      it.research = b ? { id: b.id, state: b.state, verdictLabel: b.report?.verdictLabel ?? null } : null;
      const w = waitingFor.get(it.id);
      it.handoff = ACTION_HELPERS_ENABLED && w ? { state: 'waiting', readyInMin: readyIn(w.kind, w.host) } : null;
    }
    // With nothing of his own left, say what Aside has waiting instead.
    if (!plan.now) {
      const ready = plan.withAside.filter((it) => !it.live?.busy).length;
      const working = plan.withAside.length - ready;
      const hi = plan.dayLine.split(' ')[0];
      if (ready)
        plan.dayLine = `${hi} ${ready === 1 ? 'One thing from Aside is' : `${ready} things from Aside are`} waiting on you.`;
      else if (working) plan.dayLine = `${hi} Nothing needs you. Aside is still working.`;
    }
    // A source change/forget during awaited thread reads must not return old
    // evidence or the rank/trail derived from it. Rebuild without context.
    if (plan.context?.revision !== undefined) {
      try {
        if (nextStore.contextMemory.status().revision !== plan.context.revision) {
          const safe = nextStore.plan(new Date(), [], extraRaws(), false, true);
          safe.control = control.read(); safe.projects = plan.projects;
          return safe;
        }
      } catch {
        const safe = nextStore.plan(new Date(), [], extraRaws(), false, true);
        safe.control = control.read(); safe.projects = plan.projects;
        return safe;
      }
    }
    return plan;
  };
  await app.register(contextRoutes, {
    prefix: '/api/next/context', memory: nextStore.contextMemory, requireAuth,
    resolveTask: id => nextStore.rawFor(id, new Date(), extraRaws()),
    globalPaused: () => control.read().paused,
    refresh: async () => {
      const snapshot = nextStore.contextMemory.status();
      // This route never reads pages/accounts, starts a model/agent or sends a notification.
      const trail = snapshot.preferences.sources.includes('work-trail') ? await workTrail.read() : [];
      return nextStore.plan(new Date(), trail, extraRaws(), false, control.read().paused);
    },
  });
  /**
   * School email. Off unless <aside root>/next/config.json names the
   * account. Fetching is fixed code over `aside repl`; sorting and reply
   * drafting are model calls with no tools (inbox.ts).
   */
  const nextRoot = defaultAsideRoot();
  const asideContext = new AsideContext({ asideRoot: nextRoot });
  const mailConfig = readMailConfig(nextRoot);
  const mailComplete: Completer = async (messages, maxTokens) => {
    const ep = routerEndpoint(nextRoot, mailConfig?.model ?? '');
    if (!ep) throw new Error('no_model_endpoint');
    return toollessCompleter(ep)(messages, maxTokens);
  };
  /*
   * One shared door to Jev for every caller on this Mac (jev.ts): one daily
   * budget with safety checks first, one pause on a 429, one cache.
   */
  const jevModel = mailConfig?.gate ?? 'oc/jev-1.13-free';
  // Cloudflare Clef is a second door (clef.ts). Which features use it, in what
  // order, is next/jev-routes.json; delete that file or set enabled:false to go
  // back to Jev only with no restart. Never attached in tests.
  const underTest = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
  const clef = underTest
    ? undefined
    : new ClefDoor({
        creds: fileCreds(path.join(nextRoot, 'next', 'clef.json')),
        stateDir: config.miniapp.stateDir,
        log: (msg, extra) => app.log.warn({ extra }, msg),
      });
  const jev = new Jev({
    endpoint: () => routerEndpoint(nextRoot, jevModel),
    stateDir: config.miniapp.stateDir,
    log: (msg, extra) => app.log.warn({ extra }, msg),
    clef,
    routes: underTest ? undefined : fileRoutes(path.join(nextRoot, 'next', 'jev-routes.json')),
  });
  app.addHook('onClose', async () => jev.flush());
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    // Tools on this Mac (jev command, Hey Aside, OpenCode guard) share this door.
    const sock = startJevSocket({
      jev,
      socketPath: path.join(nextRoot, 'next', 'jev.sock'),
      complete: () => {
        const model = mailConfig?.model ?? 'oc/space-bunny-free';
        // Background and voice fast paths never use Claude.
        if (/claude|anthropic|bedrock/i.test(model)) return null;
        const ep = routerEndpoint(nextRoot, model);
        return ep ? toollessCompleter(ep) : null;
      },
      log: (msg, extra) => app.log.warn({ extra }, msg),
    });
    app.addHook('onClose', async () => sock.close());
    // Oct 21: Aside's Context Awareness, read-only, for Jarvis on this Mac (contextsocket.ts).
    const ctxSock = startContextSocket({
      ctx: asideContext,
      socketPath: path.join(nextRoot, 'next', 'context.sock'),
      log: (msg, extra) => app.log.info({ extra }, msg),
    });
    app.addHook('onClose', async () => { await ctxSock.close(); asideContext.close(); });
  }
  /*
   * Hey Aside on the phone (voice/). Signed by the phone's hardware keys,
   * never by the session cookie. Every lane is plain code or a tool-less
   * model; nothing here can act on the Mac.
   */
  const voiceComplete = (): Completer | null => {
    // Voice is free-only: a paid inbox model must never become a voice fallback.
    const model = freeVoiceModel(mailConfig?.model);
    const ep = routerEndpoint(nextRoot, model);
    return ep ? toollessCompleter(ep) : null;
  };
  // Phone control (docs/jarvis-island/PHONE-CONTROL.md): Codex through the local router, never a fallback model.
  const voiceConfigFlag = (key: string): boolean => {
    try { return JSON.parse(fs.readFileSync(path.join(config.miniapp.stateDir, 'voice-config.json'), 'utf8'))[key] === true; } catch { return false; }
  };
  const screenComplete = (): Completer | null => {
    const ep = routerEndpoint(nextRoot, 'cx/gpt-6-luna');
    return ep ? oneShotCompleter(ep) : null;
  };
  // Full Aside tasks from the phone: on only when voice-config.json says "tasks": true.
  const voiceTasksOn = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(config.miniapp.stateDir, 'voice-config.json'), 'utf8')).tasks === true; } catch { return false; }
  })();
  await app.register(voiceRoutes, {
    ...(voiceTasksOn
      ? { agent: { limits: (k) => voiceAgent.limits(k), readyIn: (k) => voiceAgent.readyIn(k), start: (k, r) => voiceAgent.start(k, r), status: (id) => voiceAgent.status(id), stop: (id) => voiceAgent.stop(id) } satisfies VoiceAgent }
      : {}),
    stateDir: config.miniapp.stateDir,
    pairCodes: opts.voicePairCodes ?? new VoicePairCodes(),
    complete: voiceComplete,
    screenComplete,
    // Clef only (never Jev: its daily budget belongs to mail). Not cached: screen text never lands on disk.
    screenClef: async (model, state, questions) => {
      const r = await jev.ask({ state, questions, tier: 'you', feature: model === 'clef' ? 'hands.big' : 'hands.flash', ttlMs: 0 });
      if (!r.ok || (r as { via?: string }).via !== model) return null;   // never Jev, never the wrong model
      const a = r.answers.next;
      return a && a.type === 'choice' ? { choice: a.choice, confidence: a.confidence } : null;
    },
    screenControl: () => voiceConfigFlag('screenControl'),
    brain: {
      route: async (text) => {
        // The phone has its own lanes; skip the laptop keyword shortcut ("today" is not an action).
        const r = await jevRoute(jev, text, { rules: false });
        return r.ok ? { route: r.route } : null;
      },
      quick: async (text, history) => {
        const r = await jevQuick(jev, voiceComplete(), text, history, { rules: false });
        return r.ok && r.fast ? r.answer : null;
      },
      complete: voiceComplete,
      plan: async () => livePlan(),
    },
    transcribe: async (audio) =>
      (
        await transcribeAudio(audio, {
          modelPath: config.whisperModelPath,
          language: config.whisperLanguage || 'en',
          serverPort: whisperServer.portIfReady(),
        })
      ).text,
    alert: (title, body) => {
      if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
      const q = (s: string) => JSON.stringify(s.replace(/[\\"\u0000-\u001f]/g, ' '));
      execFile('/usr/bin/osascript', ['-e', `display notification ${q(body)} with title ${q(title)}`], () => undefined);
    },
  });
  // Every mail script is checked read-only before it runs (guards.ts).
  const mailRepl = readOnlyRepl(cliRepl(config.asideCli));
  const mailFeed = path.join(feedsDir(nextRoot), 'school-mail.json');
  const schoolDecide: Decider | undefined = mailConfig?.gate ? async (state) => {
    const ep = routerEndpoint(nextRoot, mailConfig.gate!);
    return ep ? jevDecider(ep, jev.fetchFor('safety', 'mail.school'))(state) : null;
  } : undefined;
  const inbox = mailConfig
    ? new InboxSweeper({
        account: mailConfig.account,
        feedPath: mailFeed,
        cachePath: path.join(config.miniapp.stateDir, 'inbox-cache.json'),
        repl: mailRepl,
        complete: mailComplete,
        decide: schoolDecide,
        concurrency: concurrencyFor(mailConfig.model),
        facts: mailConfig.facts,
        log: (msg, extra) => app.log.warn({ extra }, msg),
      })
    : null;
  const drafter = mailConfig ? new ReplyDrafter({ account: mailConfig.account, repl: mailRepl, complete: mailComplete, decide: schoolDecide }) : null;
  const recordSweep = (r: { ok: boolean; items?: number; flagged?: number; pending?: number; sorted?: number }, why: 'schedule' | 'you') => {
    const flagged = r.flagged ?? 0;
    const gate = (r as { gate?: { checked: number; dropped: number } }).gate;
    record('sorter', 'mail.sweep', r.ok
      ? `Sorted school email: ${r.items ?? 0} item${r.items === 1 ? '' : 's'} on your list${flagged ? `, ${flagged} flagged as suspicious` : ''}${gate?.dropped ? `. Jev skipped ${gate.dropped} with nothing for you` : ''}.`
      : 'School email sort did not finish; it will retry in 20 minutes.', {
      detail: { items: r.items ?? 0, flagged, pending: r.pending ?? 0, trigger: why, tools: 'none' },
      risk: flagged ? 'low' : 'none',
    });
  };
  const lastSweepAt = (): string | null => {
    if (inbox?.lastRun) return inbox.lastRun.at;
    try {
      return JSON.parse(fs.readFileSync(mailFeed, 'utf8')).updatedAt ?? null;
    } catch {
      return null;
    }
  };
  /*
   * Jev's background checks for Next (nextjev.ts). Answers are saved and
   * applied to every plan; /api/next itself never waits on Jev.
   */
  let signalsAt = -1;
  let signalsCache: DoneSignal[] = [];
  const schoolSignals = (): DoneSignal[] => {
    try {
      const mt = fs.statSync(mailFeed).mtimeMs;
      if (mt !== signalsAt) {
        signalsAt = mt;
        const raw = (JSON.parse(fs.readFileSync(mailFeed, 'utf8')) as { signals?: unknown }).signals;
        signalsCache = (Array.isArray(raw) ? raw : []).filter(
          (x): x is DoneSignal => Boolean(x) && typeof x.subject === 'string' && typeof x.at === 'string' && typeof x.p === 'number',
        );
      }
    } catch {
      signalsCache = [];
    }
    return signalsCache;
  };
  const nextJev = new NextJev({
    jev,
    hintsPath: path.join(config.miniapp.stateDir, 'next-jev.json'),
    openItems: () => {
      const p = nextStore.plan(new Date(), [], extraRaws(), true);
      return [p.now, ...p.next, ...p.later, ...p.unsure, ...p.review].filter((x): x is NonNullable<typeof x> => Boolean(x));
    },
    raws: () => nextStore.rawAll(new Date(), extraRaws()),
    signals: schoolSignals,
    log: (msg, extra) => app.log.warn({ extra }, msg),
  });
  // Oct 21: "Looks done?" also comes from what Aside saw on screen (a summary saying he submitted it).
  // Matched locally in asidecontext.ts; nothing from the screen is sent to any model here.
  nextStore.useTransform((raws) => applyScreenDone(applyHints(raws, nextJev.read(), schoolSignals()), underTest ? [] : asideContext.doneSignals()));
  const nextNotify = new NextNotify({
    jev,
    statePath: path.join(config.miniapp.stateDir, 'next-notify.json'),
    items: () => {
      const p = nextStore.plan(new Date(), [], extraRaws());
      return [p.now, ...p.next, ...p.later].filter((x): x is NonNullable<typeof x> => Boolean(x));
    },
    send: (html) => notifier.notifyText(html),
    log: (msg, extra) => app.log.warn({ extra }, msg),
  });
  const runNextJev = () => {
    if (control.read().paused) return;
    void nextJev
      .run()
      .then(() => nextNotify.run())
      .catch((err) => app.log.warn({ err }, 'next jev run failed'));
  };
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    const jfirst = setTimeout(runNextJev, 90_000);
    const jevery = setInterval(runNextJev, 15 * 60_000);
    jfirst.unref();
    jevery.unref();
    app.addHook('onClose', async () => {
      clearTimeout(jfirst);
      clearInterval(jevery);
    });
  }
  // Memory poisoning check: every 6 hours, only notes that changed (memscan.ts).
  const memStatePath = path.join(config.miniapp.stateDir, 'memscan.json');
  const runMemScan = () => {
    if (control.read().paused) return;
    void scanMemory(jev, path.join(nextRoot, 'memory'), memStatePath)
      .then((r) => {
        for (const f of r.newFlags) {
          record('inspector', 'memory.flag', `A memory note may be planted: ${f.file} line ${f.line} reads like it tells Aside to send data out or drop its safeguards ("${f.excerpt.slice(0, 90)}…"). Nothing was changed; check it yourself.`, {
            detail: { file: f.file, line: f.line, p: f.p },
            risk: 'high',
          });
        }
        if (r.calls || r.newFlags.length) app.log.info({ r: { ...r, newFlags: r.newFlags.length } }, 'memory scan');
      })
      .catch((err) => app.log.warn({ err }, 'memory scan failed'));
  };
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    const mfirst = setTimeout(runMemScan, 5 * 60_000);
    const mevery = setInterval(runMemScan, 6 * 3_600_000);
    mfirst.unref();
    mevery.unref();
    app.addHook('onClose', async () => {
      clearTimeout(mfirst);
      clearInterval(mevery);
    });
  }
  app.get('/api/jev', { preHandler: requireAuth }, async () => {
    let memory: unknown = null;
    try {
      const m = JSON.parse(fs.readFileSync(memStatePath, 'utf8')) as { lastScanAt?: number; flags?: unknown[]; judged?: Record<string, number> };
      memory = { lastScanAt: m.lastScanAt ? new Date(m.lastScanAt).toISOString() : null, judged: Object.keys(m.judged ?? {}).length, flags: m.flags ?? [] };
    } catch {
      /* not yet */
    }
    return { status: jev.status(), next: { updatedAt: nextJev.read().updatedAt, runs: nextJev.read().runs.slice(-10) }, memory };
  });

  if (inbox && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    const tick = () => {
      if (control.read().paused) return;
      // A failed or partial sweep (throttled model, flaky Gmail helper)
      // tries again in 20 minutes instead of waiting out three hours.
      const failed = inbox.lastRun && (!inbox.lastRun.result.ok || (inbox.lastRun.result.pending ?? 0) > 0);
      if (failed ? sweepDue(new Date(), inbox.lastRun!.at, RETRY_MS) : sweepDue(new Date(), lastSweepAt())) {
        void inbox.sweep().then((r) => {
          app.log.info({ r }, 'school mail sweep');
          recordSweep(r, 'schedule');
          runNextJev();
        });
      }
    };
    const first = setTimeout(tick, 45_000);
    const every = setInterval(tick, 10 * 60_000);
    first.unref();
    every.unref();
    app.addHook('onClose', async () => {
      clearTimeout(first);
      clearInterval(every);
    });
  }
  /**
   * Personal Gmail. Needs its account in config and the Jev first look;
   * without Jev it does not run at all. Hourly, read-only, never Claude.
   */
  const personalConfig = readPersonalMailConfig(nextRoot);
  const personalFeed = path.join(feedsDir(nextRoot), 'personal-mail.json');
  const personal =
    personalConfig && mailConfig?.gate
      ? new PersonalSweeper({
          account: personalConfig.account,
          feedPath: personalFeed,
          cachePath: path.join(config.miniapp.stateDir, 'personal-cache.json'),
          repl: mailRepl,
          complete: mailComplete,
          decide: async (state) => {
            const ep = routerEndpoint(nextRoot, mailConfig.gate!);
            return ep ? jevPersonal(ep, jev.fetchFor('safety', 'mail.personal'))(state) : null;
          },
          privacy: { privateSenders: personalConfig.privateSenders, familyNames: personalConfig.familyNames, self: personalConfig.account },
          notForMe: personalConfig.notForMe,
          log: (msg, extra) => app.log.warn({ extra }, msg),
        })
      : null;
  const recordPersonal = (r: Awaited<ReturnType<PersonalSweeper['sweep']>>, why: 'schedule' | 'you') => {
    const priv = Object.values(r.counts.private).reduce((a, b) => a + (b ?? 0), 0);
    record('sorter', 'mail.personal', r.ok
      ? `Checked personal Gmail: ${r.items} on your trial list, ${priv} private kept from every model, ${r.counts.flagged} flagged.${r.waiting ? ` ${r.waiting} wait for Jev.` : ''}`
      : 'Personal Gmail check did not finish; it tries again next hour.', {
      detail: { items: r.items, private: priv, flagged: r.counts.flagged, waiting: r.waiting, trigger: why, tools: 'none', sent: false },
      risk: 'none',
    });
  };
  if (personal && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    const ptick = () => {
      // Hot-reloaded consent: a disconnect stops future scheduled reads without a restart.
      if (control.read().paused || !readPersonalMailConfig(nextRoot)) return;
      void personal.sweep().then((r) => recordPersonal(r, 'schedule'));
    };
    const pfirst = setTimeout(ptick, 90_000);
    const pevery = setInterval(ptick, 60 * 60_000);
    pfirst.unref();
    pevery.unref();
    app.addHook('onClose', async () => {
      clearTimeout(pfirst);
      clearInterval(pevery);
    });
  }
  app.post('/api/next/personal/refresh', { preHandler: requireAuth, config: { rateLimit: { max: 12, timeWindow: '1 hour' } } }, async (request, reply) => {
    if (!personal || !readPersonalMailConfig(nextRoot)) return reply.code(404).send({ error: 'personal_off' });
    if (control.read().paused) return reply.code(423).send({ error: 'paused' });
    const result = await personal.sweep();
    recordPersonal(result, 'you');
    return { result, plan: await livePlan() };
  });

  const threadOf = (id: string): string | null => {
    const m = /^school-mail:(\d{6,25})$/.exec(id);
    return m ? `thread-f:${m[1]}` : null;
  };

  app.post('/api/next/refresh', { preHandler: requireAuth }, async (request, reply) => {
    if (!inbox) return reply.code(404).send({ error: 'mail_off' });
    if (control.read().paused) return reply.code(423).send({ error: 'paused' });
    const result = await inbox.sweep();
    recordSweep(result as never, 'you');
    await nextJev.run().catch(() => undefined);
    return { result, plan: await livePlan() };
  });

  /** A reply draft from a model with no tools. Nothing leaves the Mac's control yet. */
  app.post('/api/next/:id/draft', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (isPersonalMailId(id)) return reply.code(403).send({ error: 'not_offered' });
    const threadId = threadOf(id);
    if (!drafter || !threadId) return reply.code(404).send({ error: 'not_found' });
    if (control.read().paused) return reply.code(423).send({ error: 'paused' });
    const plan = nextStore.plan(new Date(), []);
    const item = [plan.now, ...plan.next, ...plan.later, ...plan.unsure].find((it) => it?.id === id);
    if (!item || item.brief.mode !== 'draft' || item.flag) return reply.code(403).send({ error: 'not_offered' });
    const out = await drafter.draft(threadId);
    if ('error' in out) return reply.code(out.error === 'no_reply_address' ? 409 : 503).send(out);
    record('drafter', 'reply.draft', `Drafted a reply to ${item.sender?.name || 'an email'} for you to edit and send yourself.`, {
      itemId: id,
      detail: { tools: 'none', sent: false, to: item.sender?.host ?? null },
    });
    return out;
  });

  app.get('/api/next', { preHandler: requireAuth }, async (request, reply) => {
    try {
      return await livePlan();
    } catch (error) {
      request.log.error({ err: error }, 'next plan failed');
      return reply.code(500).send({ error: 'next_failed' });
    }
  });
  app.post(
    '/api/next/:id/action',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isValidNextId(id)) return reply.code(400).send({ error: 'bad_id' });
      const action = parseAction(request.body);
      if (!action) return reply.code(400).send({ error: 'bad_action' });
      try {
        // A project step marked done or reopened here is the same step on
        // the project timeline: keep both in step.
        const pm = /^project:([a-z0-9-]{3,40}):([a-z0-9-]{1,50})$/.exec(id);
        if (pm && (action.type === 'done' || action.type === 'reopen')) {
          projectStore.setMilestone(pm[1], pm[2], { status: action.type === 'done' ? 'done' : 'todo' });
        } else {
          nextStore.apply(id, action);
        }
        const verb: Record<string, string> = { done: 'Marked done', dismiss: 'Dismissed', keep: 'Kept', reopen: 'Reopened', snooze: 'Snoozed', handoff: 'Handed off' };
        record('you', `item.${action.type}`, `${verb[action.type] ?? action.type}: ${(await livePlanTitle(id)) ?? 'an item'}.`, { itemId: id });
        return await livePlan();
      } catch (error) {
        request.log.error({ err: error, id }, 'next action failed');
        return reply.code(500).send({ error: 'next_action_failed' });
      }
    },
  );

  /**
   * Start an agent on a task. The phone sends only the task id: the prompt
   * is built here from the server's own record and the code-written brief,
   * so no client can widen what the agent is told. Email-derived and
   * flagged items are refused outright (agentPromptFor returns null).
   *
   * Session creation reuses POST /api/sessions/new through inject, so the
   * mobile preamble, model defaults and permission handling stay in one
   * place. The caller's own credentials are forwarded; nothing is minted.
   */
  /**
   * A model pinned for Next in <aside root>/next/config.json (agentModel)
   * wins: hand-offs read his memory profile, so they should not inherit a
   * free model whose provider may train on inputs. Else the phone's own
   * pick, else the Mac's default.
   */
  // Standby helpers are made in the background, so this can never be
  // Claude, whatever is pinned or set as the Mac's default (guards.ts).
  /** Pre-made idle helper chats. Off by default since Sep 27 (config.json `standbys: true` brings them back). */
  const standbysOn = (): boolean => {
    try {
      return JSON.parse(fs.readFileSync(path.join(nextRoot, 'next', 'config.json'), 'utf8')).standbys === true;
    } catch {
      return false;
    }
  };
  const nextStartModel = (): string | null => {
    const pinned = readAgentModel(nextRoot);
    if (pinned) return backgroundModel(pinned);
    const o = settings.read();
    if (o.defaultProvider && o.defaultModelId) return backgroundModel(`${o.defaultProvider}/${o.defaultModelId}`);
    const d = readDesktopState(config.sessionsDir).defaultModel ?? peekDefaultModel(facade);
    return backgroundModel(d?.provider && d?.modelId ? `${d.provider}/${d.modelId}` : null);
  };
  /**
   * Let Next help: start a task helper, only from his tap. The phone sends
   * only the task id; the prompt is built here from the server's own record.
   * With { wait: true } and no locked session ready, it waits and starts
   * the moment one is (his tap is the instruction). Without wait it starts
   * now in Aside's Guard mode and the log says the stricter limits were off.
   */
  app.post('/api/next/:id/start', { preHandler: requireAuth, config: { rateLimit: { max: 6, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidNextId(id)) return reply.code(400).send({ error: 'bad_id' });
    if (control.read().paused) return reply.code(423).send({ error: 'paused', message: 'Next is paused. Turn it back on first.' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const prep = helperFor(id);
    if ('error' in prep) return reply.code(prep.code).send({ error: prep.error });
    const { item, want } = prep;
    if (readWaiting().some((w) => w.itemId === id)) return reply.code(409).send({ error: 'already_waiting' });
    const slotReady = want ? armedPool.status().some((x) => x.key === slotKey(want.kind, want.host) && x.ready) : false;
    if (body.wait === true && want && !slotReady && standbysOn()) {
      writeWaiting([...readWaiting(), { itemId: id, kind: want.kind, host: want.host, at: new Date().toISOString() }]);
      record('you', 'helper.wait', `Asked Next to help with "${item.title}". It starts when its locked browser is ready, about ${readyIn(want.kind, want.host) ?? 12} min.`, { itemId: id, detail: { limits: describeRules(want.kind, want.host) } });
      void armedPool.ensure(wantedStandbys()).catch(() => undefined);
      return { sessionId: null, waiting: true, plan: await livePlan() };
    }
    const started = await startHelper(id, request);
    if ('error' in started) return reply.code(started.code).send({ error: started.error });
    return { sessionId: started.sessionId, waiting: false, plan: await livePlan() };
  });

  app.post('/api/next/:id/start/cancel', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidNextId(id)) return reply.code(400).send({ error: 'bad_id' });
    const before = readWaiting();
    if (!before.some((w) => w.itemId === id)) return reply.code(404).send({ error: 'not_waiting' });
    writeWaiting(before.filter((w) => w.itemId !== id));
    record('you', 'helper.cancel', `Cancelled help with "${(await livePlanTitle(id)) ?? 'a task'}" before it started.`, { itemId: id });
    return livePlan();
  });

  async function livePlanTitle(id: string): Promise<string | null> {
    const pm = /^project:([a-z0-9-]{3,40}):([a-z0-9-]{1,50})$/.exec(id);
    if (pm) return projectStore.get(pm[1])?.milestones.find((m) => m.id === pm[2])?.title ?? null;
    const raw = nextStore.rawFor(id, new Date(), taskStore.list().map(taskRaw));
    return raw ? raw.title.slice(0, 80) : null;
  }

  // ---------------------------------------------------------------- Projects
  const projectIdOk = (id: string) => /^[a-z0-9-]{3,40}$/.test(id);
  const projectReply = (id: string) => {
    const p = projectStore.get(id);
    if (!p) return null;
    const v = scheduleProject(p, new Date());
    const waiting = researchStore.active({ projectId: id });
    return {
      ...v,
      inspect: {
        ...v.inspect,
        state: waiting ? ('running' as const) : v.inspect.state,
        preparing: waiting?.state === 'preparing',
        readyInMin: waiting?.state === 'preparing' ? waiting.readyInMin ?? readyIn('inspector', null) : null,
      },
    };
  };

  // ------------------------------------------------------ Hard-limit standbys
  const msgMtime = (sid: string): number | null => {
    const f = sessionMsgFile(config.sessionsDir, sid);
    try {
      return f ? fs.statSync(f).mtimeMs : null;
    } catch {
      return null;
    }
  };
  const armedPool = new ArmedPool({
    file: path.join(config.miniapp.stateDir, 'next-armed.json'),
    create: async (label) => {
      const model = nextStartModel();
      const { sessionId } = await runner.createSession(
        {
          text: `${standbyMarker(label)} This session is being prepared for a later task. Reply with exactly READY and do nothing else.`,
          model: runner.resolveModel(model ?? undefined),
          effort: runner.resolveEffort('low'),
        },
        { permissionMode: 'guard' },
      );
      return sessionId;
    },
    arm: async (sessionId, rules, title) => {
      const lit = (v: unknown) => JSON.stringify(v);
      // Rules first, on their own: a permissionMode change in the same
      // update would rewrite them. Runtime config second.
      await facade.mutate(`aside.sessions.update(${lit(sessionId)}, ${lit({ title, permission: rules })})`);
      await facade.mutate(
        `aside.sessions.update(${lit(sessionId)}, ${lit({ runtimeConfig: { memoryExtractionDisabled: true, proactiveMode: false, finalConfirm: false } })})`,
      );
    },
    busy: (sid) => Boolean(runner.activityOf(sid)),
    model: () => nextStartModel(),
    lastWrite: msgMtime,
    isOurs: (sid, key) => {
      const f = sessionMsgFile(config.sessionsDir, sid);
      return Boolean(f) && firstUserText(f!).startsWith(standbyMarker(key));
    },
    log: (msg, extra) => app.log.warn({ extra }, msg),
  });
  /**
   * What standbys are worth keeping warm: one web researcher always, the
   * inspector while a project is active, a page reader for each site on
   * his list, and first of all whatever a waiting brief needs.
   */
  const wantedStandbys = (): Array<{ kind: ArmedKind; host?: string | null }> => {
    const out: Array<{ kind: ArmedKind; host?: string | null }> = [];
    const add = (k: { kind: ArmedKind; host?: string | null }) => {
      if (!out.some((o) => slotKey(o.kind, o.host) === slotKey(k.kind, k.host))) out.push(k);
    };
    if (ACTION_HELPERS_ENABLED) for (const w of readWaiting()) add({ kind: w.kind, host: w.host });
    for (const b of researchStore.list()) if (b.state === 'preparing') add({ kind: b.kind, host: b.host });
    add({ kind: 'web' });
    if (projectStore.list().some((p) => p.status === 'active')) add({ kind: 'inspector' });
    try {
      const plan = nextStore.plan(new Date(), [], extraRaws());
      for (const it of [plan.now, ...plan.next, ...plan.later]) {
        if (!it) continue;
        if (it.brief.mode === 'agent') {
          const k = kindForTask({ ...it, link: it.link });
          if (k) add(k);
        }
        if (it.brief.research?.kind === 'reader') add(it.brief.research);
      }
    } catch {
      /* the plan is best effort here */
    }
    return out.slice(0, 5);
  };
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    const armTick = () => {
      if (control.read().paused) return;
      // Sep 27: pre-made idle chats are off unless config.json says standbys: true.
      void (standbysOn() ? armedPool.ensure(wantedStandbys()) : Promise.resolve())
        // A helper that has written nothing for 10 minutes while "busy" is stuck (the free
        // model sometimes never answers): stop it so it gets reported instead of hanging for hours.
        .then(() => {
          const ids = new Set([...startedAtOf.keys()].filter((s) => !finishLogged.has(s)));
          for (const b of researchStore.list()) if (b.state === 'running' && b.sessionId) ids.add(b.sessionId);
          for (const sid of ids) {
            const mt = msgMtime(sid);
            if (runner.activityOf(sid) && mt && Date.now() - mt > 10 * 60_000) {
              app.log.warn({ sid }, 'helper stuck; stopping');
              runner.stop(sid);
            }
          }
        })
        // A running helper's finish is noticed (and pinged) even if the app isn't open.
        .then(() => ([...startedAtOf.keys()].some((s) => !finishLogged.has(s)) ? livePlan().then(() => undefined) : undefined))
        .then(() => pumpResearch())
        .then(() => pumpWaiting())
        .catch((err) => app.log.warn({ err }, 'standby ensure failed'));
    };
    const a1 = setTimeout(armTick, 60_000);
    const a2 = setInterval(armTick, 60_000);
    a1.unref();
    a2.unref();
    app.addHook('onClose', async () => {
      clearTimeout(a1);
      clearInterval(a2);
    });
  }
  /** Sessions whose finish is already in the log, so each is logged once. */
  const finishLogged = new Set<string>(
    ledger
      .list({ limit: 200 })
      .entries.filter((e) => e.kind === 'agent.finish' && e.sessionId)
      .map((e) => e.sessionId!),
  );
  const startedAtOf = new Map<string, number>();

  /**
   * Start an agent with a code-written prompt. A ready standby for this
   * kind of task gets the prompt (hard limits from the first step). With
   * none ready, a fresh session starts under Guard and instructions only,
   * and the caller says so in the log.
   */
  /**
   * Start a new chat whose first message is the real task (Sep 27). The
   * old way sent the task into a chat that had been told "reply READY and
   * nothing else", and the model often just said READY again. Written
   * limits ride in the prompt; Aside's hard rules are set right after so
   * they hold if the chat is ever picked up again.
   */
  // ------------------------------------------- Hey Aside: full tasks in locked sessions
  // A separate standby pool for the phone (voice/agent.ts explains the limits). Same
  // mechanism as Next's: create, write rules, idle past Aside's unload, then use once.
  const voiceStandbyMarker = (key: string) => `[Hey Aside standby: ${key}]`;
  const voiceArmedKind = (k: VoiceTaskKind): ArmedKind => (k === 'research' ? 'web' : 'open-web');
  /** voice-config.json "agentModel" (e.g. his laptop Hey Aside model), else Next's. Never Claude (guards.ts). */
  const voiceModel = (): string | null => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(config.miniapp.stateDir, 'voice-config.json'), 'utf8')).agentModel;
      if (typeof m === 'string' && /^[\w.-]+\/[\w.:-]+$/.test(m)) return backgroundModel(m);
    } catch { /* fall through */ }
    return nextStartModel();
  };
  const voiceStandbyIsOurs = (sid: string, key: string) => {
    const f = sessionMsgFile(config.sessionsDir, sid);
    return Boolean(f) && firstUserText(f!).startsWith(voiceStandbyMarker(key));
  };
  const voicePool = new ArmedPool({
    file: path.join(config.miniapp.stateDir, 'voice-armed.json'),
    create: async (label) => {
      const { sessionId } = await runner.createSession(
        {
          text: `${voiceStandbyMarker(label)} This session is being prepared for a later task. Reply with exactly READY and do nothing else.`,
          model: runner.resolveModel(voiceModel() ?? undefined),
          effort: runner.resolveEffort('low'),
        },
        { permissionMode: 'guard' },
      );
      // Hidden from his chat list until a real task uses it (unarchived in start()).
      await facade.mutate(`aside.sessions.archive(${JSON.stringify(sessionId)})`).catch(() => undefined);
      return sessionId;
    },
    discard: (slot) => {
      // Only our own never-used standby (first message carries the marker) is ever deleted.
      if (!voiceStandbyIsOurs(slot.sessionId, slot.key)) return;
      execFile(config.asideCli, ['session', 'delete', slot.sessionId], { timeout: 20_000 }, (err) => { if (err) app.log.warn({ err: String(err) }, 'voice standby delete failed'); });
    },
    arm: async (sessionId, rules, title) => {
      const lit = (v: unknown) => JSON.stringify(v);
      await facade.mutate(`aside.sessions.update(${lit(sessionId)}, ${lit({ title: title.replace('Next', 'Hey Aside'), permission: rules })})`);
      await facade.mutate(`aside.sessions.update(${lit(sessionId)}, ${lit({ runtimeConfig: { memoryExtractionDisabled: true, proactiveMode: false, finalConfirm: false } })})`);
    },
    busy: (sid) => Boolean(runner.activityOf(sid)),
    model: () => voiceModel(),
    lastWrite: (sid) => msgMtime(sid),
    isOurs: (sid, key) => voiceStandbyIsOurs(sid, key),
    log: (msg, extra) => app.log.warn({ extra }, `voice ${msg}`),
  });
  const voiceWanted = () => [{ kind: 'web' as const }, { kind: 'open-web' as const }];
  interface VoiceTask { sessionId: string; kind: VoiceTaskKind; startedAt: number; state: 'running' | 'done' | 'failed' }
  const voiceTasks = new Map<string, VoiceTask>();
  runner.on('turn_finished', (p: { sessionId: string; exitCode: number | null; error?: string; stopped?: boolean }) => {
    for (const t of voiceTasks.values()) if (t.sessionId === p.sessionId && t.state === 'running') t.state = p.exitCode === 0 && !p.error && !p.stopped ? 'done' : 'failed';
  });
  const voiceAgent: VoiceAgent = {
    limits: (k) => describeRules(voiceArmedKind(k)),
    readyIn: (k) => {
      const s = voicePool.status().find((x) => x.key === slotKey(voiceArmedKind(k)));
      return s ? (s.ready ? 0 : s.readyInMin) : null;
    },
    start: async (k, request) => {
      const slot = voicePool.take(voiceArmedKind(k));
      if (!slot) {
        void voicePool.ensure(voiceWanted()).catch(() => undefined);
        return { error: 'warming', readyInMin: voiceAgent.readyIn(k) };
      }
      try {
        runner.send(slot.sessionId, { text: taskPrompt(k, request), model: runner.resolveModel(voiceModel() ?? undefined), effort: runner.resolveEffort('medium') });
      } catch (err) {
        app.log.error({ err }, 'voice task start failed');
        return { error: 'failed' };
      }
      // Now a real task: back in his chat list under a clear title.
      void facade.mutate(`aside.sessions.unarchive(${JSON.stringify(slot.sessionId)})`).catch(() => undefined);
      void facade.mutate(`aside.sessions.update(${JSON.stringify(slot.sessionId)}, ${JSON.stringify({ title: `Hey Aside · ${request}`.slice(0, 80) })})`).catch(() => undefined);
      const id = crypto.randomBytes(12).toString('hex');
      voiceTasks.set(id, { sessionId: slot.sessionId, kind: k, startedAt: Date.now(), state: 'running' });
      for (const [old, t] of voiceTasks) if (Date.now() - t.startedAt > 6 * 60 * 60_000) voiceTasks.delete(old);
      void voicePool.ensure(voiceWanted()).catch(() => undefined);
      return { taskId: id };
    },
    status: (id): VoiceTaskStatus | null => {
      const t = voiceTasks.get(id);
      if (!t) return null;
      const live = runner.activityOf(t.sessionId);
      if (t.state === 'running' && !live && Date.now() - t.startedAt > 5000) t.state = 'done';
      const file = sessionMsgFile(config.sessionsDir, t.sessionId) ?? null;
      const { say, detail } = t.state === 'running' ? { say: null, detail: null } : splitReply(lastReplyText(file, t.startedAt, 2400));
      const state = t.state === 'done' && !say ? 'failed' : t.state;
      return {
        state,
        step: live?.activity?.summary ?? null,
        say: say ?? (state === 'failed' ? 'That task didn’t finish. It’s in your Aside chats on the Mac.' : null),
        detail,
        denied: countDenied(file, t.startedAt).denied,
      };
    },
    stop: (id) => {
      const t = voiceTasks.get(id);
      if (!t || t.state !== 'running') return false;
      if (!runner.stop(t.sessionId)) void runner.stopRemote(t.sessionId).catch(() => false);
      t.state = 'failed';
      return true;
    },
  };
  if (voiceTasksOn && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    const voiceTick = () => void voicePool.ensure(voiceWanted()).catch((err) => app.log.warn({ err }, 'voice standby tick failed'));
    setTimeout(voiceTick, 5_000);
    setInterval(voiceTick, 60_000).unref();
  }

  const startFresh = async (kind: ArmedKind, host: string | null, text: string, title: string, effort: string): Promise<string> => {
    const model = nextStartModel();
    const { sessionId } = await runner.createSession(
      { text, model: runner.resolveModel(model ?? undefined), effort: runner.resolveEffort(effort as never) },
      { permissionMode: 'guard' },
    );
    const lit = (v: unknown) => JSON.stringify(v);
    void facade
      .mutate(`aside.sessions.update(${lit(sessionId)}, ${lit({ title: title.slice(0, 80), permission: rulesFor(kind, host ?? undefined) })})`)
      .then(() => facade.mutate(`aside.sessions.update(${lit(sessionId)}, ${lit({ runtimeConfig: { memoryExtractionDisabled: true, proactiveMode: false } })})`))
      .catch((err) => app.log.warn({ err }, 'fresh helper setup failed'));
    return sessionId;
  };

  const startAgent = async (
    request: FastifyRequest | null,
    prompt: string,
    want: { kind: ArmedKind; host: string | null } | null,
    title: string,
  ): Promise<{ sessionId: string; hard: boolean } | null> => {
    const headers = {
      ...(request?.headers.authorization ? { authorization: request.headers.authorization } : {}),
      ...(request?.headers.cookie ? { cookie: request.headers.cookie } : {}),
      'content-type': 'application/json',
    };
    const slot = want ? armedPool.take(want.kind, want.host) : null;
    if (slot) {
      runner.send(slot.sessionId, {
        text: withPreamble(prompt, { strictConfirm: true }),
        model: runner.resolveModel(nextStartModel() ?? undefined),
        effort: runner.resolveEffort(settings.read().defaultEffort),
      });
      {
        startedAtOf.set(slot.sessionId, Date.now());
        void facade
          .mutate(`aside.sessions.update(${JSON.stringify(slot.sessionId)}, ${JSON.stringify({ title: `Next helper · ${title}`.slice(0, 80) })})`)
          .catch(() => undefined);
        // Warm the next one now so the following start is covered too.
        void armedPool.ensure(wantedStandbys()).catch(() => undefined);
        return { sessionId: slot.sessionId, hard: true };
      }
    }
    if (!standbysOn()) {
      try {
        const sessionId = await startFresh(want?.kind ?? 'open-web', want?.host ?? null, withPreamble(prompt, { strictConfirm: true }), `Next · ${title}`, settings.read().defaultEffort ?? 'medium');
        startedAtOf.set(sessionId, Date.now());
        return { sessionId, hard: false };
      } catch (err) {
        app.log.error({ err }, 'helper start failed');
        return null;
      }
    }
    // Without a locked browser, only a direct tap starts one now.
    if (!request) return null;
    const model = nextStartModel();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/new',
      headers,
      payload: { text: prompt, permissionMode: 'guard', finalConfirm: true, ...(model ? { model } : {}) },
    });
    if (res.statusCode >= 300) {
      request.log.error({ status: res.statusCode, body: res.body.slice(0, 300) }, 'agent start failed');
      return null;
    }
    const sessionId = (res.json() as { sessionId?: string }).sessionId;
    if (!sessionId) return null;
    startedAtOf.set(sessionId, Date.now());
    if (want) void armedPool.ensure(wantedStandbys()).catch(() => undefined);
    return { sessionId, hard: false };
  };


  // ----------------------------------------------- Let Next help (tap only)
  interface Waiting { itemId: string; kind: HelperKind; host: string | null; at: string }
  const waitingFile = path.join(config.miniapp.stateDir, 'next-waiting.json');
  const readWaiting = (): Waiting[] => {
    try {
      const d = JSON.parse(fs.readFileSync(waitingFile, 'utf8')) as { waiting?: Waiting[] };
      return (d.waiting ?? []).filter((w) => w && isValidNextId(w.itemId) && ['coursework', 'site', 'open-web'].includes(w.kind));
    } catch {
      return [];
    }
  };
  const writeWaiting = (list: Waiting[]) => {
    const tmp = `${waitingFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ waiting: list.slice(-20) }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, waitingFile);
  };

  /** The helper a tap would start for an item, from the server's own record. */
  const helperFor = (id: string):
    | { item: NonNullable<NextPlan['now']>; prompt: string; want: { kind: HelperKind; host: string | null } | null }
    | { error: string; code: number } => {
    if (!ACTION_HELPERS_ENABLED) return { error: 'helpers_disabled', code: 403 };
    if (isPersonalMailId(id)) return { error: 'not_offered', code: 403 };
    const extras = extraRaws();
    const plan = nextStore.plan(new Date(), [], extras);
    const item = [plan.now, ...plan.next, ...plan.later, ...plan.unsure].find((it) => it?.id === id);
    const raw = nextStore.rawFor(id, new Date(), extras);
    if (!item || !raw) return { error: 'not_found', code: 404 };
    const prompt = agentPromptFor({ ...raw, kind: item.kind, taint: item.taint, flag: item.flag }, item.brief);
    if (!prompt) return { error: 'not_offered', code: 403 };
    return { item, prompt, want: kindForTask({ ...item, link: item.link }) };
  };

  /** Start the helper now: a locked session if one is ready, else Guard. */
  const startHelper = async (id: string, request: FastifyRequest | null): Promise<{ sessionId: string; hard: boolean } | { error: string; code: number }> => {
    const prep = helperFor(id);
    if ('error' in prep) return prep;
    const { item, prompt, want } = prep;
    const started = await startAgent(request, prompt, want, item.title);
    if (!started) return { error: 'start_failed', code: 503 };
    const { sessionId, hard } = started;
    nextStore.apply(id, { type: 'handoff', sessionId });
    record('agent', 'helper.start', `Next's helper started on "${item.title}". It stops before submitting anything.${hard ? ' Locked to the sites this task needs.' : ' It runs under Aside\'s guard with written limits.'}`, {
      itemId: id,
      sessionId,
      detail: {
        model: nextStartModel() ?? 'default',
        locked: hard,
        limits: hard && want ? describeRules(want.kind, want.host) : "Aside's normal guard, plus instructions",
        stopsAt: item.brief.stopsAt.slice(0, 120),
      },
      risk: hard ? 'none' : 'low',
    });
    return started;
  };

  /** Start any help he asked to wait for, once its locked browser is ready. */
  const pumpWaiting = async () => {
    // Preserve existing requests; disabled helpers neither run nor consume the queue.
    if (!ACTION_HELPERS_ENABLED || control.read().paused) return;
    for (const w of readWaiting()) {
      if (standbysOn() && !armedPool.status().some((x) => x.key === slotKey(w.kind, w.host) && x.ready)) continue;
      writeWaiting(readWaiting().filter((x) => x.itemId !== w.itemId));
      const out = await startHelper(w.itemId, null);
      if ('error' in out) {
        record('system', 'helper.skipped', `Couldn't start help on a task you asked for: ${out.error === 'not_found' ? "it's no longer on your list" : 'it could not start'}.`, { itemId: w.itemId });
      }
    }
  };
  // --------------------------------------------------------------- Research
  const researchStore = new ResearchStore(path.join(nextDir, 'research.json'));
  const pageFetcher = publicFetcher();
  // Briefs that finished before audits existed get one, newest first, a few at a time.
  const backfillAudits = async () => {
    const todo = researchStore
      .list()
      .filter((b) => b.state === 'ready' && b.report && !b.audit)
      .slice(0, 3);
    for (const b of todo) {
      const audit = await auditReport(b.report!, jev, pageFetcher).catch(() => null);
      if (audit && !audit.skipped) researchStore.update(b.id, { audit });
      else break;
    }
  };
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    const bf = setTimeout(() => void backfillAudits(), 2 * 60_000);
    bf.unref();
  }
  const researchFacts = (): string[] => (mailConfig?.facts ? [mailConfig.facts] : []);

  /** The item behind an id, from the live plan (never from the client). */
  const planItem = (id: string) => {
    const extras = extraRaws();
    const plan = nextStore.plan(new Date(), [], extras);
    const item = [plan.now, ...plan.next, ...plan.later, ...plan.unsure].find((it) => it?.id === id) ?? null;
    const raw = item ? nextStore.rawFor(id, new Date(), extras) : null;
    return item && raw ? { item, raw } : null;
  };

  /** The code-owned prompt for a brief, rebuilt from the server's own records. */
  const promptForBrief = (b: ResearchBrief): string | null => {
    if (b.projectId) {
      const p = projectStore.get(b.projectId);
      return p ? inspectorPrompt(p, new Date()) : null;
    }
    if (b.itemId) {
      const found = planItem(b.itemId);
      if (!found) return null;
      const { item, raw } = found;
      const input = { ...raw, kind: item.kind, taint: item.taint, flag: item.flag };
      return researchPromptFor(input, researchPlanFor(input), undefined, b.kind === 'web' ? researchFacts() : []);
    }
    return questionPrompt(b.question, researchFacts());
  };

  const readyIn = (kind: ArmedKind, host: string | null): number | null => {
    if (!standbysOn()) return 0;
    const sb = armedPool.status().find((x) => x.key === slotKey(kind, host));
    return sb ? (sb.ready ? 0 : sb.readyInMin ?? 12) : 13;
  };

  /**
   * Start a brief on a ready standby. Research only ever runs on a session
   * whose hard limits have bound; with none ready it keeps waiting.
   */
  const launch = (b: ResearchBrief): boolean => {
    if (control.read().paused) return false;
    const prompt = promptForBrief(b);
    if (!prompt) {
      researchStore.update(b.id, { state: 'failed', error: 'The task is no longer on your list.', finishedAt: new Date().toISOString() });
      return false;
    }
    const slot = standbysOn() ? armedPool.take(b.kind, b.host) : null;
    if (!slot && !standbysOn()) {
      // Start now in a new chat whose first message is the question.
      const at0 = new Date().toISOString();
      researchStore.update(b.id, { state: 'running', sessionId: null, startedAt: at0, hardLimits: false, readyInMin: null });
      if (b.projectId) projectStore.setInspect(b.projectId, { state: 'running', sessionId: null, startedAt: at0, finishedAt: null, error: null });
      void startFresh(b.kind, b.host, prompt, `Next · ${b.title}`, 'medium')
        .then((sid) => {
          researchStore.update(b.id, { sessionId: sid, startedAt: new Date().toISOString() });
          if (b.projectId) projectStore.setInspect(b.projectId, { state: 'running', sessionId: sid, startedAt: new Date().toISOString(), finishedAt: null, error: null });
          record(b.kind === 'inspector' ? 'inspector' : 'agent', 'research.start', `Started looking into "${b.title}". Read only: it's told not to click, type, or submit anything.`, {
            itemId: b.itemId ?? undefined,
            projectId: b.projectId ?? undefined,
            sessionId: sid,
            detail: { model: nextStartModel() ?? 'default', hardLimits: false, limits: b.limits },
            risk: 'none',
          });
        })
        .catch((err) => {
          app.log.error({ err }, 'research start failed');
          researchStore.update(b.id, { state: 'failed', error: "Couldn't start. Try again in a minute.", finishedAt: new Date().toISOString() });
          if (b.projectId) projectStore.setInspect(b.projectId, { state: 'idle', error: "Couldn't start.", finishedAt: new Date().toISOString() });
        });
      return true;
    }
    if (!slot) {
      researchStore.update(b.id, { readyInMin: readyIn(b.kind, b.host) });
      return false;
    }
    const model = nextStartModel();
    runner.send(slot.sessionId, {
      text: prompt,
      model: runner.resolveModel(model ?? undefined),
      effort: runner.resolveEffort('medium'),
    });
    const at = new Date().toISOString();
    researchStore.update(b.id, { state: 'running', sessionId: slot.sessionId, startedAt: at, hardLimits: true, readyInMin: null });
    void facade
      .mutate(`aside.sessions.update(${JSON.stringify(slot.sessionId)}, ${JSON.stringify({ title: `Next research · ${b.title}`.slice(0, 80) })})`)
      .catch(() => undefined);
    if (b.projectId) {
      projectStore.setInspect(b.projectId, { state: 'running', sessionId: slot.sessionId, startedAt: at, finishedAt: null, error: null });
    }
    record(b.kind === 'inspector' ? 'inspector' : 'agent', 'research.start', `Started looking into "${b.title}". Read only: it can't click, type, or submit anything.`, {
      itemId: b.itemId ?? undefined,
      projectId: b.projectId ?? undefined,
      sessionId: slot.sessionId,
      detail: { model: model ?? 'default', hardLimits: true, limits: b.limits },
      risk: 'none',
    });
    void armedPool.ensure(wantedStandbys()).catch(() => undefined);
    return true;
  };

  /** Start what can start; settle what finished. Cheap; called often. */
  const pumpResearch = () => {
    for (const b of researchStore.list()) {
      if (b.state === 'preparing') launch(b);
      if (b.state !== 'running' || !b.sessionId || b.projectId) continue;
      if (runner.activityOf(b.sessionId)) continue;
      const startedAt = Date.parse(b.startedAt ?? '') || 0;
      const msgFile = sessionMsgFile(config.sessionsDir, b.sessionId);
      const res = readResearch(msgFile, startedAt);
      const stale = Date.now() - startedAt > 45 * 60_000;
      if (!res.finished && !stale) continue;
      const blocked = countDenied(msgFile, startedAt).denied;
      const at = new Date().toISOString();
      const actor = b.kind === 'inspector' ? 'inspector' : 'agent';
      if (res.report) {
        researchStore.update(b.id, { state: 'ready', report: res.report, finishedAt: at, tokens: res.tokens, blocked, sourcesRead: res.sourcesRead, error: null });
        // Second look by code and Jev: what the pages said, and what the brief says.
        const report = res.report;
        void auditReport(report, jev, pageFetcher)
          .then((audit) => {
            researchStore.update(b.id, { audit });
            const badSources = audit.sources.filter((x) => x.bait).length;
            const weak = audit.points.filter((x) => x !== null && x < SUPPORT_LOW).length;
            const pushy = (audit.pushy ?? 0) >= PUSHY_AT;
            record('inspector', 'research.audit', `Checked "${b.title}": ${audit.sources.filter((x) => x.fetched).length} of ${audit.sources.length} cited pages re-read${badSources ? `, ${badSources} had text aimed at an AI` : ''}${weak ? `, ${weak} point${weak === 1 ? '' : 's'} not backed by ${weak === 1 ? 'its' : 'their'} source` : ''}${pushy ? ', and the brief pushes you to log in, click, or share something' : ''}.${audit.skipped ? ` Part was skipped (${audit.skipped}).` : ''}`, {
              itemId: b.itemId ?? undefined,
              sessionId: b.sessionId ?? undefined,
              detail: { calls: audit.calls, badSources, weak, pushy },
              risk: badSources || pushy ? 'high' : 'none',
            });
          })
          .catch((err) => app.log.warn({ err }, 'research audit failed'));
        {
          const r = res.report;
          const lead = [r.verdictLabel, r.summary].filter(Boolean).join('. ').slice(0, 600);
          void notifier
            .notifyText(`<b>Next looked into:</b> ${escHtml(b.title)}\n\n${escHtml(lead || 'Done. Open the task to read it.')}\n\n${r.sources.length} source${r.sources.length === 1 ? '' : 's'}. Full answer is on the task in Next.`)
            .catch(() => undefined);
        }
        record(actor, 'research.ready', `Done looking into "${b.title}": ${res.report.verdictLabel ? `${res.report.verdictLabel}. ` : ''}${res.report.sources.length} source${res.report.sources.length === 1 ? '' : 's'}.${blocked ? ` It was blocked ${blocked} time${blocked === 1 ? '' : 's'} from going outside its limits.` : ''}`, {
          itemId: b.itemId ?? undefined,
          sessionId: b.sessionId,
          detail: { tokens: res.tokens, blocked, sources: res.report.sources.length },
          risk: blocked ? 'high' : 'none',
        });
      } else {
        const error = res.error ?? 'It took too long and was left alone.';
        researchStore.update(b.id, { state: 'failed', error, finishedAt: at, tokens: res.tokens, blocked, sourcesRead: res.sourcesRead });
        record(actor, 'research.failed', `Looking into "${b.title}" didn't finish: ${error}`, {
          itemId: b.itemId ?? undefined,
          sessionId: b.sessionId,
          detail: { tokens: res.tokens, blocked },
          risk: blocked ? 'high' : 'none',
        });
      }
    }
  };

  /**
   * Queue a brief. The kind (and so its hard limits) is decided here from
   * the server's own record of the item, never by the client.
   */
  const queueResearch = (input: { itemId?: string; projectId?: string; question?: string }):
    | { brief: ResearchBrief }
    | { error: string; code: number } => {
    if (control.read().paused) return { error: 'paused', code: 423 };
    // Personal Gmail never feeds research, not even its title.
    if (input.itemId && isPersonalMailId(input.itemId)) return { error: 'not_offered', code: 403 };
    let kind: ArmedKind;
    let host: string | null = null;
    let title: string;
    let question: string;
    if (input.projectId) {
      const p = projectStore.get(input.projectId);
      if (!p) return { error: 'not_found', code: 404 };
      if (researchStore.active({ projectId: p.id })) return { error: 'already_running', code: 409 };
      kind = 'inspector';
      title = `Where ${p.title} stands`;
      question = `Inspect the project "${p.title}" and propose the steps left.`;
    } else if (input.itemId) {
      if (!isValidNextId(input.itemId)) return { error: 'bad_id', code: 400 };
      const found = planItem(input.itemId);
      if (!found) return { error: 'not_found', code: 404 };
      const k = found.item.brief.research;
      if (!k) return { error: 'not_offered', code: 403 };
      if (researchStore.active({ itemId: input.itemId })) return { error: 'already_running', code: 409 };
      kind = k.kind;
      host = k.host;
      title = found.item.title;
      question = found.item.brief.headline;
    } else {
      const q = String(input.question ?? '').trim();
      if (!q || q.length > 300) return { error: 'bad_question', code: 400 };
      kind = 'web';
      title = q.slice(0, 90);
      question = q;
    }
    const brief = researchStore.create({
      question,
      title,
      kind,
      host,
      itemId: input.itemId ?? null,
      projectId: input.projectId ?? null,
      limits: describeRules(kind, host),
    });
    record('you', 'research.request', `Asked Next to look into "${brief.title}".`, {
      itemId: brief.itemId ?? undefined,
      projectId: brief.projectId ?? undefined,
      detail: { kind, limits: brief.limits },
    });
    if (brief.projectId) projectStore.setInspect(brief.projectId, { state: 'running', sessionId: null, startedAt: null, finishedAt: null, error: null });
    if (!launch(brief)) void armedPool.ensure(wantedStandbys()).catch(() => undefined);
    return { brief: researchStore.get(brief.id) ?? brief };
  };

  /**
   * Finish any inspector that has stopped: read its answer, validate it,
   * and store it as a proposal. Called on read, so no timer is needed.
   */
  const settleInspectors = () => {
    for (const p of projectStore.list()) {
      if (p.inspect.state !== 'running' || !p.inspect.sessionId) continue;
      const startedAt = Date.parse(p.inspect.startedAt ?? '') || 0;
      if (runner.activityOf(p.inspect.sessionId)) continue;
      const res = readInspector(sessionMsgFile(config.sessionsDir, p.inspect.sessionId), p.inspect.sessionId, startedAt);
      const stale = Date.now() - startedAt > 45 * 60_000;
      if (!res.finished && !stale) continue;
      const at = new Date().toISOString();
      if (res.proposal) {
        projectStore.setProposal(p.id, res.proposal);
        projectStore.setInspect(p.id, { state: 'idle', finishedAt: at, error: null });
        const pb = researchStore.active({ projectId: p.id });
        if (pb) {
          researchStore.update(pb.id, {
            state: 'ready',
            finishedAt: at,
            tokens: res.tokens,
            blocked: countDenied(sessionMsgFile(config.sessionsDir, p.inspect.sessionId), startedAt).denied,
            report: {
              title: `Where ${p.title} stands`,
              verdict: null,
              verdictLabel: null,
              summary: res.proposal.summary || 'A new plan is waiting for your OK.',
              points: res.proposal.findings.slice(0, 10).map((f) => ({ text: f.source ? `${f.text} (${f.source})` : f.text, cites: [] })),
              sources: [],
              open: [],
              confidence: 'medium',
            },
          });
        }
        const d = scheduleProject(projectStore.get(p.id)!, new Date()).proposal?.diff;
        record('inspector', 'project.proposal', `Checked progress on "${p.title}" and has a suggested plan: ${d ? `${d.added.length} new, ${d.changed.length} changed, ${d.removed.length} dropped` : `${res.proposal.milestones.length} steps`}. Waiting for your OK.`, {
          projectId: p.id,
          sessionId: p.inspect.sessionId,
          detail: { tokens: res.tokens, findings: res.proposal.findings.length, applied: false, blocked: countDenied(sessionMsgFile(config.sessionsDir, p.inspect.sessionId), startedAt).denied },
        });
      } else {
        const error = res.error ?? 'Checking progress took too long, so Next stopped waiting.';
        projectStore.setInspect(p.id, { state: 'failed', finishedAt: at, error });
        const fb = researchStore.active({ projectId: p.id });
        if (fb) researchStore.update(fb.id, { state: 'failed', finishedAt: at, error, tokens: res.tokens });
        record('inspector', 'project.inspect_failed', `Checking progress on "${p.title}" didn't produce a plan: ${error}`, {
          projectId: p.id,
          sessionId: p.inspect.sessionId,
          detail: { tokens: res.tokens },
          risk: 'none',
        });
      }
    }
  };

  app.get('/api/next/projects', { preHandler: requireAuth }, async () => {
    pumpResearch();
    settleInspectors();
    return {
      projects: projectViews().map((v) => projectReply(v.id) ?? v),
      control: control.read(),
    };
  });

  app.get('/api/next/projects/:pid', { preHandler: requireAuth }, async (request, reply) => {
    const { pid } = request.params as { pid: string };
    if (!projectIdOk(pid)) return reply.code(400).send({ error: 'bad_id' });
    pumpResearch();
    settleInspectors();
    const v = projectReply(pid);
    return v ?? reply.code(404).send({ error: 'not_found' });
  });

  app.post('/api/next/projects', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>;
    const out = projectStore.create({
      title: String(b.title ?? ''),
      goal: String(b.goal ?? ''),
      deadline: String(b.deadline ?? ''),
      capacity: (b.capacity ?? {}) as Record<string, number>,
      milestones: Array.isArray(b.milestones) ? b.milestones : [],
      space: b.space,
    });
    if ('error' in out) return reply.code(400).send(out);
    record('you', 'project.create', `Created the project "${out.title}", due ${new Date(out.deadlineISO).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`, { projectId: out.id });
    return projectReply(out.id);
  });

  app.patch('/api/next/projects/:pid', { preHandler: requireAuth }, async (request, reply) => {
    const { pid } = request.params as { pid: string };
    if (!projectIdOk(pid)) return reply.code(400).send({ error: 'bad_id' });
    const b = (request.body ?? {}) as Record<string, unknown>;
    const out = projectStore.update(pid, {
      ...(typeof b.title === 'string' ? { title: b.title } : {}),
      ...(typeof b.goal === 'string' ? { goal: b.goal } : {}),
      ...(typeof b.deadline === 'string' ? { deadline: b.deadline } : {}),
      ...(b.capacity && typeof b.capacity === 'object' ? { capacity: b.capacity as Record<string, number> } : {}),
      ...(b.status === 'active' || b.status === 'done' || b.status === 'archived' ? { status: b.status } : {}),
      ...(b.space === 'school' || b.space === 'personal' ? { space: b.space } : {}),
    });
    if (!out) return reply.code(404).send({ error: 'not_found' });
    const changed = Object.keys(b).filter((k) => ['title', 'goal', 'deadline', 'capacity', 'status', 'space'].includes(k)).join(', ');
    record('you', 'project.edit', `Changed ${changed || 'nothing'} on "${out.title}".`, { projectId: pid });
    return projectReply(pid);
  });

  app.post('/api/next/projects/:pid/milestones', { preHandler: requireAuth }, async (request, reply) => {
    const { pid } = request.params as { pid: string };
    if (!projectIdOk(pid)) return reply.code(400).send({ error: 'bad_id' });
    const b = (request.body ?? {}) as Record<string, unknown>;
    const out = projectStore.addMilestone(pid, {
      title: b.title,
      detail: b.detail,
      estMinutes: b.estMinutes,
      dependsOn: b.dependsOn,
      owner: b.owner,
      fixedDueISO: b.fixedDue,
    });
    if (!out) return reply.code(400).send({ error: 'bad_step' });
    record('you', 'project.step_add', `Added a step to "${out.title}": ${String(b.title ?? '').slice(0, 80)}.`, { projectId: pid });
    return projectReply(pid);
  });

  app.patch('/api/next/projects/:pid/milestones/:mid', { preHandler: requireAuth }, async (request, reply) => {
    const { pid, mid } = request.params as { pid: string; mid: string };
    if (!projectIdOk(pid) || !/^[a-z0-9-]{1,50}$/.test(mid)) return reply.code(400).send({ error: 'bad_id' });
    const b = (request.body ?? {}) as Record<string, unknown>;
    const status = b.status === 'todo' || b.status === 'doing' || b.status === 'done' || b.status === 'blocked' ? b.status : undefined;
    const out = projectStore.setMilestone(pid, mid, {
      ...(status ? { status } : {}),
      ...(b.estMinutes !== undefined ? { estMinutes: Number(b.estMinutes) } : {}),
      ...(typeof b.title === 'string' ? { title: b.title } : {}),
    });
    if (!out) return reply.code(404).send({ error: 'not_found' });
    const m = out.milestones.find((x) => x.id === mid);
    record('you', 'project.step_edit', `${status ? `Marked ${status}` : 'Edited'}: ${m?.title ?? mid}.`, { projectId: pid });
    return projectReply(pid);
  });

  app.delete('/api/next/projects/:pid/milestones/:mid', { preHandler: requireAuth }, async (request, reply) => {
    const { pid, mid } = request.params as { pid: string; mid: string };
    if (!projectIdOk(pid) || !/^[a-z0-9-]{1,50}$/.test(mid)) return reply.code(400).send({ error: 'bad_id' });
    const title = projectStore.get(pid)?.milestones.find((m) => m.id === mid)?.title;
    const out = projectStore.removeMilestone(pid, mid);
    if (!out) return reply.code(404).send({ error: 'not_found' });
    record('you', 'project.step_remove', `Removed a step: ${title ?? mid}.`, { projectId: pid });
    return projectReply(pid);
  });

  /**
   * Start the inspector. Same session path as a hand-off (mobile preamble,
   * model pin), in Guard mode with a code-written prompt. One at a time per
   * project, a few per hour, and never while paused.
   */
  app.post('/api/next/projects/:pid/inspect', { preHandler: requireAuth, config: { rateLimit: { max: 4, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { pid } = request.params as { pid: string };
    if (!projectIdOk(pid)) return reply.code(400).send({ error: 'bad_id' });
    settleInspectors();
    const out = queueResearch({ projectId: pid });
    if ('error' in out) return reply.code(out.code).send({ error: out.error });
    return projectReply(pid);
  });

  app.post('/api/next/projects/:pid/proposal/:action', { preHandler: requireAuth }, async (request, reply) => {
    const { pid, action } = request.params as { pid: string; action: string };
    if (!projectIdOk(pid) || (action !== 'apply' && action !== 'discard')) return reply.code(400).send({ error: 'bad_request' });
    const b = (request.body ?? {}) as Record<string, unknown>;
    const p = projectStore.get(pid);
    if (!p?.proposal) return reply.code(404).send({ error: 'no_proposal' });
    if (String(b.proposalId ?? '') !== p.proposal.id) return reply.code(409).send({ error: 'stale_proposal' });
    if (action === 'apply') {
      const before = scheduleProject(p, new Date()).proposal?.diff;
      projectStore.applyProposal(pid, p.proposal.id);
      record('you', 'project.apply', `Approved the new plan for "${p.title}"${before ? `: ${before.added.length} new, ${before.changed.length} changed, ${before.removed.length} dropped` : ''}.`, { projectId: pid, sessionId: p.proposal.sessionId ?? undefined });
    } else {
      projectStore.setProposal(pid, null);
      record('you', 'project.discard', `Dismissed the suggested plan for "${p.title}". Nothing changed.`, { projectId: pid });
    }
    return projectReply(pid);
  });

  // ----------------------------------------------------------------- Tasks
  /** School or Personal for a title he is typing: rules first, Jev only if unclear. */
  const courseNames = (): string[] => {
    try {
      const doc = JSON.parse(fs.readFileSync(schoologyNotesPath(nextRoot), 'utf8')) as { items?: Record<string, { course?: unknown }> };
      return [...new Set(Object.values(doc.items ?? {}).map((v) => tidyCourse(String(v.course ?? ''))).filter(Boolean))].slice(0, 12);
    } catch {
      return [];
    }
  };
  app.post('/api/next/suggest-space', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 hour' } } }, async (request) => {
    const title = typeof (request.body as { title?: unknown })?.title === 'string' ? (request.body as { title: string }).title : '';
    // His own words for each space: project names and tasks he added.
    const mine = [...projectViews().map((v) => ({ space: v.space, title: v.title })), ...taskStore.list().map((t) => ({ space: t.space ?? 'personal', title: t.title }))];
    const ctx = {
      school: mine.filter((m) => m.space === 'school').map((m) => m.title),
      personal: mine.filter((m) => m.space !== 'school').map((m) => m.title),
    };
    return { hint: await suggestSpace(title, courseNames(), jev, ctx) };
  });

  app.post('/api/next/tasks', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>;
    const out = taskStore.add({ title: b.title, due: b.due, estMinutes: b.estMinutes, space: b.space });
    if ('error' in out) return reply.code(400).send(out);
    record('you', 'task.add', `Added to ${out.space === 'school' ? 'School' : 'Personal'}: ${out.title}.`, { itemId: `manual:${out.id}` });
    return livePlan();
  });

  /** Move a task you added between School and Personal. Feed items stay where their source puts them. */
  app.patch('/api/next/tasks/:tid', { preHandler: requireAuth }, async (request, reply) => {
    const { tid } = request.params as { tid: string };
    const b = (request.body ?? {}) as Record<string, unknown>;
    if (!/^[a-f0-9]{8,16}$/.test(tid) || (b.space !== 'school' && b.space !== 'personal')) return reply.code(400).send({ error: 'bad_request' });
    const out = taskStore.setSpace(tid, b.space);
    if (!out) return reply.code(404).send({ error: 'not_found' });
    record('you', 'task.move', `Moved to ${out.space === 'school' ? 'School' : 'Personal'}: ${out.title}.`, { itemId: `manual:${out.id}` });
    return livePlan();
  });

  // ------------------------------------------------- Activity, safety, pause
  app.get('/api/next/activity', { preHandler: requireAuth }, async (request) => {
    const q = request.query as { limit?: string; before?: string; actor?: string };
    const actor = q.actor === 'agents' || ['you', 'sorter', 'drafter', 'planner', 'inspector', 'agent', 'system'].includes(q.actor ?? '')
      ? (q.actor as LedgerActor | 'agents')
      : undefined;
    return ledger.list({
      limit: Math.min(200, Math.max(1, Number(q.limit) || 50)),
      ...(q.before && Number.isFinite(Number(q.before)) ? { beforeSeq: Number(q.before) } : {}),
      ...(actor ? { actor } : {}),
    });
  });

  // ---------------------------------------------------------------- Research
  app.get('/api/next/research', { preHandler: requireAuth }, async () => {
    pumpResearch();
    settleInspectors();
    return { briefs: researchStore.list().filter((b) => b.state !== 'dismissed') };
  });

  app.get('/api/next/research/:rid', { preHandler: requireAuth }, async (request, reply) => {
    const { rid } = request.params as { rid: string };
    if (!/^r-[a-f0-9]{10}$/.test(rid)) return reply.code(400).send({ error: 'bad_id' });
    pumpResearch();
    settleInspectors();
    return researchStore.get(rid) ?? reply.code(404).send({ error: 'not_found' });
  });

  app.post('/api/next/research', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>;
    const out = queueResearch({
      ...(typeof b.itemId === 'string' ? { itemId: b.itemId } : {}),
      ...(typeof b.projectId === 'string' && projectIdOk(b.projectId) ? { projectId: b.projectId } : {}),
      ...(typeof b.question === 'string' ? { question: b.question } : {}),
    });
    if ('error' in out) return reply.code(out.code).send({ error: out.error });
    return out.brief;
  });

  app.post('/api/next/research/:rid/dismiss', { preHandler: requireAuth }, async (request, reply) => {
    const { rid } = request.params as { rid: string };
    if (!/^r-[a-f0-9]{10}$/.test(rid)) return reply.code(400).send({ error: 'bad_id' });
    const b = researchStore.get(rid);
    if (!b) return reply.code(404).send({ error: 'not_found' });
    if (b.state === 'running' && b.sessionId) {
      if (!runner.stop(b.sessionId) && runner.activityOf(b.sessionId)) await runner.stopRemote(b.sessionId).catch(() => false);
    }
    researchStore.update(rid, { state: 'dismissed', finishedAt: b.finishedAt ?? new Date().toISOString() });
    record('you', 'research.dismiss', `Dismissed the brief "${b.title}".`, { itemId: b.itemId ?? undefined });
    return { ok: true };
  });

  app.get('/api/next/safety', { preHandler: requireAuth }, async () => ({
    control: control.read(),
    ledger: ledger.verify(),
    automatic: AUTOMATIC,
    parts: capabilities({ mailModel: mailConfig?.model ?? null, agentModel: nextStartModel(), gateModel: mailConfig?.gate ?? null }),
    standbys: armedPool.status().map((sb) => ({ key: sb.key, ready: sb.ready, readyInMin: sb.readyInMin, limits: describeRules(sb.kind, sb.host) })),
    running: researchStore
      .list()
      .filter((b) => b.state === 'running' || b.state === 'preparing')
      .map((b) => ({ kind: b.kind === 'inspector' ? 'inspector' : 'agent', title: b.title, sessionId: b.sessionId, state: b.state })),
  }));

  /**
   * The pause switch. Pausing stops the mail sort, drafting, new hand-offs,
   * and inspectors at the door, and stops any Next agent that is running
   * right now. Unpausing only reopens the door; nothing restarts on its own.
   */
  app.post('/api/next/pause', { preHandler: requireAuth }, async (request) => {
    const b = (request.body ?? {}) as Record<string, unknown>;
    const paused = b.paused === true;
    const state = control.set(paused, paused ? 'Paused from the phone' : null);
    let stopped = 0;
    if (paused) {
      const ids = [
        ...nextStore.plan(new Date(), []).withAside.map((it) => it.sessionId),
        ...projectStore.list().filter((p) => p.inspect.state === 'running').map((p) => p.inspect.sessionId),
        ...researchStore.list().filter((b) => b.state === 'running').map((b) => b.sessionId),
      ].filter((x): x is string => Boolean(x));
      for (const sid of ids) {
        if (runner.stop(sid)) stopped++;
        else if (runner.activityOf(sid) && (await runner.stopRemote(sid).catch(() => false))) stopped++;
      }
      for (const p of projectStore.list()) if (p.inspect.state === 'running') projectStore.setInspect(p.id, { state: 'failed', error: 'Stopped by pause.', finishedAt: new Date().toISOString() });
      writeWaiting([]);
      for (const b of researchStore.list()) {
        if (b.state === 'running' || b.state === 'preparing') researchStore.update(b.id, { state: 'failed', error: 'Stopped by pause.', finishedAt: new Date().toISOString() });
      }
    }
    record('you', paused ? 'control.pause' : 'control.resume', paused
      ? `Paused Next${stopped ? ` and stopped ${stopped} running` : ''}. No sorting, drafting, or research starts until you resume.`
      : 'Resumed. Research starts again only when you ask; nothing restarted on its own.', { risk: 'none', detail: { stopped } });
    return { control: state, stopped };
  });

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
        return reply.code(500).send({ error: 'pdf_read_failed' });
      }
    },
  );

  const liveView = new LiveView({
    // `tab:<targetId>` watches one tab directly (the Browser sheet);
    // anything else is a chat, followed to whatever tab its agent uses.
    tabs: async (key) =>
      key.startsWith('tab:')
        ? [{ targetId: key.slice(4), sessionId: key, owner: 'session' as const, url: '', at: 0 }]
        : stateDb.agentTabs(key),
    repl: browserRepl,
    logger: { warn: (msg) => app.log.warn(msg) },
  });
  app.addHook('onClose', async () => liveView.close());

  attachWebSocket({
    liveView,
    onClientReady: () => browserRepl.warmUp(),
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
