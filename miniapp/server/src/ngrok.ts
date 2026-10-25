/**
 * Backup public relay: ngrok with a free static domain.
 *
 * When Funnel is unavailable -- Tailscale missing, Funnel disabled in the
 * admin console, tailnet down -- this keeps the phone on plain HTTPS via an
 * ngrok free static domain (`<name>.ngrok-free.dev`, one per free account).
 * It needs two things from the owner, both one-time and both free: an ngrok
 * account's authtoken in `NGROK_AUTHTOKEN`, and the reserved static domain
 * in config (`ngrok_domain`). Without either, the relay stays disabled with
 * a detail saying which is missing; nothing is spawned and nothing phones
 * home.
 *
 * Supervision mirrors `tunnel.ts`: the child is respawned with capped
 * backoff when it dies, and the advertised URL only exists while ngrok's
 * own local API confirms a tunnel with our public URL is up. A process that
 * is running but not serving -- expired token, domain released, account
 * over quota -- therefore degrades to "no URL" within one poll period
 * instead of sending the phone at a dead address.
 *
 * Free-tier realities, stated plainly so nobody is surprised: the static
 * domain serves an interstitial warning page to browser visitors until it
 * is dismissed (the installed app loads through it once and then behaves),
 * and the free tier carries request/bandwidth quotas. This is a backup, not
 * a home: it exists so an outage of the primary is an inconvenience rather
 * than a disconnection.
 *
 * The authtoken is handled like the bot token: read from env or config,
 * passed to the child over its environment, and never written to any log.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { isPublicOrigin, toPublicOrigin, type RelayHandle, type RelayInfo } from './relays.js';

export interface NgrokLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface NgrokOptions {
  /** The app's loopback port -- the ONLY port this relay ever publishes. */
  port: number;
  /** Reserved static domain, e.g. `aside-mac.ngrok-free.dev`. */
  domain: string;
  /** Authtoken. Never logged, never included in any error string. */
  authtoken: string;
  /** ngrok binary. Defaults to `$NGROK_BIN`, then `ngrok` on PATH. */
  ngrokBin?: string;
  /** Local ngrok agent API. Defaults to `http://127.0.0.1:4040`. */
  agentApi?: string;
  logger?: NgrokLogger;
  /**
   * Override child spawning in tests. Must return an object with `on`,
   * `kill`, and `killed` shaped like a ChildProcess.
   */
  spawnChild?: (
    bin: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => Pick<ChildProcess, 'on' | 'kill' | 'killed'>;
  /** Override the agent-API read in tests. Resolves parsed JSON. */
  readAgentApi?: (url: string) => Promise<unknown>;
  /** Steady-state poll period. Production 30s; tests pass something tiny. */
  checkIntervalMs?: number;
  /** How long to wait for the first tunnel after spawn. Default 30s. */
  startupTimeoutMs?: number;
}

const DEFAULT_AGENT_API = 'http://127.0.0.1:4040';
const CHECK_INTERVAL_MS = 30_000;
const STARTUP_TIMEOUT_MS = 30_000;
const RESTART_BASE_DELAY_MS = 2_000;
const RESTART_MAX_DELAY_MS = 60_000;

/** Resolve the binary without spawning anything, so tests stay hermetic. */
export function resolveNgrokBin(explicit?: string): string {
  const fromEnv = String(process.env.NGROK_BIN || '').trim();
  return explicit?.trim() || fromEnv || 'ngrok';
}

/**
 * Arguments for a stable static-domain forward.
 *
 * `--url` pins the public address (without it every restart mints a random
 * one, which would make this relay no better than the quick tunnel it
 * replaces as a backup). Region is left to ngrok's latency routing.
 */
export function ngrokArgs(port: number, domain: string): string[] {
  const bare = domain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  return ['http', `http://127.0.0.1:${port}`, '--url', bare];
}

/** Pull the https public URL out of the agent API's `/api/tunnels`. */
export function publicUrlFromAgentApi(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const tunnels = (payload as { tunnels?: unknown }).tunnels;
  if (!Array.isArray(tunnels)) return null;
  for (const tunnel of tunnels) {
    const url =
      tunnel && typeof tunnel === 'object'
        ? (tunnel as { public_url?: unknown }).public_url
        : null;
    if (typeof url === 'string' && isPublicOrigin(url)) return url;
  }
  return null;
}

async function defaultReadAgentApi(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`ngrok agent API ${res.status}`);
  return (await res.json()) as unknown;
}

export interface NgrokHandle extends RelayHandle {
  readonly kind: 'ngrok';
}

export function disabledNgrok(detail: string): NgrokHandle {
  return {
    kind: 'ngrok',
    snapshot: (): RelayInfo => ({
      kind: 'ngrok',
      url: null,
      healthy: null,
      detail,
    }),
    stop: async (): Promise<void> => {},
  };
}

/**
 * Start supervising the ngrok backup relay. Never throws: every failure --
 * missing binary, bad token, lost domain -- becomes a handle with no URL
 * and a detail saying why.
 */
export async function startNgrok(opts: NgrokOptions): Promise<NgrokHandle> {
  const logger = opts.logger;
  const domain = opts.domain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const publicOrigin = toPublicOrigin(domain);
  if (!publicOrigin) {
    return disabledNgrok(
      'no static domain configured (miniapp.ngrok_domain, e.g. aside-mac.ngrok-free.dev)',
    );
  }
  if (!opts.authtoken.trim()) {
    return disabledNgrok('NGROK_AUTHTOKEN is not set (free at ngrok.com, one-time)');
  }

  const bin = resolveNgrokBin(opts.ngrokBin);
  const agentApi = (opts.agentApi ?? DEFAULT_AGENT_API).replace(/\/+$/, '');
  const spawnChild =
    opts.spawnChild ??
    ((binary: string, args: string[], env: NodeJS.ProcessEnv) =>
      spawn(binary, args, { env, stdio: 'ignore' }));
  const readAgentApi = opts.readAgentApi ?? defaultReadAgentApi;
  const intervalMs = opts.checkIntervalMs ?? CHECK_INTERVAL_MS;
  const startupTimeoutMs = opts.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;

  let child: Pick<ChildProcess, 'on' | 'kill' | 'killed'> | null = null;
  let confirmedUrl: string | null = null;
  let detail: string | null = 'starting';
  let restarts = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const pollAgent = async (): Promise<string | null> => {
    try {
      const payload = await readAgentApi(`${agentApi}/api/tunnels`);
      const observed = publicUrlFromAgentApi(payload);
      // Only our own static domain counts. ngrok picks up stray tunnels
      // from other agents on shared machines; advertising one of those
      // would send the phone at somebody else's forward.
      return observed === publicOrigin ? observed : null;
    } catch {
      return null;
    }
  };

  const scheduleRestart = (delayMs: number): void => {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void boot();
    }, delayMs);
    if (typeof restartTimer.unref === 'function') restartTimer.unref();
  };

  const boot = async (): Promise<void> => {
    if (stopped) return;
    try {
      child = spawnChild(bin, ngrokArgs(opts.port, domain), {
        ...process.env,
        NGROK_AUTHTOKEN: opts.authtoken,
      });
    } catch (err) {
      detail =
        `cannot start ${bin}: ${(err as Error).message}. Install ngrok or set NGROK_BIN.`.slice(
          0,
          180,
        );
      logger?.warn(`[ngrok] ${detail}`);
      restarts += 1;
      scheduleRestart(
        Math.min(RESTART_MAX_DELAY_MS, RESTART_BASE_DELAY_MS * 2 ** Math.min(restarts, 5)),
      );
      return;
    }
    child.on('error', (err: Error) => {
      // Spawn failure (ENOENT and friends) surfaces here, not from spawn().
      if (stopped) return;
      child = null;
      confirmedUrl = null;
      detail =
        `cannot start ${bin}: ${err.message}. Install ngrok or set NGROK_BIN.`.slice(0, 180);
      logger?.warn(`[ngrok] ${detail}`);
      restarts += 1;
      scheduleRestart(
        Math.min(RESTART_MAX_DELAY_MS, RESTART_BASE_DELAY_MS * 2 ** Math.min(restarts, 5)),
      );
    });
    child.on('exit', (code: number | null) => {
      if (stopped) return;
      // A null child means this exit was already accounted for: either we
      // killed it ourselves after the domain never came up, or the error
      // handler just ran for a spawn failure (which also emits exit).
      // Skipping keeps the precise detail and avoids a double backoff step.
      if (!child) return;
      child = null;
      confirmedUrl = null;
      detail = `ngrok exited (code ${code ?? 'unknown'}); restarting`;
      logger?.warn(`[ngrok] ${detail}`);
      restarts += 1;
      scheduleRestart(
        Math.min(RESTART_MAX_DELAY_MS, RESTART_BASE_DELAY_MS * 2 ** Math.min(restarts, 5)),
      );
    });

    // Wait for the agent API to confirm OUR domain, not just any tunnel.
    const startedAt = Date.now();
    while (!stopped && Date.now() - startedAt < startupTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!child || child.killed) return; // exit handler schedules the retry
      const observed = await pollAgent();
      if (observed) {
        // The watchdog can confirm first on the same poll; log once.
        if (!confirmedUrl) {
          logger?.info(`[ngrok] serving ${observed} -> 127.0.0.1:${opts.port}`);
        }
        confirmedUrl = observed;
        detail = null;
        restarts = 0;
        return;
      }
    }
    if (stopped || confirmedUrl) return;
    if (child && !child.killed) {
      // Running but never confirmed our domain: token rejected, domain
      // released, or quota exhausted. Kill it and back off rather than
      // leaving a process that burns quota while serving nothing.
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone; the exit handler skips nulled children, so the
        // bookkeeping below runs exactly once either way.
      }
      child = null;
      confirmedUrl = null;
      detail =
        'ngrok is running but our static domain never came up (authtoken rejected, domain released, or free quota exhausted?)';
      logger?.warn(`[ngrok] ${detail}`);
      restarts += 1;
      scheduleRestart(
        Math.min(RESTART_MAX_DELAY_MS, RESTART_BASE_DELAY_MS * 2 ** Math.min(restarts, 5)),
      );
    }
  };

  // Steady-state watchdog: the agent API is the source of truth, not the
  // process table. A live process whose tunnel vanished reads as down.
  const timer = setInterval(() => {
    void (async () => {
      if (stopped || !child || child.killed) return;
      const observed = await pollAgent();
      if (observed) {
        if (!confirmedUrl) {
          logger?.info(`[ngrok] serving ${observed} -> 127.0.0.1:${opts.port}`);
        }
        confirmedUrl = observed;
        detail = null;
        restarts = 0;
      } else if (confirmedUrl) {
        confirmedUrl = null;
        detail = 'tunnel dropped from the ngrok agent; waiting for it to return';
        logger?.warn(`[ngrok] ${detail}`);
      }
    })();
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  // Boot synchronously so `waitForUrl` sees a confirmed URL quickly when
  // ngrok is healthy, and a clear detail when it is not.
  await boot();

  return {
    kind: 'ngrok',
    snapshot: (): RelayInfo => ({
      kind: 'ngrok',
      url: confirmedUrl,
      healthy: confirmedUrl ? true : null,
      detail,
    }),
    stop: async (): Promise<void> => {
      stopped = true;
      clearInterval(timer);
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      const proc = child;
      child = null;
      confirmedUrl = null;
      if (proc && !proc.killed) {
        try {
          proc.kill('SIGTERM');
        } catch {
          // Already gone; shutdown must not fail over it.
        }
      }
    },
  };
}
