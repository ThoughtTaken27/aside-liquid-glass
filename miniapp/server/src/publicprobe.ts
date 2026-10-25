/**
 * End-to-end proof that a public relay URL actually answers.
 *
 * The funnel supervisor used to verify by reading `serve status --json`
 * back. That document is desired-config, not proof: it says Funnel is ON
 * while the public path is dead. The incident that built this module had
 * exactly that shape -- AllowFunnel plus our proxy in the status, a phone
 * that could never reach the API, and a public TLS handshake that stalled
 * with zero bytes. The status never noticed, so the supervisor advertised
 * the URL and the pairing page handed out a QR that could not work.
 *
 * This probe walks the same path the phone walks: resolve the name as the
 * public internet sees it, open TCP, complete a TLS handshake with SNI for
 * the hostname, and read `/api/health` (unauthenticated by design) until
 * the `{"ok":true}` marker shows up. Each stage reports separately, so a
 * failure names DNS vs TCP vs TLS vs HTTP vs wrong-server instead of a
 * flat \"unreachable\".
 *
 * Never throws for network reasons: every failure is a result with a stage
 * and a detail. `detail` carries hostnames and errno strings only, never
 * credentials, so it is safe for the log, the doctor, and the loopback
 * pairing page.
 */
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

/** Where along the phone's path the probe stopped. */
export type ProbeStage = 'dns' | 'tcp' | 'tls' | 'http' | 'body';

export type PublicProbeResult =
  | { ok: true; viaIp: string; publicPath: boolean }
  | { ok: false; stage: ProbeStage; detail: string; viaIp: string | null };

/** The unauthenticated endpoint the probe reads. */
export const PROBE_PATH = '/api/health';
const DEFAULT_TIMEOUT_MS = 8000;
const DOH_TIMEOUT_MS = 5000;
/** `/api/health` is a dozen bytes; stop reading right after the marker. */
const MAX_BODY_BYTES = 4096;

/**
 * True for the 100.64.0.0/10 CGNAT range Tailscale assigns node addresses
 * from. A probe that dialed one of these tested the tailnet path, not the
 * public Funnel path -- the distinction the whole module exists to keep.
 */
export function isTailnetIpv4(ip: string): boolean {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return nums[0] === 100 && (nums[1] as number) >= 64 && (nums[1] as number) <= 127;
}

function trimDetail(value: unknown, max = 160): string {
  return String(value ?? '')
    .trim()
    .split('\n')[0]
    .slice(0, max);
}

export interface ProbeDeps {
  /** System DNS A records for the host. Default: `dns.resolve4`. */
  lookup?: (host: string) => Promise<string[]>;
  /** Public DNS A records, bypassing local MagicDNS interception. */
  resolvePublicDns?: (host: string) => Promise<string[]>;
  /** Open and close a TCP connection. Default: real `net.connect`. */
  tcpConnect?: (ip: string, port: number, timeoutMs: number) => Promise<void>;
  /**
   * GET the path over TLS, dialing the IP with SNI for the host so the
   * relay's real certificate is verified. Resolves the status and body;
   * rejects with an Error carrying `stage` ('tls' | 'http') on failure.
   */
  httpsGet?: (
    ip: string,
    port: number,
    host: string,
    path: string,
    timeoutMs: number,
  ) => Promise<{ status: number; body: string }>;
}

export interface ProbeOptions {
  /** Path to read. Default `/api/health`. */
  path?: string;
  /** Per-stage timeout. Default 8000ms. */
  timeoutMs?: number;
  deps?: ProbeDeps;
}

async function defaultLookup(host: string): Promise<string[]> {
  return dns.promises.resolve4(host);
}

interface DohAnswer {
  data?: unknown;
  type?: unknown;
}

/**
 * Resolve through public DNS-over-HTTPS, ignoring whatever the Mac's own
 * resolver says.
 *
 * On a Mac whose Tailscale runs in tun mode, the system resolver answers a
 * MagicDNS name with the 100.x node address -- probing that would test
 * tailnet serve while claiming to test public Funnel. DoH sees the name
 * the way the phone's carrier DNS does: the public relay edge.
 */
async function defaultResolvePublicDns(host: string): Promise<string[]> {
  const res = await fetch(
    `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`,
    { signal: AbortSignal.timeout(DOH_TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`public DNS answered HTTP ${res.status}`);
  const doc = (await res.json()) as { Answer?: DohAnswer[] };
  const answers = Array.isArray(doc.Answer) ? doc.Answer : [];
  return answers
    .filter((entry) => entry?.type === 1 && typeof entry.data === 'string')
    .map((entry) => (entry.data as string).trim())
    .filter((ip) => /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(ip));
}

async function defaultTcpConnect(ip: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: ip, port, timeout: timeoutMs });
    const done = (err?: Error): void => {
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.once('connect', () => done());
    socket.once('timeout', () => done(new Error(`TCP connect to ${ip}:${port} timed out`)));
    socket.once('error', (err) => done(err));
  });
}

export interface StagedError extends Error {
  stage: 'tls' | 'http';
}

async function defaultHttpsGet(
  ip: string,
  port: number,
  host: string,
  path: string,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const fail = (stage: 'tls' | 'http', detail: string): void => {
      const err = new Error(detail) as StagedError;
      err.stage = stage;
      req.destroy();
      reject(err);
    };
    const req = https.request(
      {
        host: ip,
        port,
        path,
        // Dial the IP but verify the hostname's certificate: SNI carries
        // the name, and Node checks the presented cert against it.
        servername: host,
        headers: {
          host: port === 443 ? host : `${host}:${port}`,
          'user-agent': 'aside-relay-probe/1',
        },
        timeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          if (body.length < MAX_BODY_BYTES) body += String(chunk).slice(0, MAX_BODY_BYTES - body.length);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', (err) => fail('http', `reading the response failed: ${trimDetail(err.message)}`));
      },
    );
    let tlsDone = false;
    let responded = false;
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        tlsDone = true;
      });
    });
    req.on('response', () => {
      responded = true;
    });
    req.on('timeout', () => {
      // Socket idle time; AbortSignal covers the total. Either way,
      // classify by how far the handshake got.
      if (!tlsDone) fail('tls', `TLS handshake to ${host} (${ip}) timed out`);
      else if (!responded) fail('http', `no HTTP response from ${host} (${ip})`);
      else fail('http', `response from ${host} (${ip}) stalled`);
    });
    req.on('error', (err) => {
      const message = trimDetail((err as Error).message);
      if (!tlsDone) {
        fail('tls', /abort/i.test(message)
          ? `TLS handshake to ${host} (${ip}) timed out`
          : `TLS to ${host} (${ip}) failed: ${message}`);
      } else {
        fail('http', `request to ${host} (${ip}) failed after the handshake: ${message}`);
      }
    });
    req.end();
  });
}

/**
 * Walk the phone's path to `origin` and report where it leads.
 *
 * Resolution prefers a public answer: a system answer in tailnet range is
 * re-resolved over public DNS so the probe tests Funnel, not serve. When
 * public DNS is itself unreachable the system answer is tested anyway and
 * flagged (`publicPath: false`) rather than failing a setup whose only
 * problem is the Mac's view of DNS.
 */
export async function verifyPublicEndpoint(
  origin: string,
  opts: ProbeOptions = {},
): Promise<PublicProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const path = opts.path ?? PROBE_PATH;
  const deps = opts.deps ?? {};
  const lookup = deps.lookup ?? defaultLookup;
  const resolvePublicDns = deps.resolvePublicDns ?? defaultResolvePublicDns;
  const tcpConnect = deps.tcpConnect ?? defaultTcpConnect;
  const httpsGet = deps.httpsGet ?? defaultHttpsGet;

  let host = '';
  let port = 443;
  try {
    const parsed = new URL(origin.trim());
    if (parsed.protocol !== 'https:') throw new Error('not https');
    if (!parsed.hostname) throw new Error('no hostname');
    host = parsed.hostname;
    port = parsed.port ? Number(parsed.port) : 443;
  } catch {
    return { ok: false, stage: 'dns', detail: `not an https origin: ${trimDetail(origin, 80)}`, viaIp: null };
  }

  let systemIps: string[] = [];
  let systemErr = '';
  try {
    systemIps = (await lookup(host)).filter((ip) => typeof ip === 'string' && ip);
  } catch (err) {
    systemErr = trimDetail((err as Error).message);
  }
  const systemPublic = systemIps.filter((ip) => !isTailnetIpv4(ip));
  let viaIp: string | null = systemPublic[0] ?? null;
  let publicPath = viaIp !== null;

  if (!viaIp && systemIps.length > 0) {
    // The Mac resolves this name to the tailnet only (MagicDNS
    // interception). Ask public DNS what the phone would dial.
    try {
      const publicIps = (await resolvePublicDns(host)).filter((ip) => !isTailnetIpv4(ip));
      if (publicIps[0]) {
        viaIp = publicIps[0];
        publicPath = true;
      }
    } catch {
      // Fall through to the tailnet answer below, flagged honestly.
    }
  }
  if (!viaIp && systemIps[0]) {
    viaIp = systemIps[0];
    publicPath = false;
  }
  if (!viaIp) {
    const why = systemErr || 'no addresses';
    return {
      ok: false,
      stage: 'dns',
      detail: `${host} does not resolve (${why}); public DNS can take ~10 minutes after Funnel is first enabled`,
      viaIp: null,
    };
  }

  try {
    await tcpConnect(viaIp, port, timeoutMs);
  } catch (err) {
    return {
      ok: false,
      stage: 'tcp',
      detail: `TCP to ${host} (${viaIp}:${port}) failed: ${trimDetail((err as Error).message)}`,
      viaIp,
    };
  }

  let status = 0;
  let body = '';
  try {
    ({ status, body } = await httpsGet(viaIp, port, host, path, timeoutMs));
  } catch (err) {
    const stage = (err as Partial<StagedError>).stage === 'http' ? 'http' : 'tls';
    return { ok: false, stage, detail: trimDetail((err as Error).message), viaIp };
  }
  if (status !== 200) {
    return {
      ok: false,
      stage: 'http',
      detail: `${host} answered HTTP ${status} at ${path}; the relay reaches a server that is not this app`,
      viaIp,
    };
  }
  if (!/"ok"\s*:\s*true/.test(body)) {
    return {
      ok: false,
      stage: 'body',
      detail: `${host} answered HTTP 200 without the health marker; the relay reaches the wrong server`,
      viaIp,
    };
  }
  return { ok: true, viaIp, publicPath };
}
