/**
 * Discover the stable MagicDNS hostname used by installed phone clients.
 *
 * Standalone installs normally use the macOS Tailscale app. Older bridge
 * installs may use a Homebrew CLI and a userspace socket. Try every valid
 * local combination rather than pinning a fresh clone to either layout.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TTL_MS = 60_000;
let cached: string | null = null;
let checkedAt = 0;
let inFlight = false;

interface Attempt {
  binary: string;
  args: string[];
}

function normalizedOverride(): string | null {
  const raw = String(process.env.ASIDE_TAILNET_HOST || '').trim();
  if (!raw) return null;
  return raw.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/\.$/, '');
}

function attempts(): Attempt[] {
  const binaries = [
    process.env.TAILSCALE_CLI,
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ].filter((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate)));
  const sockets = [
    path.join(os.homedir(), '.aside-mobile/tailscale/ts.sock'),
    // Compatibility only for machines that still run the original bridge.
    path.join(os.homedir(), '.aside-telegram-bridge/tailscale/ts.sock'),
  ].filter((candidate) => fs.existsSync(candidate));

  const found: Attempt[] = [];
  for (const binary of [...new Set(binaries)]) {
    for (const socket of sockets) {
      found.push({ binary, args: ['--socket', socket, 'status', '--json'] });
    }
    found.push({ binary, args: ['status', '--json'] });
  }
  return found;
}

function refresh(): void {
  if (inFlight || normalizedOverride()) return;
  const pending = attempts();
  if (!pending.length) {
    cached = null;
    checkedAt = Date.now();
    return;
  }

  inFlight = true;
  const tryNext = (index: number): void => {
    const attempt = pending[index];
    if (!attempt) {
      cached = null;
      checkedAt = Date.now();
      inFlight = false;
      return;
    }
    execFile(
      attempt.binary,
      attempt.args,
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (!err) {
          try {
            const parsed = JSON.parse(String(stdout)) as {
              BackendState?: string;
              Self?: { DNSName?: string };
            };
            const dns = String(parsed.Self?.DNSName || '').replace(/\.$/, '');
            if (parsed.BackendState === 'Running' && dns) {
              cached = dns;
              checkedAt = Date.now();
              inFlight = false;
              return;
            }
          } catch {
            // Try the next installed CLI/socket combination.
          }
        }
        tryNext(index + 1);
      },
    );
  };
  tryNext(0);
}

/** Current tailnet hostname, or null while Tailscale is unavailable. */
export function tailnetHost(): string | null {
  const override = normalizedOverride();
  if (override) return override;
  if (Date.now() - checkedAt > TTL_MS) refresh();
  return cached;
}

/** Prime the cache at boot so the pairing page normally has an answer. */
export function primeTailnetHost(): void {
  refresh();
}
