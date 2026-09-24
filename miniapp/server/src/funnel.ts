/**
 * Primary public relay: `tailscale funnel`, Mac-side only.
 *
 * Funnel serves the app's loopback port on the Mac's existing MagicDNS name
 * at port 443 -- `https://mac.tailnet.ts.net` with no port and no path --
 * so the phone reaches the server as an ordinary HTTPS origin and needs no
 * Tailscale software of its own. The URL is stable for the life of the
 * tailnet: nothing rotates, nothing expires.
 *
 * Supervision, not fire-and-forget. Tailscale's serve config can be reset
 * by another `serve` invocation, a Tailscale update, or the user poking at
 * the admin console, any of which silently unpublishes the relay while this
 * process keeps running. So this module reads the status back on a timer
 * and re-applies only when its own port is missing -- never blindly, and
 * never by resetting anything, because a blanket `serve reset` would wipe
 * serve endpoints the owner configured for other things.
 *
 * The status document is only half the verification, and the incident that
 * proved it had Funnel ON in `serve status` while the public path was
 * dead: TCP to the edge connected, then the TLS handshake stalled with
 * zero bytes, and no phone request ever reached the server log. So a
 * config that reads back fine is advertised only after a real request
 * walks the phone's path -- public DNS, TCP, TLS with SNI, `/api/health`
 * -- and reads the health marker back (see `publicprobe.ts`). When that
 * probe fails the relay reports no URL with a stage-named detail, the
 * pairing page warns instead of printing a QR that cannot work, and the
 * phone falls through to the next relay or the tailnet link.
 *
 * Everything here degrades to "no URL" rather than throwing: a Mac without
 * Tailscale, a tailnet whose admin never enabled Funnel, or a CLI that
 * speaks an older status dialect all produce a handle whose `url()` is null
 * and whose `detail()` says why, which is exactly the signal the registry
 * needs to fall through to the next relay.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tailnetHost } from './tailnet.js';
import { verifyPublicEndpoint, type PublicProbeResult } from './publicprobe.js';
import {
  toPublicOrigin,
  type RelayHandle,
  type RelayInfo,
} from './relays.js';

export interface FunnelLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface FunnelOptions {
  /** The app's loopback port -- the ONLY port this relay ever publishes. */
  port: number;
  /**
   * Explicit tailscale binary. Defaults to the same search the tailnet
   * discovery uses: `$TAILSCALE_CLI`, the macOS app bundle, then Homebrew.
   */
  tailscaleCli?: string;
  /** Override the MagicDNS lookup in tests. */
  readTailnetHost?: () => string | null;
  /**
   * Override process execution in tests. Resolves stdout on success,
   * rejects with an Error carrying `stderr` on failure.
   */
  exec?: (binary: string, args: string[]) => Promise<string>;
  logger?: FunnelLogger;
  /** Watchdog period. Production 30s; tests pass something tiny. */
  checkIntervalMs?: number;
  /**
   * Override the end-to-end public-HTTPS probe in tests. Production walks
   * the phone's path to the advertised origin; tests inject a verdict.
   */
  verifyEndpoint?: (origin: string) => Promise<PublicProbeResult>;
  /**
   * Set false to use ONLY `tailscaleCli`, with no auto-discovered binaries
   * or daemon sockets. Tests use this so the Tailscale install on the
   * machine running them cannot change what they observe.
   */
  hostDiscovery?: boolean;
}

interface CliAttempt {
  binary: string;
  socketArgs: string[];
}

const CHECK_INTERVAL_MS = 30_000;
const EXEC_TIMEOUT_MS = 15_000;
/** Backoff ceiling for re-applying after repeated failures. */
const REAPPLY_MAX_DELAY_MS = 5 * 60_000;
/**
 * Failed end-to-end probes before a config that reads back fine gets a
 * fresh `funnel --bg` anyway. Edge registrations occasionally go stale
 * while the local config looks perfect; a re-apply is the only client-side
 * repair, and at this threshold it fires minutes apart at most.
 */
const PROBE_FAILURES_BEFORE_REAPPLY = 3;

function candidateBinaries(explicit?: string): string[] {
  const candidates = [
    explicit,
    process.env.TAILSCALE_CLI,
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ].filter(
    (candidate): candidate is string =>
      Boolean(candidate && fs.existsSync(candidate)),
  );
  return [...new Set(candidates)];
}

function candidateSockets(): string[] {
  return [
    path.join(os.homedir(), '.aside-mobile/tailscale/ts.sock'),
    // Compatibility only for machines that still run the original bridge.
    path.join(os.homedir(), '.aside-telegram-bridge/tailscale/ts.sock'),
  ].filter((candidate) => fs.existsSync(candidate));
}

/**
 * Every local CLI/socket combination that could speak to a tailscaled.
 *
 * Exported so the ngrok-free backup story and the doctor script can share
 * the "which daemon answers?" answer instead of each guessing differently.
 */
export function tailscaleAttempts(explicit?: string): CliAttempt[] {
  const attempts: CliAttempt[] = [];
  for (const binary of candidateBinaries(explicit)) {
    for (const socket of candidateSockets()) {
      attempts.push({ binary, socketArgs: ['--socket', socket] });
    }
    attempts.push({ binary, socketArgs: [] });
  }
  return attempts;
}

function defaultExec(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const failure = new Error(
            `tailscale ${args.join(' ')} failed: ${String(stderr || err.message).trim().split('\n')[0]}`,
          );
          (failure as Error & { stderr?: string }).stderr = String(stderr || '');
          reject(failure);
          return;
        }
        resolve(String(stdout || ''));
      },
    );
  });
}

/**
 * True when the `serve status --json` document already funnels our port.
 *
 * Shape (stable across recent CLIs, but parsed leniently because it is
 * still a human-facing status document, not an API contract):
 *
 *   { "Web": { "<host>:443": { "Handlers": { "/": { "Proxy":
 *     "http://127.0.0.1:8790" }}}}, "AllowFunnel": { "<host>:443": true } }
 *
 * Both halves matter: a proxy entry without AllowFunnel is `serve`, which
 * answers only the tailnet, and AllowFunnel without our proxy entry is
 * somebody else's endpoint. Either half missing means re-apply.
 */
export function funnelServesPort(statusJson: unknown, port: number): boolean {
  if (!statusJson || typeof statusJson !== 'object') return false;
  const doc = statusJson as {
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>;
    AllowFunnel?: Record<string, unknown>;
  };
  const funnelOn = doc.AllowFunnel && Object.keys(doc.AllowFunnel).length > 0;
  if (!funnelOn || !doc.Web || typeof doc.Web !== 'object') return false;
  const want = `:${port}`;
  for (const site of Object.values(doc.Web)) {
    const handlers = site?.Handlers;
    if (!handlers || typeof handlers !== 'object') continue;
    for (const handler of Object.values(handlers)) {
      const proxy = handler && typeof handler === 'object' ? handler.Proxy : null;
      if (typeof proxy === 'string' && proxy.endsWith(want)) return true;
    }
  }
  return false;
}

/**
 * Arguments that publish the loopback app port WITHOUT resetting the rest
 * of the serve config.
 *
 * `--bg` persists the config in tailscaled (without it the endpoint dies
 * with the command); the explicit `http://127.0.0.1:<port>` target keeps the
 * relay on loopback even on machines where `localhost` resolves oddly.
 */
export function funnelApplyArgs(port: number): string[] {
  return ['funnel', '--bg', `http://127.0.0.1:${port}`];
}

function funnelNotEnabled(stderr: string): boolean {
  return /funnel/i.test(stderr) && /not enabled|enable.+admin|no-funnel/i.test(stderr);
}

/**
 * Name the macOS variant problem directly when it applies.
 *
 * Funnel port-sharing on macOS requires the App Store app or the
 * Standalone system extension. A Mac with neither -- typically a Homebrew
 * CLI driving a userspace daemon -- accepts `funnel --bg` and reports
 * Funnel on, while public TLS never completes. "Not answering (tls ...)"
 * alone would send the owner chasing certificates, so the detail says
 * which requirement the Mac fails.
 *
 * Pure for tests: production passes `process.platform` and the bundle path.
 */
export function funnelPlatformNote(platform: string, appBundlePresent: boolean): string | null {
  if (platform !== 'darwin' || appBundlePresent) return null;
  return 'this Mac has no Tailscale.app (Homebrew/userspace daemon), and Funnel port-sharing on macOS requires the App Store or Standalone app';
}

/**
 * The user-facing sentence for "configured but not answering".
 *
 * Names the stage so the owner can tell a TLS stall (this Mac's likely
 * shape) from a DNS wait or a wrong-server answer, and appends the macOS
 * variant note when this Mac fails that requirement -- the most probable
 * root cause on a Homebrew/userspace install, stated rather than guessed.
 */
function funnelDownDetail(
  origin: string,
  probe: Extract<PublicProbeResult, { ok: false }>,
): string {
  const base =
    `Funnel is configured but ${origin} is not answering ` +
    `(${probe.stage}: ${probe.detail})`;
  const note = funnelPlatformNote(
    process.platform,
    fs.existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale'),
  );
  return note ? `${base}; ${note}` : base;
}

export interface FunnelHandle extends RelayHandle {
  readonly kind: 'funnel';
}

export function disabledFunnel(detail: string): FunnelHandle {
  return {
    kind: 'funnel',
    snapshot: (): RelayInfo => ({
      kind: 'funnel',
      url: null,
      healthy: null,
      detail,
    }),
    stop: async (): Promise<void> => {},
  };
}

/**
 * Start supervising the Funnel relay. Never throws and never leaves a
 * half-configured endpoint behind: the only tailscale invocation that
 * mutates anything runs after a read-back proved our port is missing.
 */
export async function startFunnel(opts: FunnelOptions): Promise<FunnelHandle> {
  const logger = opts.logger;
  const exec = opts.exec ?? defaultExec;
  const readDns = opts.readTailnetHost ?? tailnetHost;
  const intervalMs = opts.checkIntervalMs ?? CHECK_INTERVAL_MS;

  const attempts = opts.hostDiscovery === false
    ? (opts.tailscaleCli && fs.existsSync(opts.tailscaleCli)
        ? [{ binary: opts.tailscaleCli, socketArgs: [] }]
        : [])
    : tailscaleAttempts(opts.tailscaleCli);
  if (attempts.length === 0) {
    return disabledFunnel(
      'Tailscale CLI not found (TAILSCALE_CLI, the macOS app, or Homebrew)',
    );
  }
  const verify = opts.verifyEndpoint ?? verifyPublicEndpoint;

  // The combination that answered, pinned after the first success so every
  // later check and re-apply talks to the same daemon.
  let cli: CliAttempt | null = null;
  let serving = false;
  /**
   * The serve config names our port but the public URL does not answer.
   * Distinct from "disabled" (healthy null): this is "broken" (healthy
   * false), the state the pairing page must warn about.
   */
  let configuredDown = false;
  let probeFailures = 0;
  let detail: string | null = 'starting';
  let consecutiveFailures = 0;
  let nextApplyAt = 0;
  let stopped = false;

  const runCli = async (args: string[]): Promise<string> => {
    if (cli) return exec(cli.binary, [...cli.socketArgs, ...args]);
    let lastError: unknown = null;
    for (const attempt of attempts) {
      try {
        const out = await exec(attempt.binary, [...attempt.socketArgs, ...args]);
        cli = attempt;
        return out;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('tailscale CLI failed');
  };

  const check = async (): Promise<void> => {
    if (stopped) return;
    const dns = readDns();
    if (!dns) {
      serving = false;
      detail = 'tailnet not connected (no MagicDNS name yet)';
      return;
    }
    let statusRaw: string;
    try {
      statusRaw = await runCli(['serve', 'status', '--json']);
    } catch (err) {
      serving = false;
      detail = `tailscale status unreadable: ${(err as Error).message}`.slice(0, 160);
      return;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(statusRaw);
    } catch {
      serving = false;
      detail = 'tailscale status was not JSON';
      return;
    }
    /**
     * Advertise the origin only after the public path proves itself.
     * Returns the probe verdict so the caller can decide about re-applying.
     */
    const verifyAndRecord = async (dnsName: string): Promise<PublicProbeResult | null> => {
      const origin = toPublicOrigin(dnsName);
      if (!origin) {
        serving = false;
        configuredDown = true;
        detail = `tailnet name ${dnsName} is not a usable public origin`;
        return null;
      }
      let probe: PublicProbeResult;
      try {
        probe = await verify(origin);
      } catch (err) {
        probe = {
          ok: false,
          stage: 'http',
          detail: `endpoint probe failed: ${String((err as Error).message || err).slice(0, 120)}`,
          viaIp: null,
        };
      }
      if (probe.ok) {
        if (!serving) {
          logger?.info(
            `[funnel] serving ${origin} -> 127.0.0.1:${opts.port} (verified end-to-end${probe.publicPath ? '' : '; tested over the tailnet path only'})`,
          );
        }
        serving = true;
        configuredDown = false;
        probeFailures = 0;
        consecutiveFailures = 0;
        detail = null;
        return probe;
      }
      probeFailures += 1;
      serving = false;
      configuredDown = true;
      detail = funnelDownDetail(origin, probe);
      return probe;
    };

    if (funnelServesPort(parsed, opts.port)) {
      const probe = await verifyAndRecord(dns);
      // The config reads back fine but the URL does not answer: the edge
      // registration may be stale, which a fresh apply sometimes repairs.
      // Gated on repeated failures plus the re-apply backoff, and never
      // for DNS -- re-registering cannot hurry propagation, and churning
      // enables risks the Let's Encrypt rate limit.
      if (
        probe &&
        !probe.ok &&
        probeFailures >= PROBE_FAILURES_BEFORE_REAPPLY &&
        probe.stage !== 'dns' &&
        Date.now() >= nextApplyAt
      ) {
        nextApplyAt = Date.now() + REAPPLY_MAX_DELAY_MS;
        probeFailures = 0;
        try {
          await runCli(funnelApplyArgs(opts.port));
          logger?.info(
            `[funnel] re-applied after repeated failed probes (${probe.stage}: ${probe.detail})`,
          );
        } catch (err) {
          logger?.warn(`[funnel] re-apply failed: ${(err as Error).message}`);
        }
      }
      return;
    }
    // Our port is missing from a config that is otherwise readable: apply,
    // subject to backoff so a persistent failure (Funnel disabled in the
    // admin console) checks quietly instead of hammering the CLI.
    const now = Date.now();
    if (now < nextApplyAt) {
      serving = false;
      return;
    }
    try {
      await runCli(funnelApplyArgs(opts.port));
      consecutiveFailures = 0;
      nextApplyAt = 0;
      logger?.info(`[funnel] enabled https://${dns} -> 127.0.0.1:${opts.port}`);
      // A fresh registration can take minutes to become dialable (public
      // DNS, edge state). Advertise only after the probe passes; until
      // then the watchdog re-checks every interval with an honest detail.
      await verifyAndRecord(dns);
    } catch (err) {
      consecutiveFailures += 1;
      const wait = Math.min(
        REAPPLY_MAX_DELAY_MS,
        intervalMs * 2 ** Math.min(consecutiveFailures, 4),
      );
      nextApplyAt = now + wait;
      serving = false;
      const stderr = String((err as Error & { stderr?: string }).stderr || '');
      detail = funnelNotEnabled(stderr)
        ? 'Funnel is not enabled for this tailnet (Tailscale admin console -> Settings -> Funnel: On)'
        : `tailscale funnel failed: ${(err as Error).message}`.slice(0, 160);
      logger?.warn(`[funnel] ${detail} (retrying in ${Math.round(wait / 1000)}s)`);
    }
  };

  /*
   * Boot waits briefly for the tailnet cache: `primeTailnetHost()` resolves
   * asynchronously, so the first check would otherwise always conclude the
   * tailnet is down and the relay would sit unverified for a full watchdog
   * interval -- past the menu's `waitForUrl` budget. Five seconds bounds the
   * cost on a machine whose daemon is genuinely down.
   */
  for (let i = 0; i < 10 && !readDns() && !stopped; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Boot synchronously through the first check so `waitForUrl` usually
  // resolves on the first poll instead of after a full interval.
  try {
    await check();
  } catch {
    // `check` handles its own failures; this is the belt around the braces.
    serving = false;
  }

  const timer = setInterval(() => {
    void check();
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    kind: 'funnel',
    snapshot: (): RelayInfo => {
      const dns = readDns();
      const url = serving && dns ? toPublicOrigin(dns) : null;
      return {
        kind: 'funnel',
        // A verified serving state with an unparseable DNS name advertises
        // nothing: the registry must never hand the phone a URL that 404s.
        // And health is exactly "advertising a URL", because the watchdog
        // re-verifies `serving` every interval -- a dropped endpoint shows
        // up here as no URL plus a detail saying why, within one period.
        // `false` (rather than null) means the config names our port but
        // the public probe fails: broken, not merely unverified, which is
        // the state the pairing page warns about instead of staying quiet.
        url,
        healthy: url ? true : configuredDown ? false : null,
        detail,
      };
    },
    stop: async (): Promise<void> => {
      stopped = true;
      clearInterval(timer);
      // Deliberately NOT `funnel reset`: the endpoint persists in tailscaled
      // across restarts, and tearing down the owner's public address because
      // this process is stopping would turn every deploy into an outage.
    },
  };
}
