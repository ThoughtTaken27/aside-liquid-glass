/**
 * Live answers without an agent: plain code searches and reads public pages,
 * and only a model with no tools ever sees the text. A hostile page can at
 * worst garble the spoken answer; it cannot make anything happen.
 *
 * Guard rails on every fetch:
 *  - https only, standard port, no credentials in the URL;
 *  - the hostname must resolve only to public addresses (no loopback,
 *    private, link-local, CGNAT, multicast), checked on every redirect hop,
 *    so a result cannot point the Mac at itself or the home network;
 *  - at most 3 redirects, 6 s, 800 KB, text/html or text/plain only;
 *  - no cookies, no auth headers.
 */
import dns from 'node:dns/promises';
import dnsCb from 'node:dns';
import https from 'node:https';
import net from 'node:net';

export class WebError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WebError';
  }
}

export function isPublicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return false;
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('ff')) return false;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    return true;
  }
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);

export async function checkUrl(raw: string, resolve: Resolver = defaultResolver): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new WebError('bad_url');
  }
  if (u.protocol !== 'https:') throw new WebError('not_https');
  if (u.username || u.password) throw new WebError('credentials_in_url');
  if (u.port && u.port !== '443') throw new WebError('odd_port');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new WebError('private_host');
  const ips = net.isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (!ips.length) throw new WebError('unresolved');
  if (!ips.every(isPublicIp)) throw new WebError('private_address');
  return u;
}

/**
 * DNS lookup used at connect time: the address actually dialled is the one
 * checked, so a host cannot answer "public" to the check and "127.0.0.1"
 * to the connection (DNS rebinding).
 */
function guardedLookup(hostname: string, options: dnsCb.LookupOptions, cb: (...a: any[]) => void): void {
  dnsCb.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = (addrs as dnsCb.LookupAddress[]).filter((a) => isPublicIp(a.address));
    if (!list.length || list.length !== (addrs as dnsCb.LookupAddress[]).length) return cb(new WebError('private_address'));
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

interface RawResponse {
  status: number;
  location: string | null;
  type: string;
  body: Buffer;
}

function getOnce(u: URL, maxBytes: number, timeoutMs: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      u,
      {
        method: 'GET',
        lookup: guardedLookup as any,
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
          accept: 'text/html,text/plain;q=0.9',
          'accept-encoding': 'identity',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        const type = String(res.headers['content-type'] ?? '');
        if ((status >= 300 && status < 400) || !/text\/(html|plain)/i.test(type)) {
          res.resume();
          return resolve({ status, location, type, body: Buffer.alloc(0) });
        }
        const parts: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) {
            res.destroy();
            return resolve({ status, location, type, body: Buffer.concat(parts) });
          }
          parts.push(c);
        });
        res.on('end', () => resolve({ status, location, type, body: Buffer.concat(parts) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new WebError('timeout')));
    req.on('error', (e) => reject(e instanceof WebError ? e : new WebError(`net: ${e.message}`)));
    req.end();
  });
}

export async function safeFetchText(
  raw: string,
  opts: { resolve?: Resolver; get?: (u: URL) => Promise<RawResponse>; maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ url: string; text: string }> {
  const maxBytes = opts.maxBytes ?? 800_000;
  const get = opts.get ?? ((u: URL) => getOnce(u, maxBytes, opts.timeoutMs ?? 6000));
  let url = raw;
  for (let hop = 0; hop <= 3; hop++) {
    const u = await checkUrl(url, opts.resolve);
    const res = await get(u);
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new WebError('bad_redirect');
      url = new URL(res.location, u).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new WebError(`http_${res.status}`);
    if (!/text\/(html|plain)/i.test(res.type)) throw new WebError('not_text');
    const body = res.body.toString('utf8');
    return { url: u.toString(), text: /html/i.test(res.type) ? htmlToText(body) : body };
  }
  throw new WebError('too_many_redirects');
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template|iframe|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** DuckDuckGo's no-JavaScript results page: free, no key. */
export function parseDuckDuckGo(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  const blocks = html.split(/class="result results_links/).slice(1);
  for (const b of blocks) {
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let href = a[1].replace(/&amp;/g, '&');
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith('//')) href = `https:${href}`;
    if (!/^https:\/\//.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue; // skip ads
    const snip = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    out.push({ title: htmlToText(a[2]).slice(0, 160), url: href, snippet: snip ? htmlToText(snip[1]).slice(0, 400) : '' });
    if (out.length >= 6) break;
  }
  return out;
}

export async function search(query: string, fetchImpl: typeof fetch = fetch): Promise<SearchHit[]> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 200);
  const res = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new WebError(`search_${res.status}`);
  return parseDuckDuckGo(await res.text());
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo: free, no key). Location arrives rounded to ~10 km.

const WMO: Record<number, string> = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'foggy', 48: 'foggy',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers', 85: 'snow showers', 86: 'snow showers',
  95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail',
};

export interface WeatherFacts {
  nowF: number;
  feelsF: number;
  sky: string;
  highF: number;
  lowF: number;
  rainChance: number;
  tomorrow: { highF: number; lowF: number; sky: string; rainChance: number };
}

export async function weather(lat: number, lon: number, fetchImpl: typeof fetch = fetch): Promise<WeatherFacts> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new WebError('bad_location');
  const la = Math.round(lat * 10) / 10;
  const lo = Math.round(lon * 10) / 10;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}` +
    '&current=temperature_2m,apparent_temperature,weather_code' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max' +
    '&temperature_unit=fahrenheit&timezone=auto&forecast_days=2';
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new WebError(`weather_${res.status}`);
  const j = (await res.json()) as {
    current: { temperature_2m: number; apparent_temperature: number; weather_code: number };
    daily: { temperature_2m_max: number[]; temperature_2m_min: number[]; weather_code: number[]; precipitation_probability_max: number[] };
  };
  const r = Math.round;
  return {
    nowF: r(j.current.temperature_2m),
    feelsF: r(j.current.apparent_temperature),
    sky: WMO[j.current.weather_code] ?? 'mixed',
    highF: r(j.daily.temperature_2m_max[0]),
    lowF: r(j.daily.temperature_2m_min[0]),
    rainChance: r(j.daily.precipitation_probability_max[0] ?? 0),
    tomorrow: {
      highF: r(j.daily.temperature_2m_max[1]),
      lowF: r(j.daily.temperature_2m_min[1]),
      sky: WMO[j.daily.weather_code[1]] ?? 'mixed',
      rainChance: r(j.daily.precipitation_probability_max[1] ?? 0),
    },
  };
}
