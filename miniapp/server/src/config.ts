/**
 * Runtime configuration for the Aside Mini App server.
 *
 * The bridge's own config.json is the source of truth (bot token, the
 * single allowlisted Telegram user id, model/effort defaults). We only
 * ever read it -- the live Python bridge owns writing it.
 *
 * The bot token is used for exactly one thing: computing the HMAC secret
 * key for Telegram initData validation. It never leaves this process and
 * is never logged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Every effort level Aside itself names, in its own order.
 */
export const EFFORT_LABELS: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultrabrowse: 'Ultrabrowse',
};

/**
 * What `aside exec --effort` accepts. CLI 1.26.902 added `max` to the
 * documented choices, so the phone can finally offer the same top level
 * the desktop already showed instead of hiding it as unsendable.
 */
export const EFFORT_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultrabrowse',
] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * The Reasoning popover, in Aside's order. Off and Minimal are accepted by
 * the API but are not in Aside's own menu for these models, so they are
 * not offered here either.
 */
export const EFFORT_MENU: EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultrabrowse',
];

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] || effort;
}

/**
 * Where the Aside CLI lives, when the config does not say.
 *
 * macOS ships it inside an `.app` bundle; everywhere else it is a plain
 * executable that the installer puts on PATH. Hardcoding the macOS bundle
 * path meant a Linux user who cloned this repo got `ENOENT` on every
 * single spawn -- exec, repl and facade alike -- with nothing pointing at
 * the cause.
 */
export function defaultAsideCliPath(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'darwin'
    ? '~/.aside/cli/Aside CLI.app/Contents/MacOS/aside'
    : 'aside';
}

const DEFAULT_MODEL_ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-5',
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
};

/** The `miniapp` section of the bridge config. All of it is optional. */
export interface MiniappSection {
  /**
   * `"cloudflared"` manages a public HTTPS tunnel; `"none"` stays local;
   * `"external"` means something outside this process (e.g. Tailscale
   * Funnel, running under its own daemon) already publishes a FIXED
   * public hostname at `tunnel_hostname`. In external mode nothing is
   * spawned or supervised here -- the hostname cannot rotate, so the
   * only job left is keeping the Telegram menu button pointed at it.
   */
  tunnel: 'cloudflared' | 'none' | 'external';
  /**
   * Register the Telegram menu button at the tunnel URL.
   *
   * OFF by default and deliberately so: the bot is live in production, and
   * flipping this is the owner's call, not the installer's.
   */
  autoRegisterMenu: boolean;
  port: number;
  /** Where cloudflared and the runtime state live -- never in the repo. */
  stateDir: string;
  /**
   * A cloudflared the user installed themselves. Set it and nothing is
   * downloaded -- which is the documented way past a checksum failure
   * (audit M-6), rather than a flag that turns the check off.
   */
  cloudflaredPath: string;
  /**
   * Named tunnel: `cloudflared tunnel run <tunnelName>` with the
   * cloudflared_config file. Empty means the quick tunnel, whose hostname
   * rotates on every restart.
   */
  tunnelName: string;
  /**
   * Fixed public hostname of the named tunnel, e.g. `miniapp.example.com`
   * (scheme and trailing slash tolerated, normalized away). Empty means
   * the quick tunnel.
   */
  tunnelHostname: string;
  /** cloudflared YAML config (ingress rules + credentials) for the named tunnel. */
  cloudflaredConfig: string;
  logPath: string;
  /** Cap on the log file before it is rotated to `<name>.1`. */
  logMaxBytes: number;
  /**
   * `<bot_username>/<mini_app_short_name>`, exactly as registered in
   * BotFather, e.g. `"asidebot/app"`. Used to build
   * `t.me/<value>?startapp=session_<id>` deep links on push notifications
   * (Day 2 plan, 6.5). `null` when unset -- notifications simply omit the
   * link rather than guessing at an unconfigured bot/app name, which would
   * produce a dead link.
   */
  deepLinkBase: string | null;
  /**
   * Owner's first name, for the standalone greeting.
   *
   * Telegram hands this over on every launch. A paired home-screen app has
   * no such source, so it is configured once rather than guessed.
   */
  ownerName: string;
}

export interface MiniappConfig {
  /** Telegram bot token. HMAC key material only -- never logged, never sent. */
  botToken: string;
  /**
   * No Telegram at all: no bot token, so no initData auth and no pushes.
   * The installed app pairs from the loopback pairing page instead. This
   * is the default for a fresh clone.
   */
  standalone: boolean;
  /**
   * The only user id allowed to use this server. A Telegram user id when
   * one is configured, `STANDALONE_OWNER_ID` otherwise.
   */
  allowedUserId: number;
  defaultModel: string;
  defaultEffort: EffortLevel;
  modelAliases: Record<string, string>;
  sessionsDir: string;
  asideCli: string;
  credentialsPath: string;
  /** Daemon SQLite db, read-only, for per-session permission mode + model. */
  stateDbPath: string;
  /**
   * Where bridge.py saves photos and documents that arrive over Telegram.
   * Read-only here, and one of the three roots the local-image route will
   * serve from -- an answer that references a photo the owner texted in is
   * referencing a path under this directory.
   */
  mediaDir: string;
  /** Optional `models` section merged over the built-in provider catalog. */
  modelCatalogOverrides: Record<string, unknown>;
  execTimeoutMs: number;
  port: number;
  /** Where the HS256 signing secret is persisted (chmod 600, outside the repo). */
  secretPath: string;
  /** whisper.cpp GGML model used for on-device speech-to-text. */
  whisperModelPath: string;
  /** Spoken language hint, or 'auto'. Pinning it is faster and more accurate. */
  whisperLanguage: string;
  miniapp: MiniappSection;
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * A tunnel hostname as configured, reduced to bare `host.example.com`
 * form: scheme and trailing slash tolerated, lowercased. Empty input
 * stays empty, which is what keeps the quick-tunnel path unchanged.
 */
function normalizeTunnelHostname(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * The Aside account directory this machine is actually signed in to.
 *
 * Every path in this project used to be hardcoded to `~/.aside/u/0`, which
 * is only right for someone whose first account is still their current
 * one. Aside numbers accounts and records the active one in
 * `~/.aside/accounts.json` as `currentAccountId`; a user on their second
 * account has all of their sessions, models and credentials under
 * `~/.aside/u/1`, so a hardcoded `u/0` pointed the whole app at an empty
 * or stale account with no error to explain why the session list was
 * blank.
 *
 * Falls back to `u/0` when the file is missing or unreadable, which is
 * both the old behaviour and the correct answer for a single-account
 * install.
 */
/**
 * Owner id used when there is no Telegram account to borrow one from.
 *
 * Any stable non-zero number works; `chat_id` is validated as non-zero, so
 * this can never collide with a configured Telegram id.
 */
export const STANDALONE_OWNER_ID = 1;

/** Where a Telegram-less install keeps its secret, state and media. */
export function defaultStandaloneStateDir(home = os.homedir()): string {
  const override = process.env.MINIAPP_STATE_DIR;
  if (override) return expandHome(override);
  return path.join(home, '.aside-mobile');
}

export function defaultAsideRoot(home = os.homedir()): string {
  const override = process.env.MINIAPP_ASIDE_ROOT;
  if (override) return expandHome(override);
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(home, '.aside/accounts.json'), 'utf8'),
    ) as { currentAccountId?: unknown };
    const id = Number(raw.currentAccountId);
    if (Number.isInteger(id) && id >= 0) {
      return path.join(home, '.aside/u', String(id));
    }
  } catch {
    // No accounts file (fresh install, or a layout we do not know):
    // u/0 is the only sensible guess.
  }
  return path.join(home, '.aside/u/0');
}

/**
 * Where the bridge's config.json might live, best candidate first.
 *
 * `setup.py` writes it into the repo checkout, so that is where a wizard
 * install actually keeps it. `~/.aside/u/0/telegram-bridge/config.json`
 * was the documented location and is still searched, so an install that
 * put it there keeps working. Both are tried because someone running
 * `npm start` by hand should not have to know which layout they got.
 *
 * `MINIAPP_CONFIG` overrides everything: the launchd plist sets it, and
 * so do the tests.
 */
export function configCandidates(): string[] {
  const explicit = process.env.MINIAPP_CONFIG;
  if (explicit) return [expandHome(explicit)];
  // src/config.ts and dist/config.js are both three levels below the
  // repo root (miniapp/server/{src,dist}), so this resolves either way.
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..',
  );
  return [
    path.join(repoRoot, 'config.json'),
    path.join(defaultAsideRoot(), 'telegram-bridge/config.json'),
  ];
}

function configPath(): string {
  const candidates = configCandidates();
  return candidates.find((candidate) => fs.existsSync(candidate))
    ?? candidates[0];
}

function asEffort(value: unknown, fallback: EffortLevel): EffortLevel {
  return EFFORT_LEVELS.includes(value as EffortLevel)
    ? (value as EffortLevel)
    : fallback;
}

export function loadConfig(): MiniappConfig {
  const file = configPath();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /*
     * No config file. That used to be fatal, which made the whole repo
     * unusable for its own headline case: someone who wants the phone app
     * and has never run the Telegram bridge. Telegram is one way in, not
     * the product. Missing config means standalone mode -- pair from the
     * loopback pairing page and everything works.
     */
    raw = {};
  }

  const botToken = String(raw.token || '');

  /*
   * Standalone: no bot token, so there is no Telegram identity to trust.
   *
   * This is a security boundary, not a convenience flag. `validateInitData`
   * HMACs with the bot token as the key, so an EMPTY token means the key is
   * public knowledge and anyone could forge a launch that mints a session.
   * `/api/auth` is therefore refused outright in this mode (see app.ts) and
   * pairing is the only bootstrap.
   */
  const standalone = !botToken;

  const configuredUserId = Number(raw.chat_id);
  const hasUserId = Number.isFinite(configuredUserId) && configuredUserId !== 0;
  if (!standalone && !hasUserId) {
    throw new Error(
      `config ${file} has a "token" but no usable numeric "chat_id". ` +
        'Both are needed for Telegram mode; remove the token for standalone.',
    );
  }
  /*
   * A stable synthetic owner id in standalone mode. Every token this server
   * mints carries it and every check compares against it, so the identity
   * spine is unchanged -- it simply is not a Telegram user id.
   */
  const allowedUserId = hasUserId ? configuredUserId : STANDALONE_OWNER_ID;

  const sessionsDir = expandHome(
    process.env.MINIAPP_SESSIONS_DIR ||
      String(raw.sessions_dir || path.join(defaultAsideRoot(), 'sessions')),
  );
  const asideCli = expandHome(
    process.env.MINIAPP_ASIDE_CLI ||
      String(raw.aside_cli || defaultAsideCliPath()),
  );
  const secretPath = expandHome(
    process.env.MINIAPP_SECRET_PATH ||
      path.join(
        fs.existsSync(file) ? path.dirname(file) : defaultStandaloneStateDir(),
        'miniapp-secret.json',
      ),
  );
  const credentialsPath = expandHome(
    process.env.MINIAPP_CREDENTIALS ||
      String(
        raw.credentials_path ||
          path.join(defaultAsideRoot(), 'credentials.json'),
      ),
  );
  const stateDbPath = expandHome(
    process.env.MINIAPP_STATE_DB ||
      String(raw.state_db_path || path.join(defaultAsideRoot(), 'state.db')),
  );

  // bridge.py writes media next to its own config, which is also where
  // this app's state lives.
  const mediaDir = expandHome(
    process.env.MINIAPP_MEDIA_DIR ||
      String(
        raw.media_dir ||
          path.join(
            fs.existsSync(file)
              ? path.dirname(file)
              : defaultStandaloneStateDir(),
            'media',
          ),
      ),
  );

  const section = (raw.miniapp as Record<string, unknown>) || {};
  /*
   * State lives next to the config that describes it. With no config there
   * is nothing to sit next to, so standalone gets its own directory rather
   * than borrowing the Telegram bridge's -- a machine can run both.
   */
  const stateDir = expandHome(
    String(
      section.state_dir ||
        (standalone ? defaultStandaloneStateDir() : path.dirname(file)),
    ),
  );
  const port = Number(
    process.env.MINIAPP_PORT || section.port || 8790,
  );

  /**
   * Env kill-switches for the two side-effecting features.
   *
   * These exist because both are process-global in effect but per-process
   * in configuration: `setChatMenuButton` has no notion of "which server",
   * so a SECOND instance started from the same config -- a dev run, a test
   * server on another port -- silently repoints the owner's live Mini App
   * at its own throwaway tunnel and breaks it for everyone. That is a
   * genuine foot-gun rather than a hypothetical one; it happened.
   *
   * `MINIAPP_TUNNEL=none` and `MINIAPP_AUTO_REGISTER_MENU=0` let a second
   * instance opt out without editing (or copying) the real config, which
   * carries the bot token.
   */
  const tunnelOverride = process.env.MINIAPP_TUNNEL;
  const requested = tunnelOverride || section.tunnel;
  /*
   * `external` is only honoured with a hostname to point at. Without one
   * there is nothing to register, and silently falling back to a quick
   * tunnel would resurrect the rotating-URL bug this mode exists to kill,
   * so it degrades to `none` instead.
   */
  const externalHost = normalizeTunnelHostname(
    String(process.env.MINIAPP_TUNNEL_HOSTNAME || section.tunnel_hostname || ''),
  );
  const tunnelMode: 'cloudflared' | 'none' | 'external' =
    requested === 'external'
      ? externalHost
        ? 'external'
        : 'none'
      : requested === 'cloudflared'
        ? 'cloudflared'
        : 'none';
  const menuOverride = process.env.MINIAPP_AUTO_REGISTER_MENU;

  const miniapp: MiniappSection = {
    tunnel: tunnelMode,
    // Never defaulted on, and always off when the env says so. See
    // MiniappSection.
    autoRegisterMenu:
      menuOverride === '0'
        ? false
        : menuOverride === '1' || section.auto_register_menu === true,
    port,
    stateDir,
    cloudflaredPath: expandHome(
      String(process.env.MINIAPP_CLOUDFLARED_PATH ||
        section.cloudflared_path || ''),
    ),
    tunnelName: String(
      process.env.MINIAPP_TUNNEL_NAME || section.tunnel_name || '',
    ).trim(),
    tunnelHostname: normalizeTunnelHostname(
      String(
        process.env.MINIAPP_TUNNEL_HOSTNAME || section.tunnel_hostname || '',
      ),
    ),
    cloudflaredConfig: expandHome(
      String(
        process.env.MINIAPP_CLOUDFLARED_CONFIG ||
          section.cloudflared_config || '',
      ),
    ),
    logPath: expandHome(
      String(section.log_path || path.join(stateDir, 'miniapp.log')),
    ),
    logMaxBytes: Number(section.log_max_bytes || 5 * 1024 * 1024),
    deepLinkBase:
      String(process.env.MINIAPP_DEEPLINK || section.deep_link_base || '') ||
      null,
    /*
     * Empty rather than a name. The greeting omits it when unset, which is
     * correct for a stranger's install; a default here greeted everyone as
     * the original author.
     */
    ownerName: String(section.owner_name || ''),
  };

  return {
    botToken,
    standalone,
    allowedUserId,
    /**
     * No fallback model id on purpose.
     *
     * This used to default to `claude-sonnet-5`, which is only correct for
     * someone who happens to have Claude connected. For anyone else the
     * first turn of a fresh install was spent on a model their account
     * cannot run. Empty means "say nothing", and `-m` is then omitted
     * entirely so the CLI applies the account's own default -- which is
     * the answer the desktop app would have given anyway.
     */
    defaultModel: String(raw.default_model || ''),
    defaultEffort: asEffort(raw.default_effort, 'high'),
    modelAliases: (raw.model_aliases as Record<string, string>) ||
      DEFAULT_MODEL_ALIASES,
    sessionsDir,
    asideCli,
    credentialsPath,
    stateDbPath,
    mediaDir,
    modelCatalogOverrides: (raw.models as Record<string, unknown>) || {},
    execTimeoutMs: Number(raw.exec_timeout_seconds || 1200) * 1000,
    port,
    secretPath,
    /*
     * `small` quantised to q5_0, not `large-v3-turbo`.
     *
     * Measured on this M1 against two dictated clips, both decoded by a
     * warm resident server so only the model differs:
     *
     *                 5.0s clip   9.7s clip
     *   turbo-q5        2191ms      2248ms
     *   small-q5         532ms       648ms
     *
     * Four times faster -- and MORE accurate on the harder sample, not
     * less. Turbo returned "AP Physiccy" and "Buried at ASU" where small
     * returned "AP Physics C" and "Krishnamurthy" correctly; turbo's
     * cut-down decoder is weakest on exactly the proper nouns and acronyms
     * a dictated message to this app is full of. So this is not a speed
     * for accuracy trade, it is better on both axes for this workload.
     *
     * Still overridable, and the old model is left on disk, so switching
     * back is one config key.
     */
    whisperModelPath: expandHome(
      String(
        process.env.MINIAPP_WHISPER_MODEL ||
          raw.whisper_model ||
          path.join(stateDir, 'models', 'ggml-small-q5_0.bin'),
      ),
    ),
    whisperLanguage: String(raw.whisper_language || 'en'),
    miniapp,
  };
}

/**
 * Load (or first-run generate) the 32-byte HS256 secret used to sign
 * session JWTs. Lives next to the bridge config, chmod 600, never in
 * the repo.
 */
export function loadOrCreateJwtSecret(secretPath: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(secretPath, 'utf8')) as {
      secret?: string;
    };
    if (parsed.secret && parsed.secret.length >= 32) return parsed.secret;
  } catch {
    // fall through to generation
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(
    secretPath,
    JSON.stringify({ secret, createdAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
  fs.chmodSync(secretPath, 0o600);
  return secret;
}
