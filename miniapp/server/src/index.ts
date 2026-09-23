/**
 * Entry point. Reads the bridge config, mints/loads the JWT secret, and
 * serves the API plus the built SPA on MINIAPP_PORT (default 8790).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './app.js';
import { loadConfig, loadOrCreateJwtSecret } from './config.js';
import { MenuSync, Tunnel, defaultBinDir } from './tunnel.js';
import { primeTailnetHost, tailnetHost } from './tailnet.js';
import { PairingCodeStore, buildPairServer } from './pair.js';
import { createRelayRegistry } from './relays.js';
import { disabledFunnel, startFunnel } from './funnel.js';
import { disabledNgrok, startNgrok } from './ngrok.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig();
  const jwtSecret = loadOrCreateJwtSecret(config.secretPath);
  const webDist =
    process.env.MINIAPP_WEB_DIST || path.resolve(here, '../../web/dist');

  // Declared up here so the status route can read the tunnel's CURRENT
  // hostname: a quick tunnel rotates it while we run, so anything captured
  // at boot goes stale.
  let tunnel: Tunnel | null = null;
  /*
   * External mode has no Tunnel object to ask, because the hostname is
   * owned by another daemon (Tailscale Funnel) and is fixed for good.
   * Captured once at boot is correct here precisely because it cannot
   * rotate -- the opposite of the quick-tunnel case above.
   */
  let externalUrl: string | null = null;

  /*
   * The public relays (Funnel primary, ngrok backup) and the rotating
   * cloudflared tunnel are independent publishers of the same loopback
   * port. The registry fills in as each relay verifies it is actually
   * serving, so every reader below -- settings screen, menu button,
   * pairing page, client failover list -- sees relay URLs appear without
   * any restarts, and sees nothing at all when relays are disabled or
   * down, in which case behaviour is exactly today's.
   */
  const relays = createRelayRegistry();

  /*
   * The pairing page gets its own port precisely because `tailscale serve`
   * proxies exactly one. Anything on this port is unreachable from the
   * tailnet without a second, deliberate `serve` rule -- which is the
   * whole point, and the thing the old in-app IP check could not give us.
   */
  const pairPort = Number(process.env.MINIAPP_PAIR_PORT) || config.port + 1;

  // One store, shared by both listeners: the loopback page issues codes,
  // the tailnet-facing server spends them. A restart clears outstanding
  // codes, which is the point -- they are enrollment, not credentials.
  const pairingCodes = new PairingCodeStore();

  const { app } = await buildServer(config, {
    webDist,
    jwtSecret,
    logger: process.env.MINIAPP_LOG !== '0',
    publicUrl: () => relays.primary()?.url ?? tunnel?.url ?? externalUrl,
    relayUrls: () => relays.orderedUrls(),
    version: process.env.MINIAPP_VERSION || '0.1.0',
    tailnetHost,
    pairPort,
    pairingCodes,
  });

  // Warmed at boot so the first hit on /pair does not wait on a subprocess.
  primeTailnetHost();

  const host = process.env.MINIAPP_HOST || '127.0.0.1';
  await app.listen({ port: config.port, host });

  // Deliberately terse: no token, no secret, no user id in the logs.
  app.log.info(
    { sessionsDir: config.sessionsDir, webDist },
    `aside mini app listening on http://${host}:${config.port}`,
  );

  /*
   * Public relays: Funnel first, ngrok behind it. Each start call either
   * verifies its endpoint or returns a handle with no URL and a detail
   * saying why, so a relay that cannot work on this machine is one log
   * line, not a failure. Disabled-in-config relays register an explicit
   * stub so /api/relays can tell "off" apart from "broken".
   */
  const relayLog = {
    info: (message: string) => app.log.info(message),
    warn: (message: string) => app.log.warn(message),
  };
  /*
   * Started concurrently: each supervisor boots through its own first
   * verification (Funnel waits briefly for the tailnet cache, ngrok waits
   * for its agent API), and serializing those waits would push the menu's
   * `waitForUrl` budget out for no reason. The app is already listening,
   * so this only orders log lines, never availability.
   */
  /*
   * Belt and braces: both supervisors are written never to throw, but a
   * relay must never be able to break the boot either way. Worst case the
   * server runs exactly as it did before relays existed.
   */
  const safeStart = async <T>(start: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await start;
    } catch (err) {
      app.log.warn(`relay failed to start: ${(err as Error).message}`);
      return fallback;
    }
  };
  const [funnelHandle, ngrokHandle] = await Promise.all([
    config.miniapp.relayFunnel
      ? safeStart(
          startFunnel({ port: config.port, logger: relayLog }),
          disabledFunnel('failed to start; see the log'),
        )
      : Promise.resolve(disabledFunnel('disabled in config (miniapp.relay_funnel)')),
    config.miniapp.relayNgrok
      ? safeStart(
          startNgrok({
            port: config.port,
            domain: config.miniapp.ngrokDomain,
            authtoken: config.miniapp.ngrokAuthtoken,
            logger: relayLog,
          }),
          disabledNgrok('failed to start; see the log'),
        )
      : Promise.resolve(disabledNgrok('disabled in config (miniapp.relay_ngrok)')),
  ]);
  relays.register(funnelHandle);
  relays.register(ngrokHandle);
  for (const snap of relays.snapshot()) {
    app.log.info(
      `relay ${snap.kind}: ${snap.url ?? snap.detail ?? 'unavailable'}`,
    );
  }

  /*
   * Hard-coded to loopback, not `MINIAPP_HOST`: this listener hands out a
   * credential, so it must not follow the app onto a wider interface if
   * someone widens that one.
   */
  const pairApp = buildPairServer({
    issuePairingCode: () => pairingCodes.issue(),
    appPort: config.port,
    tailnetHost,
    publicUrls: () => {
      const urls = relays.orderedUrls().map((relay) => ({
        label:
          relay.kind === 'funnel'
            ? 'Funnel (recommended -- no app needed on the phone)'
            : 'ngrok backup (plain HTTPS, no app needed)',
        url: relay.url,
      }));
      if (externalUrl) {
        urls.push({ label: 'Configured address', url: externalUrl });
      }
      return urls;
    },
    logger: false,
  });
  try {
    await pairApp.listen({ port: pairPort, host: '127.0.0.1' });
    app.log.info(`pairing page on http://127.0.0.1:${pairPort}/pair`);
  } catch (err) {
    // A busy pair port must not take the app down with it. Pairing is a
    // once-per-device errand; the agent itself is the thing that has to
    // stay up.
    app.log.error(
      `pairing listener failed to bind on ${pairPort}: ${(err as Error).message}`,
    );
  }

  let menu: MenuSync | null = null;

  const tunnelMode = config.miniapp.tunnel;

  if (tunnelMode === 'cloudflared' || tunnelMode === 'external') {
    if (config.miniapp.autoRegisterMenu) {
      // Owns retries and drift repair. A single fire-and-forget call used
      // to live inline here, and losing that one call (network not up yet
      // on wake) left Telegram pointed at a dead hostname permanently.
      menu = new MenuSync({
        botToken: config.botToken,
        chatId: config.allowedUserId,
        log: (message) => app.log.info(message),
      });
      menu.start();
    } else {
      app.log.info(
        'menu auto-registration is off; set miniapp.auto_register_menu to enable',
      );
    }
  }

  if (tunnelMode === 'external') {
    externalUrl = `https://${config.miniapp.tunnelHostname}`;
    app.log.info(
      `external tunnel: public url is ${externalUrl} (managed outside this process)`,
    );
    /*
     * No watchdog and no recycle loop: there is nothing here to restart.
     * If the machine sleeps, the external daemon reattaches on wake at the
     * SAME hostname, so an already-open webview keeps working. One
     * reconcile at boot is enough to repair a menu button left pointing at
     * an old cloudflared hostname from a previous run.
     */
    menu?.setTarget(externalUrl);
    void menu?.reconcile();
  }

  if (menu && tunnelMode === 'cloudflared') {
    /*
     * A verified relay URL beats a rotating quick-tunnel hostname for the
     * menu button: it never goes stale, so Telegram keeps working across
     * restarts instead of pointing at last boot's address. External mode
     * is excluded on purpose -- an explicitly configured hostname is the
     * owner's choice and always wins over an opportunistic relay.
     */
    void relays.waitForUrl(15_000).then((found) => {
      if (found) {
        app.log.info(`menu: using stable relay ${found.url}`);
        menu?.setTarget(found.url);
        void menu?.reconcile();
      }
    });
  }

  if (tunnelMode === 'cloudflared') {
    tunnel = new Tunnel({
      port: config.port,
      binDir: defaultBinDir(config.miniapp.stateDir),
      cloudflaredPath: config.miniapp.cloudflaredPath || undefined,
      tunnelName: config.miniapp.tunnelName || undefined,
      configPath: config.miniapp.cloudflaredConfig || undefined,
      fixedUrl: config.miniapp.tunnelHostname
        ? `https://${config.miniapp.tunnelHostname}`
        : undefined,
      log: (message) => app.log.info(message),
      onUrl: (url) => {
        app.log.info(`public url: ${url}`);
        // Fires once per spawn for a named tunnel (fixed hostname) and on
        // every rotation for a quick tunnel; either way it keeps the
        // ephemeral-quick-tunnel case pointed at the live hostname -- unless
        // a stable relay verified first, in which case the relay wins and
        // the quick hostname stays a fallback the settings screen shows.
        menu?.setTarget(relays.primary()?.url ?? url);
      },
      onHealthy: (url) => {
        // The tunnel is provably reachable from the public internet, so
        // this is the right moment to confirm Telegram agrees about where
        // to send people. `reconcile` reads first and only writes on a
        // genuine mismatch, which closes the last gap -- a write that
        // returned ok but did not stick -- without turning the health
        // probe into a write loop.
        menu?.setTarget(relays.primary()?.url ?? url);
        void menu?.reconcile();
      },
    });
    tunnel.start().catch((err) => {
      app.log.error(`tunnel failed to start: ${err.message}`);
    });
  }

  /*
   * Node terminates the process on an unhandled rejection. This server is
   * meant to sit running for weeks behind a KeepAlive job, and it is full
   * of deliberate fire-and-forget `void` calls -- menu registration, read
   * marking, subagent refreshes. Any one of those growing a throw would
   * take the whole app down and take the tunnel with it. Log it and stay
   * up; a dropped background task is recoverable, a dead process is not.
   */
  process.on('unhandledRejection', (reason) => {
    app.log.error(
      { err: reason instanceof Error ? reason : new Error(String(reason)) },
      'unhandled rejection',
    );
  });

  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'uncaught exception');
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      tunnel?.stop();
      menu?.stop();
      void relays.stopAll();
      void pairApp.close();
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

main().catch((err) => {
  console.error(`miniapp failed to start: ${(err as Error).message}`);
  process.exit(1);
});
