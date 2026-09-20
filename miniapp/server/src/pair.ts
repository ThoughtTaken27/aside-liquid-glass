/**
 * The pairing page, on its own loopback-only listener.
 *
 * This used to be a route on the main app guarded by `request.ip`. That
 * guard did not work in the deployment this project actually ships:
 * `tailscale serve` terminates TLS and proxies to `127.0.0.1:8790`, and
 * `trustProxy` is deliberately off (see the comment in `app.ts`), so
 * `request.ip` is the proxy's socket peer -- loopback -- for every request
 * that arrives over the tailnet. The check passed for everyone. Any tailnet
 * peer could open `https://<host>/pair`, read the QR, and pair itself.
 *
 * The fix is structural rather than another IP test. `tailscale serve`
 * proxies exactly one port, so the pairing page lives on a different one,
 * bound to loopback, never proxied. A tailnet peer cannot reach this
 * listener at all: there is nothing to spoof, and no header to get wrong.
 *
 * The IP check is kept as a second gate anyway. It costs one comparison
 * and it is the thing that still holds if someone later points a tunnel at
 * this port too.
 */
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import QRCode from 'qrcode';

/** Default port for the pairing listener: one above the app's own. */
export const DEFAULT_PAIR_PORT_OFFSET = 1;

/** A copied enrollment link is useful briefly, never for a season. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_PAIRING_CODES = 32;

/**
 * Opaque codes shared by the loopback pairing page and app server.
 *
 * They are one-time, expire quickly, and disappear on server restart rather
 * than becoming a permanent credential that could be embedded in an APK.
 */
export class PairingCodeStore {
  private readonly codes = new Map<string, number>();

  issue(now = Date.now()): string {
    this.sweep(now);
    while (this.codes.size >= MAX_PAIRING_CODES) {
      const oldest = this.codes.keys().next().value as string | undefined;
      if (!oldest) break;
      this.codes.delete(oldest);
    }
    const code = crypto.randomBytes(24).toString('base64url');
    this.codes.set(code, now + PAIRING_CODE_TTL_MS);
    return code;
  }

  consume(code: string, now = Date.now()): boolean {
    this.sweep(now);
    const expiresAt = this.codes.get(code);
    if (!expiresAt || expiresAt <= now) return false;
    this.codes.delete(code);
    return true;
  }

  private sweep(now: number): void {
    for (const [code, expiresAt] of this.codes) {
      if (expiresAt <= now) this.codes.delete(code);
    }
  }
}

function isLoopbackIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Escape for HTML text and double-quoted attributes.
 *
 * The pairing link is built from a hex key and a hostname read out of
 * Tailscale, so in practice it has nothing to escape. It is interpolated
 * into this page in four places, though, and one of those is a `value=`
 * attribute. Escaping is cheaper than reasoning about whether a hostname
 * can ever contain a quote.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface PairServerOptions {
  /** Issues an opaque one-time code the main app server can spend. */
  issuePairingCode: () => string;
  /** The MAIN app's port -- what the pairing link points the phone at. */
  appPort: number;
  /** Stable tailnet hostname for this Mac, read lazily. */
  tailnetHost?: () => string | null;
  logger?: boolean;
}

/**
 * A Fastify instance serving exactly one page. Caller binds it to loopback.
 */
export function buildPairServer(opts: PairServerOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: false });

  app.get('/pair', async (request, reply) => {
    if (!isLoopbackIp(String(request.ip || ''))) {
      return reply.code(403).type('text/html').send(
        '<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:2rem">' +
          '<h1>Not here</h1><p>Open this page on the Mac itself.</p></body>',
      );
    }

    const host = opts.tailnetHost?.() || '';
    if (!host) {
      return reply.code(503).type('text/html; charset=utf-8').send(
        '<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:2rem">' +
          '<h1>Tailscale is not ready</h1>' +
          '<p>Start Tailscale or set <code>ASIDE_TAILNET_HOST</code>, then reload this page.</p>' +
          '<p>No pairing code was issued.</p></body>',
      );
    }
    const base = `https://${host}`;
    const link = `${base}/app#pair=${opts.issuePairingCode()}`;
    const qr = await QRCode.toDataURL(link, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#3d3a34', light: '#f6f3ee' },
    });

    /*
     * Both platforms get their own steps, because the correct order is
     * different and getting it wrong is the most common way this fails.
     *
     * Android can scan and be done: Chrome pairs in the tab, and adding to
     * the home screen afterwards keeps the same storage.
     *
     * iOS does not. An installed web app gets a storage container separate
     * from the Safari tab it was installed from, so a phone that pairs by
     * scanning and then installs ends up with an app that has never seen
     * the key. Install first, then paste. That is why the link is on this
     * page as selectable text and not only inside the QR -- the paste step
     * has nothing to paste otherwise.
     */
    const safeLink = escapeHtml(link);

    return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair your phone</title>
<style>
  body{font:16px/1.55 -apple-system,system-ui,sans-serif;background:#f6f3ee;color:#3d3a34;
       margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
  .card{max-width:30rem;text-align:center}
  h1{font-family:ui-serif,'New York',Georgia,serif;font-weight:500;font-size:1.6rem;margin:0 0 .35rem}
  p{margin:.4rem 0;color:#6f6961}
  img{display:block;margin:1.25rem auto;border-radius:14px;box-shadow:0 2px 20px rgba(0,0,0,.09)}
  ol{text-align:left;color:#6f6961;padding-left:1.15rem;margin:.5rem 0 0}
  li{margin:.4rem 0}
  code{background:#e9e4db;padding:.12em .4em;border-radius:5px;font-size:.9em}
  h2{font-size:.78rem;letter-spacing:.09em;text-transform:uppercase;color:#8a8378;
     margin:0 0 .1rem;text-align:left;font-weight:600}
  .plat{border-top:1px solid #e2ddd4;padding-top:1rem;margin-top:1.4rem;text-align:left}
  .linkrow{display:flex;gap:.5rem;margin:1.25rem 0 0}
  .linkrow input{flex:1;min-width:0;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
       background:#fffdf9;border:1px solid #e2ddd4;border-radius:9px;padding:.6rem .7rem;
       color:#3d3a34}
  .linkrow button{flex:none;font:600 13px/1 -apple-system,system-ui,sans-serif;cursor:pointer;
       background:#3d3a34;color:#f6f3ee;border:0;border-radius:9px;padding:0 1rem}
  .linkrow button:active{opacity:.75}
  .hint{font-size:.8rem;color:#8a8378;margin:.45rem 0 0;text-align:left}
  .warn{margin-top:1.5rem;font-size:.85rem;color:#8a8378;border-top:1px solid #e2ddd4;padding-top:1rem}
</style>
<div class="card">
  <h1>Pair your phone</h1>
  <p>Tailscale has to be installed and signed in on the phone first.</p>
  <img src="${qr}" width="320" height="320" alt="Pairing QR code">

  <div class="linkrow">
    <input id="link" value="${safeLink}" readonly spellcheck="false"
           aria-label="Pairing link">
    <button id="copy" type="button">Copy</button>
  </div>
  <p class="hint">Same link the QR holds. iPhone needs it as text.</p>

  <div class="plat">
    <h2>Android</h2>
    <ol>
      <li>For the web app, scan the code, then use Chrome's <b>Add to Home screen</b>.</li>
      <li>For the optional native APK, install and open it first, then paste this
          link into its pairing screen. The APK never contains a pairing credential.</li>
    </ol>
  </div>

  <div class="plat">
    <h2>iPhone</h2>
    <ol>
      <li>Do <b>not</b> scan the code yet. Installing after pairing loses the pairing.</li>
      <li>Open <b>Safari</b> on the phone and go to <code>${escapeHtml(base)}/app</code>.</li>
      <li><b>Share</b>, then <b>Add to Home Screen</b>, then <b>Add</b>.</li>
      <li>Open Aside from the home screen icon, not from Safari.</li>
      <li>It asks to be paired. Copy the link above and paste it in.
          Universal Clipboard copies here and pastes there.</li>
    </ol>
  </div>

  <p class="warn">This is a one-time enrollment link. It expires after ten minutes,
  works for one device only, and never appears in an APK.</p>
</div>
<script>
  // Progressive enhancement only. The input is selectable and copyable by
  // hand, so a failed clipboard write is a cosmetic problem, not a dead end.
  (function () {
    var btn = document.getElementById('copy');
    var input = document.getElementById('link');
    btn.addEventListener('click', function () {
      input.select();
      input.setSelectionRange(0, input.value.length);
      var done = function () {
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = 'Copy'; }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(input.value).then(done, function () {
          try { document.execCommand('copy'); done(); } catch (e) {}
        });
      } else {
        try { document.execCommand('copy'); done(); } catch (e) {}
      }
    });
  })();
</script>`);
  });

  return app;
}
