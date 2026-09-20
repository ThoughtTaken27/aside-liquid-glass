#!/usr/bin/env node
/**
 * Does this install actually work?
 *
 * Every check answers a question someone hits during setup, in the order
 * they hit it, and each one prints what to do rather than just what failed.
 * Exit code is the number of hard failures, so an agent can branch on it.
 *
 * Run: npm run doctor   (from miniapp/)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const miniapp = path.resolve(here, '..');
const repo = path.resolve(miniapp, '..');

let failures = 0;
let warnings = 0;
const setupOnly = process.argv.includes('--setup');

const ok = (m, detail) => console.log(`  ok    ${m}${detail ? `  (${detail})` : ''}`);
const bad = (m, fix) => {
  failures += 1;
  console.log(`  FAIL  ${m}`);
  if (fix) console.log(`        fix: ${fix}`);
};
const warn = (m, detail) => {
  warnings += 1;
  console.log(`  warn  ${m}${detail ? `  (${detail})` : ''}`);
};
// During first install there is intentionally no running server or Serve
// rule yet. Keep those findings visible without making reproducible setup
// fail before the networking steps have happened.
const runtimeBad = (m, fix) => setupOnly ? warn(m, fix) : bad(m, fix);

const section = (title) => console.log(`\n${title}`);

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
}

async function httpStatus(url, timeoutMs = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Status plus body, without following redirects.
 *
 * `fetch` follows a 302 by default, which would hide exactly the thing the
 * `/` check is looking for.
 */
async function httpRaw(url, timeoutMs = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'manual' });
    return {
      status: res.status,
      location: res.headers.get('location') || '',
      body: await res.text().catch(() => ''),
    };
  } catch {
    return { status: 0, location: '', body: '' };
  } finally {
    clearTimeout(timer);
  }
}

// --- 1. toolchain ---------------------------------------------------------
section('Toolchain');

/*
 * 22.5 is where `node:sqlite` landed, and browser history and the session
 * state cache both read Chrome's SQLite directly. Both imports are inside a
 * try/catch, so an older Node boots fine and then quietly has no history
 * and no state cache -- a silent half-working install, which is worse than
 * refusing to start. This used to say 20.
 */
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 5)) ok('node', process.version);
else
  bad(
    `node ${process.version} is too old for node:sqlite`,
    'brew install node  (need v22.5+; history and search silently do nothing below it)',
  );

if (fs.existsSync(path.join(miniapp, 'node_modules'))) ok('dependencies installed');
else bad('dependencies are not installed', 'cd miniapp && npm install');

// --- 2. build outputs -----------------------------------------------------
section('Build');

const serverEntry = path.join(miniapp, 'server/dist/index.js');
if (fs.existsSync(serverEntry)) ok('server built');
else bad('server is not built', 'cd miniapp/server && npm run build');

const webIndex = path.join(miniapp, 'web/dist/index.html');
if (fs.existsSync(webIndex)) ok('web app built');
else bad('web app is not built', 'cd miniapp/web && npm run build');

// --- 3. what the server will read -----------------------------------------
section('Configuration');

let config = null;
try {
  const mod = await import(path.join(miniapp, 'server/dist/config.js'));
  config = mod.loadConfig();
  ok(config.standalone ? 'standalone mode (no Telegram)' : 'Telegram mode', `port ${config.port}`);
} catch (err) {
  bad(`config could not be loaded: ${err.message}`, 'this should not happen; open an issue with this output');
}

if (config) {
  if (fs.existsSync(config.asideCli)) ok('Aside CLI found', config.asideCli);
  else bad(`no Aside CLI at ${config.asideCli}`, 'install Aside from https://aside.so and sign in, or set MINIAPP_ASIDE_CLI');

  if (fs.existsSync(config.sessionsDir)) ok('Aside sessions directory found');
  else warn('no sessions directory yet', 'normal on a fresh Aside install; it appears after your first task');

  if (fs.existsSync(config.secretPath)) {
    const mode = fs.statSync(config.secretPath).mode & 0o777;
    if (mode === 0o600) ok('signing secret present and private');
    else bad(`signing secret is mode ${mode.toString(8)}`, `chmod 600 ${config.secretPath}`);
  } else {
    warn('no signing secret yet', 'the server writes one on first start');
  }
}

// --- 4. is it running -----------------------------------------------------
section('Runtime');

const port = config?.port ?? 8790;
const pairPort = Number(process.env.MINIAPP_PAIR_PORT) || port + 1;

const health = await httpStatus(`http://127.0.0.1:${port}/api/health`);
if (health === 200) {
  ok(`server responding on ${port}`);

  const pair = await httpRaw(`http://127.0.0.1:${pairPort}/pair`);
  if (pair.status === 200) ok(`pairing page on ${pairPort}`);
  else runtimeBad(`pairing page not answering on ${pairPort}`, 'restart the server; check nothing else holds that port');

  const leak = await httpStatus(`http://127.0.0.1:${port}/pair`);
  if (leak === 403) ok('pairing page refused on the proxied port, as it must be');
  else if (leak === 404) warn('no /pair route on the app port', 'expected when the web app is not built');
  else runtimeBad(`/pair on the app port returned ${leak}, expected 403`, 'this is the tailnet pairing leak; do not expose this server');

  /*
   * iPhone cannot pair by scanning: an installed web app has storage
   * separate from the Safari tab it was installed from, so it has to be
   * installed first and then handed the link by paste. A pairing page that
   * renders only a QR has nothing to paste, which is where the documented
   * iPhone install used to dead-end.
   */
  if (pair.status === 200) {
    if (pair.body.includes('#pair=') && pair.body.includes('<input')) {
      ok('pairing link is copyable, which iPhone needs');
    } else {
      runtimeBad('pairing page has no copyable link', 'running an old build; rebuild and restart');
    }
  }

  /*
   * `/` used to serve the Telegram build: a script from telegram.org and no
   * manifest link, so iOS Add to Home Screen made a bookmark rather than an
   * installed app. This is also the cheapest way to notice that the running
   * server is an older build than the checkout.
   */
  if (config?.standalone) {
    const root = await httpRaw(`http://127.0.0.1:${port}/`);
    if (root.status === 302 && root.location === '/app') {
      ok('/ redirects to the standalone app');
    } else if (root.body.includes('telegram.org/js')) {
      runtimeBad('/ serves the Telegram build', 'running an old build; rebuild and restart the server');
    } else if (root.status === 0) {
      warn('could not read /', 'server answered health but not the root');
    } else {
      warn(`/ returned ${root.status}`, 'expected a 302 to /app in standalone mode');
    }
  }
} else {
  warn(`server is not running on ${port}`, 'start it: cd miniapp/server && npm start');
}

// --- 5. the network the phone needs ---------------------------------------
section('Tailscale');

let tailnetHost = '';
const tsCandidates = [
  process.env.TAILSCALE_CLI,
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
];
/*
 * A machine can have more than one Tailscale CLI and more than one daemon,
 * and the wrong pairing simply errors. Some installs run a userspace
 * tailscaled on a socket of their own, which the CLI will not find unless
 * it is told, and the App Store binary cannot drive a Homebrew daemon at
 * all. Picking the first binary on disk and hoping reported "could not read
 * Tailscale status" on a machine whose tailnet was working perfectly.
 *
 * So try the combinations and keep the first that answers, rather than
 * guessing which one is real.
 */
const sockCandidates = [
  path.join(os.homedir(), '.aside-mobile/tailscale/ts.sock'),
  path.join(os.homedir(), '.aside-telegram-bridge/tailscale/ts.sock'),
];
const socks = [...sockCandidates.filter((p) => fs.existsSync(p)), null];

let ts = null;
let tsArgs = [];
let status = null;
for (const bin of [...new Set(tsCandidates.filter((p) => p && fs.existsSync(p)))]) {
  for (const sock of socks) {
    const args = sock ? ['--socket', sock] : [];
    try {
      const parsed = JSON.parse(sh(bin, [...args, 'status', '--json']));
      if (!parsed?.Self) continue;
      ts = bin;
      tsArgs = args;
      status = parsed;
      break;
    } catch {
      // Wrong binary for this daemon, or no daemon on that socket.
    }
  }
  if (status) break;
}

if (!tsCandidates.some((p) => p && fs.existsSync(p))) {
  warn('Tailscale not found', 'brew install --cask tailscale, then sign in on the Mac and the phone');
} else if (!status) {
  warn('could not read Tailscale status', 'is the daemon running? open -a Tailscale');
} else {
  tailnetHost = String(status?.Self?.DNSName || '').replace(/\.$/, '');
  if (tailnetHost) ok('tailnet hostname', tailnetHost);
  else warn('Tailscale is installed but this Mac has no hostname yet', 'sign in: open -a Tailscale');

  try {
    const serve = sh(ts, [...tsArgs, 'serve', 'status']);
    if (serve.includes(String(port))) ok(`tailscale serve points at ${port}`);
    else runtimeBad('tailscale serve is not pointing at this server', `${ts} serve --bg ${port}`);
    if (serve.includes(String(pairPort))) {
      bad(
        `tailscale serve exposes the pairing port ${pairPort}`,
        `remove that rule now: ${ts} serve --https=443 off`,
      );
    }
  } catch {
    warn('could not read the tailscale serve config', `${ts} serve status`);
  }
}

// --- 6. Android build, only if someone wants it ---------------------------
section('Android build (optional)');

const tarballJdk = path.join(os.homedir(), 'java/jdk-21.0.12+8/Contents/Home');
const javaHome = process.env.JAVA_HOME
  || (() => { try { return sh('/usr/libexec/java_home', ['-v', '21']); } catch { return ''; } })()
  // build-android.sh falls back to an unpacked tarball; look where it looks.
  || (fs.existsSync(tarballJdk) ? tarballJdk : '');
if (javaHome) ok('JDK 21', javaHome);
else warn('no JDK 21', 'only needed to build the APK: brew install --cask temurin@21');

const sdk = process.env.ANDROID_HOME || path.join(os.homedir(), 'Library/Android/sdk');
if (fs.existsSync(sdk)) {
  ok('Android SDK', sdk);
  const platform36 = fs.existsSync(path.join(sdk, 'platforms/android-36'));
  const buildTools36 = fs.existsSync(path.join(sdk, 'build-tools/36.0.0'));
  if (platform36) ok('platform android-36');
  else warn('android-36 not installed', 'sdkmanager "platforms;android-36"');
  if (buildTools36) ok('build-tools 36.0.0');
  else warn('build-tools 36.0.0 not installed', 'sdkmanager "build-tools;36.0.0" (accept the SDK license yourself)');
} else {
  warn('no Android SDK', 'only needed to build the APK; the installable web app needs none of this');
}

// --- verdict --------------------------------------------------------------
console.log('');
if (failures === 0 && warnings === 0) console.log('All checks passed.');
else console.log(`${failures} failure(s), ${warnings} warning(s).`);
if (!setupOnly && failures === 0 && health === 200 && tailnetHost) {
  console.log(`\nNext: open http://127.0.0.1:${pairPort}/pair on this Mac and scan it with your phone.`);
}
process.exit(Math.min(failures, 125));
