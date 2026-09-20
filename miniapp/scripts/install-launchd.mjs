#!/usr/bin/env node
/**
 * Keep the server running across logouts and reboots.
 *
 * The README used to say "install a launchd job" and leave the reader to
 * work out how. This writes the plist, loads it, and checks it answered.
 *
 * Run:  npm run launchd          (install and start)
 *       npm run launchd -- off   (stop and remove)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const LABEL = 'com.aside.mobile';
const here = path.dirname(fileURLToPath(import.meta.url));
const miniapp = path.resolve(here, '..');
const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const entry = path.join(miniapp, 'server/dist/index.js');

const run = (cmd, args) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { ok: false, out: String(err.stderr || err.message) };
  }
};

const uid = process.getuid();
const target = `gui/${uid}/${LABEL}`;

if (process.argv.includes('off')) {
  run('launchctl', ['bootout', `gui/${uid}`, plistPath]);
  if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  console.log(`removed ${LABEL}`);
  process.exit(0);
}

if (!fs.existsSync(entry)) {
  console.error(`server is not built: ${entry}`);
  console.error('run: cd miniapp/server && npm run build');
  process.exit(1);
}

/*
 * `node` is resolved to an absolute path on purpose. launchd jobs do not
 * get a login shell, so a bare `node` fails on exactly the machines that
 * keep node in /opt/homebrew, which is most Apple Silicon Macs.
 */
const nodeBin = process.execPath;
const logDir = path.join(os.homedir(), 'Library/Logs');
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(path.dirname(plistPath), { recursive: true });

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// launchd does not inherit the caller's shell environment. Snapshot only
// documented path/behavior overrides, never arbitrary variables or tokens.
const forwardedNames = [
  'ASIDE_TAILNET_HOST', 'TAILSCALE_CLI',
  'MINIAPP_ASIDE_CLI', 'MINIAPP_ASIDE_ROOT', 'MINIAPP_CONFIG',
  'MINIAPP_CREDENTIALS', 'MINIAPP_HOST', 'MINIAPP_LOG', 'MINIAPP_MEDIA_DIR',
  'MINIAPP_PAIR_PORT', 'MINIAPP_PORT', 'MINIAPP_SECRET_PATH',
  'MINIAPP_SESSIONS_DIR', 'MINIAPP_SETTINGS_PATH', 'MINIAPP_SOFT_CONFIRM_PATH',
  'MINIAPP_STATE_DB', 'MINIAPP_STATE_DIR', 'MINIAPP_UPLOADS_DIR',
  'MINIAPP_WEB_DIST', 'MINIAPP_WHISPER_MODEL',
];
const forwardedEnvironment = forwardedNames
  .filter((name) => process.env[name] !== undefined)
  .map((name) => `    <key>${name}</key><string>${esc(process.env[name])}</string>`)
  .join('\n');

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodeBin)}</string>
    <string>${esc(entry)}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(path.join(miniapp, 'server'))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(path.join(logDir, `${LABEL}.log`))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logDir, `${LABEL}.err.log`))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
${forwardedEnvironment}
  </dict>
</dict>
</plist>
`;

fs.writeFileSync(plistPath, plist, { mode: 0o644 });
console.log(`wrote ${plistPath}`);

// Replace any previous copy rather than layering a second one on top.
run('launchctl', ['bootout', `gui/${uid}`, plistPath]);
const boot = run('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
if (!boot.ok && !boot.out.includes('already bootstrapped')) {
  console.error(`launchctl bootstrap failed: ${boot.out.trim()}`);
  console.error('If this is a sandboxed shell, run the same command in Terminal.app.');
  process.exit(1);
}
run('launchctl', ['kickstart', '-k', target]);

const port = Number(process.env.MINIAPP_PORT) || 8790;
const deadline = Date.now() + 15000;
let up = false;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (res.ok) { up = true; break; }
  } catch {
    // not listening yet
  }
  await new Promise((r) => setTimeout(r, 500));
}

if (up) {
  console.log(`${LABEL} is running and answering on ${port}.`);
  console.log(`logs: ${path.join(logDir, `${LABEL}.log`)}`);
} else {
  console.error(`${LABEL} was loaded but nothing answered on ${port} within 15s.`);
  console.error(`check ${path.join(logDir, `${LABEL}.err.log`)}`);
  process.exit(1);
}
