/** Per-origin, per-device push. Browser permission is only requested on a tap. */
import { currentAuthToken } from './api';
export interface NotificationPreferences { previews: boolean; progress: boolean }
export interface NotificationDevice { id: string; preferences: NotificationPreferences }
export interface PhoneNotice { version: 1; id: string; sessionId?: string; kind: 'ready' | 'needs-input' | 'error' | 'progress' | 'test'; title: string; body: string; topic?: string; expiresAt: number }
const DEVICE_KEY = 'aside.phonePushDevice.v1';
export function deviceId(): string | null { try { return localStorage.getItem(DEVICE_KEY); } catch { return null; } }
class PhoneRequestError extends Error {
  constructor(readonly status: number) { super(status === 401 ? 'Open Aside and pair this device again.' : status === 404 ? 'The Mac needs the notification update and a restart.' : 'Could not reach notification settings. Try again.'); }
}
async function request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(url, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', authorization: `Bearer ${currentAuthToken()}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new PhoneRequestError(res.status);
  return res.json() as Promise<T>;
}
/** Hard blockers only. A blocked permission is NOT one: it can be undone, so it never disables the button. */
export function pushSupport(): string | null {
  if (!window.isSecureContext) return 'Open Aside using its secure app address to enable notifications.';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'This browser does not support background notifications. Open Aside from its home-screen icon in Chrome.';
  return null;
}
export function notificationsBlocked(): boolean {
  return 'Notification' in window && Notification.permission === 'denied';
}
/** Exactly where the switch is on a Samsung/Android phone, for each way Aside can be opened. */
export const BLOCKED_HELP = 'Android is blocking Aside’s notifications. Long-press the Aside icon on your home screen, tap App info › Notifications, and turn them on. If you opened Aside in a Chrome tab instead, tap the lock icon in the address bar › Permissions › Notifications › Allow. Then come back here.';

/** Which step failed, said plainly, so a failure is never just "it didn't work". */
export class SetupError extends Error {
  constructor(readonly step: string, message: string, readonly cause?: unknown) { super(message); }
}
function withTimeout<T>(promise: Promise<T>, ms: number, step: string, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SetupError(step, message)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
/** Best effort: tells the Mac's log which step failed. Never throws, never blocks. */
export function reportSetupFailure(error: unknown): void {
  try {
    const e = error as { step?: string; name?: string; message?: string; cause?: { name?: string; message?: string } };
    const body = JSON.stringify({
      step: e?.step ?? 'unknown',
      error: String(e?.cause?.name ?? e?.name ?? 'Error').slice(0, 60),
      detail: String(e?.cause?.message ?? e?.message ?? '').slice(0, 300),
      permission: 'Notification' in window ? Notification.permission : 'unsupported',
      standalone: window.matchMedia?.('(display-mode: standalone)').matches ?? false,
      controller: Boolean(navigator.serviceWorker?.controller),
    });
    void fetch('/api/notifications/diagnostic', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', authorization: `Bearer ${currentAuthToken()}` }, body, keepalive: true }).catch(() => {});
  } catch { /* diagnostics must never become the failure */ }
}
async function lookupDevice(id: string): Promise<NotificationDevice | null> {
  try { return await request<NotificationDevice>(`/api/notifications/devices/${id}`); }
  catch (error) { if (error instanceof PhoneRequestError && error.status === 404) return null; throw error; }
}
export async function readNotificationDevice(): Promise<NotificationDevice | null> {
  const id = deviceId(); if (!id) return null;
  const d = await lookupDevice(id); if (!d) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!(await reg?.pushManager.getSubscription())) return null;
  return d;
}
function keyBytes(value: string): Uint8Array<ArrayBuffer> { const b = atob(value.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); }
export async function enablePhoneNotifications(): Promise<NotificationDevice> {
  const unsupported = pushSupport(); if (unsupported) throw new SetupError('support', unsupported);
  // Keep the permission call on the user gesture, before network awaits.
  let permission: NotificationPermission;
  try { permission = await Notification.requestPermission(); }
  catch (e) { throw new SetupError('permission', 'Android didn’t show the permission prompt. Try again, or turn notifications on in App info.', e); }
  if (permission === 'denied') throw new SetupError('permission', BLOCKED_HELP);
  if (permission !== 'granted') throw new SetupError('permission', 'Notifications weren’t allowed. Tap Enable again and choose Allow.');
  const oldId = deviceId();
  const config = request<{ publicKey: string }>('/api/notifications/config').catch((e) => {
    throw new SetupError('server', e instanceof PhoneRequestError ? e.message : 'Couldn’t reach your Mac. Check that it’s awake and connected, then try again.', e);
  });
  const registration = withTimeout(
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready),
    15_000, 'worker', 'The app’s background worker didn’t start. Close Aside completely, reopen it, and try again.',
  ).catch((e) => { throw e instanceof SetupError ? e : new SetupError('worker', 'The app’s background worker couldn’t install. Close Aside completely, reopen it, and try again.', e); });
  const [{ publicKey }, reg, previous] = await Promise.all([config, registration, oldId ? lookupDevice(oldId).catch(() => null) : Promise.resolve(null)]);
  let subscription = await reg.pushManager.getSubscription();
  // A 410-expired endpoint can linger in Chrome; reconnect on this explicit tap.
  if (subscription && !previous) { await subscription.unsubscribe().catch(() => {}); subscription = null; }
  if (!subscription) {
    try {
      subscription = await withTimeout(
        reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }),
        20_000, 'subscribe', 'Google’s push service didn’t answer. Check your connection (a VPN can block it) and try again.',
      );
    } catch (e) {
      if (e instanceof SetupError) throw e;
      throw new SetupError('subscribe', 'Chrome couldn’t register for push. Make sure Chrome and Google Play services are up to date, then try again.', e);
    }
  }
  let d: NotificationDevice;
  try { d = await request<NotificationDevice>('/api/notifications/subscribe', 'POST', { subscription: subscription.toJSON(), preferences: previous?.preferences }); }
  catch (e) { throw new SetupError('server', e instanceof PhoneRequestError ? e.message : 'Your Mac didn’t save this phone. Try again.', e); }
  localStorage.setItem(DEVICE_KEY, d.id);
  if (previous && previous.id !== d.id) void request(`/api/notifications/devices/${previous.id}`, 'DELETE').catch(() => {});
  return d;
}
export async function disablePhoneNotifications(): Promise<void> {
  const id = deviceId(); if (id) await request(`/api/notifications/devices/${id}`, 'DELETE');
  const reg = await navigator.serviceWorker.getRegistration('/');
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
  localStorage.removeItem(DEVICE_KEY);
}
export function updatePhoneNotifications(prefs: Partial<NotificationPreferences>) { return request<NotificationDevice>(`/api/notifications/devices/${deviceId()}`, 'PATCH', prefs); }
export async function testPhoneNotification() { const r = await request<{ accepted: number; failed: number }>(`/api/notifications/devices/${deviceId()}/test`, 'POST', {}); if (!r.accepted) throw new Error('The push service did not accept the test. Try reconnecting notifications.'); }
export function replyFromNotice(sessionId: string, text: string, requestId: string) { return request('/api/notifications/reply', 'POST', { sessionId, text, requestId }); }
/** The conversation on screen right now; null on Home, Settings and Next. */
let viewing: string | null = null;
export function setViewingSession(sessionId: string | null): void { viewing = sessionId; }
export function viewingSession(): string | null { return viewing; }
/** This conversation is on screen, so the shade card can stop pointing at it. */
export function markNoticeSeen(sessionId: string): void {
  if (!('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.getRegistration('/').then(reg => reg?.active?.postMessage({ type: 'aside:notice-seen', sessionId }), () => {});
}
export function openNotice(sessionId: string, draft?: string) { window.dispatchEvent(new CustomEvent('aside:open-notification', { detail: { sessionId, draft } })); }
/** Recover a failed shade reply without copying the app's auth into a worker. */
export async function recoverNoticeDraft(sessionId: string): Promise<string | null> {
  if (!new URLSearchParams(location.hash.replace(/^#/, '')).has('notificationReply')) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const worker = reg?.active; if (!worker) return null;
  const ask = (clear: boolean): Promise<{ draft?: { text?: string; at?: number } }> => new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve({}); }, 1_000);
    channel.port1.onmessage = e => { clearTimeout(timer); channel.port1.close(); resolve(e.data); };
    worker.postMessage({ type: 'aside:notification-draft', sessionId, clear }, [channel.port2]);
  });
  const result = await ask(false);
  const text = result.draft?.text;
  if (typeof text !== 'string' || Date.now() - (result.draft?.at ?? 0) > 24 * 3_600_000) return null;
  return text;
}

/** Clear only after the target conversation accepted the text into its composer. */
export async function clearNoticeDraft(sessionId: string): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  reg?.active?.postMessage({ type: 'aside:notification-draft', sessionId, clear: true });
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (hash.get('session') === sessionId) { hash.delete('notificationReply'); history.replaceState(null, '', location.pathname + location.search + '#' + hash.toString()); }
}
