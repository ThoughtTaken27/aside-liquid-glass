/** Encrypted Web Push for opt-in devices. No chat credentials in payloads. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';

export type PushKind = 'ready' | 'needs-input' | 'error' | 'progress' | 'test';
/**
 * `phase` is a category word chosen on the Mac ("Searching the web"), never
 * a tool argument, so it is safe on a lock screen even with previews off.
 * `startedAt` lets the phone run its own clock between updates.
 */
export interface PushNotice { sessionId?: string; kind: PushKind; title?: string; summary?: string; phase?: string; startedAt?: number }
export interface PushPreferences { previews: boolean; progress: boolean }
export interface DeviceSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
interface Device { id: string; subscription: DeviceSubscription; preferences: PushPreferences }
/**
 * `title`/`body` are the plain heading and line the in-app banner shows.
 * `topic` (the conversation title) rides separately, and only with previews
 * on, so the shade card can lead with it the way chat apps do.
 */
export interface PushPayload { version: 1; id: string; sessionId?: string; kind: PushKind; title: string; body: string; topic?: string; expiresAt: number; phase?: string; startedAt?: number }
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const KEY = /^[A-Za-z0-9_-]+={0,2}$/;
export function parseSubscription(value: unknown): DeviceSubscription {
  const s = value as Partial<DeviceSubscription> | null;
  if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 2048) throw new Error('invalid_subscription');
  const url = new URL(s.endpoint);
  if (url.protocol !== 'https:' || !PUSH_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.hash) throw new Error('invalid_push_endpoint');
  const p = s.keys?.p256dh, a = s.keys?.auth;
  if (typeof p !== 'string' || typeof a !== 'string' || !KEY.test(p) || !KEY.test(a) || p.length > 100 || a.length > 32 || Buffer.from(p, 'base64url').length !== 65 || Buffer.from(p, 'base64url')[0] !== 4 || Buffer.from(a, 'base64url').length !== 16) throw new Error('invalid_push_keys');
  return { endpoint: s.endpoint, keys: { p256dh: p, auth: a } };
}
function validatedPreferences(value: unknown): Partial<PushPreferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_preferences');
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!['previews', 'progress'].includes(key) || typeof v[key] !== 'boolean') throw new Error('invalid_preferences');
  return v;
}
const HEADINGS: Record<PushKind, string> = { ready: 'Reply ready', 'needs-input': 'Aside has a question', error: 'Aside couldn’t finish', progress: 'Aside is working', test: 'Notifications are on' };
const GENERIC: Record<PushKind, string> = { ready: 'Tap to read it.', 'needs-input': 'Tap to answer so it can keep going.', error: 'Tap to see what happened.', progress: 'Working on your request.', test: 'Replies and live status will show up here.' };
export function pushPayload(notice: PushNotice, prefs: PushPreferences, now = Date.now()): PushPayload {
  const clean = (s: string) => s.replace(/```[\s\S]*?```/g, '').replace(/<[^>]*>/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*#`]/g, '').replace(/\s+/g, ' ').trim();
  const live = notice.kind === 'progress';
  const phase = live && notice.phase ? clean(notice.phase).slice(0, 40) : '';
  // Content previews are explicit: generic copy otherwise, including the conversation title.
  const topic = prefs.previews && notice.title ? clean(notice.title).slice(0, 70) : '';
  const summary = prefs.previews && notice.summary ? clean(notice.summary).slice(0, 200) : '';
  return { version: 1, id: crypto.randomUUID(), sessionId: notice.sessionId, kind: notice.kind,
    title: HEADINGS[notice.kind],
    body: phase || summary || GENERIC[notice.kind],
    ...(topic ? { topic } : {}),
    ...(phase ? { phase } : {}),
    ...(live && Number.isFinite(notice.startedAt) ? { startedAt: notice.startedAt } : {}),
    expiresAt: now + (live ? 120_000 : 3_600_000) };
}
function save(file: string, value: unknown) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(tmp, file); }
function load<T>(file: string, fallback: T): T { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
export class PhonePush {
  private devices: Device[];
  private file: string;
  private keys?: { publicKey: string; privateKey: string };
  constructor(private options: { stateDir: string; send?: typeof webpush.sendNotification; now?: () => number }) {
    this.file = path.join(options.stateDir, 'phone-push-devices.json');
    const loaded = load<Device[]>(this.file, []);
    this.devices = Array.isArray(loaded) ? loaded.filter(d => { try { parseSubscription(d.subscription); return typeof d.id === 'string' && typeof d.preferences?.previews === 'boolean' && typeof d.preferences?.progress === 'boolean'; } catch { return false; } }).slice(0, 16) : [];
  }
  get count() { return this.devices.length; }
  get publicKey() {
    if (!this.keys) {
      const file = path.join(this.options.stateDir, 'phone-push-vapid.json');
      this.keys = load<{ publicKey: string; privateKey: string } | undefined>(file, undefined);
      if (!this.keys?.publicKey || !this.keys.privateKey) { this.keys = webpush.generateVAPIDKeys(); save(file, this.keys); }
    }
    return this.keys.publicKey;
  }
  get(id: string) { const d = this.devices.find(x => x.id === id); return d ? { id: d.id, preferences: d.preferences } : null; }
  subscribe(value: unknown, preferences?: Partial<PushPreferences>) {
    const subscription = parseSubscription(value);
    const id = crypto.createHash('sha256').update(subscription.endpoint).digest('hex');
    const old = this.devices.find(d => d.id === id);
    const input = preferences === undefined ? {} : validatedPreferences(preferences);
    // Live status is the point of opting in, so it starts on; summaries stay opt-in.
    const prefs = { previews: input.previews === true, progress: input.progress !== false };
    const device = { id, subscription, preferences: preferences ? prefs : old?.preferences ?? prefs };
    this.devices = this.devices.filter(d => d.id !== id);
    if (this.devices.length >= 16) throw new Error('device_limit');
    this.devices.push(device); save(this.file, this.devices); return { id, preferences: device.preferences };
  }
  update(id: string, prefs: Partial<PushPreferences>) {
    const d = this.devices.find(x => x.id === id); if (!d) return null;
    prefs = validatedPreferences(prefs);
    if (typeof prefs.previews === 'boolean') d.preferences.previews = prefs.previews;
    if (typeof prefs.progress === 'boolean') d.preferences.progress = prefs.progress;
    save(this.file, this.devices); return this.get(id);
  }
  remove(id: string) { this.devices = this.devices.filter(d => d.id !== id); save(this.file, this.devices); }
  async deliver(notice: PushNotice, onlyDevice?: string): Promise<{ accepted: number; failed: number }> {
    if (!this.count) return { accepted: 0, failed: 0 };
    this.publicKey; // Load the stable signing identity only when needed.
    let accepted = 0, failed = 0;
    await Promise.all(this.devices.slice().filter(d => !onlyDevice || d.id === onlyDevice).map(async d => {
      if (notice.kind === 'progress' && !d.preferences.progress) return;
      try {
        await (this.options.send ?? webpush.sendNotification)(d.subscription, JSON.stringify(pushPayload(notice, d.preferences, this.options.now?.())), {
          TTL: notice.kind === 'progress' ? 120 : 3600, timeout: 10_000,
          urgency: notice.kind === 'progress' ? 'low' : 'normal',
          topic: crypto.createHash('sha256').update(notice.sessionId ?? 'test').digest('base64url').slice(0, 32),
          vapidDetails: { subject: 'https://asidehq.com', ...this.keys! },
        }); accepted++;
      } catch (e) {
        failed++;
        if ([404, 410].includes(Number((e as { statusCode?: number }).statusCode))) this.remove(d.id);
        // Do not log endpoint keys, private message bodies or service responses.
      }
    }));
    return { accepted, failed };
  }
}
