/**
 * Ryan (en-GB-RyanNeural) through Microsoft Edge's free read-aloud voice,
 * the same service and protocol the Mac's Hey Aside app uses
 * (Hey-Aside/Sources/Voice.swift, after rany2/edge-tts). Returns MP3.
 *
 * It is an unofficial endpoint, so the phone always keeps Android's own
 * text-to-speech as a fallback, and private (Tier B) replies can be spoken
 * on the phone instead so their text never leaves it.
 */
import crypto from 'node:crypto';
import WebSocket from 'ws';

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM = '143.0.3650.75';
// Since October 2026 speech.platform.bing.com answers synthesis with 403.
// Edge itself now synthesizes through api.msedgeservices.com, which takes
// the same client id as Ocp-Apim-Subscription-Key (rany2/edge-tts#491).
export const SYNTH_HOST = 'api.msedgeservices.com';
const URL_BASE = `wss://${SYNTH_HOST}/tts/cognitiveservices/websocket/v1`;

/** The synthesis socket URL for one connection. */
export function synthUrl(cid: string, gec = secMsGec()): string {
  return `${URL_BASE}?Ocp-Apim-Subscription-Key=${TOKEN}&ConnectionId=${cid}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-${CHROMIUM}`;
}

export const VOICES = ['en-GB-RyanNeural', 'en-GB-ThomasNeural', 'en-US-AndrewNeural'] as const;
export type Voice = (typeof VOICES)[number];

let clockSkewMs = 0;

export function secMsGec(nowMs = Date.now()): string {
  let ticks = (nowMs + clockSkewMs) / 1000 + 11_644_473_600;
  ticks -= ticks % 300;
  const s = `${Math.round(ticks * 10_000_000)}${TOKEN}`;
  return crypto.createHash('sha256').update(s, 'ascii').digest('hex').toUpperCase();
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

function jsDate(): string {
  return new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+)/, '$1 $3 $2 $4') + '+0000 (Coordinated Universal Time)';
}

export class TtsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TtsError';
  }
}

async function fixSkew(): Promise<void> {
  try {
    // The host that checks the token is the one whose clock matters.
    const r = await fetch(`https://${SYNTH_HOST}/`, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
    const d = r.headers.get('date');
    if (d) clockSkewMs = new Date(d).getTime() - Date.now();
  } catch {
    /* best effort */
  }
}

function once(text: string, voice: Voice, ratePct: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cid = crypto.randomUUID().replace(/-/g, '');
    const url = synthUrl(cid);
    const major = CHROMIUM.split('.')[0];
    const ws = new WebSocket(url, {
      headers: {
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`,
      },
      handshakeTimeout: 5000,
    });
    const rid = crypto.randomUUID().replace(/-/g, '');
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new TtsError('timeout'));
    }, timeoutMs);
    const done = (err: Error | null, audio?: Buffer) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(audio!);
    };
    ws.on('unexpected-response', (_req, res) => done(new TtsError(`http_${res.statusCode}`)));
    ws.on('error', (e) => done(new TtsError(`socket: ${e.message}`)));
    ws.on('open', () => {
      ws.send(
        `X-Timestamp:${jsDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n',
      );
      const rate = `${ratePct >= 0 ? '+' : ''}${ratePct}%`;
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'>` +
        `<prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${rid}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${jsDate()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    });
    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (!isBinary) {
        const s = buf.toString('utf8');
        if (s.includes('Path:turn.end')) {
          if (!chunks.length) done(new TtsError('no_audio'));
          else done(null, Buffer.concat(chunks));
        }
        return;
      }
      if (buf.length < 2) return;
      const hl = buf.readUInt16BE(0);
      if (buf.length < 2 + hl) return;
      const head = buf.subarray(2, 2 + hl).toString('utf8');
      if (head.includes('Path:audio') && buf.length > 2 + hl) chunks.push(buf.subarray(2 + hl));
    });
  });
}

/** MP3 for one short reply. Text is capped; SSML is escaped. */
export async function synthesize(text: string, voice: Voice = 'en-GB-RyanNeural', ratePct = 9, timeoutMs = 8000): Promise<Buffer> {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (!clean) throw new TtsError('empty');
  try {
    return await once(clean, voice, ratePct, timeoutMs);
  } catch (err) {
    if (err instanceof TtsError && err.code === 'http_403') {
      await fixSkew();
      return once(clean, voice, ratePct, timeoutMs);
    }
    throw err;
  }
}
