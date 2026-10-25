/* Web Push only: never caches API responses or puts app credentials in storage. */
const PHONE_KINDS = new Set(['ready', 'needs-input', 'error', 'progress', 'test']);
const PHONE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;
function validNotice(p) { return p && p.version === 1 && typeof p.id === 'string' && typeof p.title === 'string' && typeof p.body === 'string' && PHONE_KINDS.has(p.kind) && Number.isFinite(p.expiresAt) && p.expiresAt > Date.now() && (p.topic === undefined || typeof p.topic === 'string') && (!p.sessionId || PHONE_SESSION.test(p.sessionId)); }
/*
 * One card, always. Every Aside notice (live status, replies, questions,
 * errors) lands on the single 'aside' tag, so Android shows one notification
 * that changes in place instead of a stack of "Reply ready" rows.
 *
 * The card carries its own state in `data.feed`: the tasks still running and
 * the finished ones not yet read. Each push merges into that feed and the
 * card is redrawn from it. Live steps redraw silently; a finished task rings.
 * Swiping the card away or tapping it forgets the feed, and opening a
 * conversation in the app drops that conversation from it.
 *
 * Live status is quiet by design, like an ongoing task in Claude or ChatGPT:
 * it never makes a sound, never peeks over the screen, and while the app is
 * open nothing rings at all. Only a finished task, with the app closed, alerts.
 *
 * `icon` is a fully transparent square. Android already draws the app icon
 * on the left; with no icon Chrome fills the right side with a grey letter
 * avatar made from the site's address, and the logo there would be a copy.
 */
const CARD_TAG = 'aside';
const LIVE_STALE_MS = 6 * 60_000; // a live task silent past the 4 min heartbeat is gone
const BADGE = '/icons/notification-badge.png';
const ICON = '/icons/notification-blank.png';
function emptyFeed() { return { live: [], done: [] }; }
function feedOf(n) {
  const f = n && n.data && n.data.feed;
  return f && Array.isArray(f.live) && Array.isArray(f.done) ? { live: f.live.slice(0, 8), done: f.done.slice(0, 8) } : emptyFeed();
}
async function currentCard() {
  try { const [n] = await self.registration.getNotifications({ tag: CARD_TAG }); return n || null; } catch { return null; }
}
function withoutSession(feed, id) { const keep = t => (t.sessionId || 'test') !== id; return { live: feed.live.filter(keep), done: feed.done.filter(keep) }; }
function mergeNotice(feed, p, now) {
  const id = p.sessionId || 'test';
  const next = withoutSession(feed, id);
  const entry = { sessionId: p.sessionId, id: p.id, kind: p.kind, title: p.title, body: p.body, topic: p.topic, at: now };
  if (p.kind === 'progress') next.live.unshift({ ...entry, phase: p.phase || p.body, startedAt: Number.isFinite(p.startedAt) ? p.startedAt : now });
  else next.done.unshift(entry);
  next.live = next.live.filter(t => now - t.at < LIVE_STALE_MS).slice(0, 8);
  next.done = next.done.slice(0, 8);
  return next;
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
function doneHeadline(done) {
  const asks = done.filter(t => t.kind === 'needs-input').length, fails = done.filter(t => t.kind === 'error').length, replies = done.length - asks - fails;
  return [replies && plural(replies, 'reply', 'replies') + ' ready', asks && plural(asks, 'question', 'questions'), fails && plural(fails, 'task needs a look', 'tasks need a look')].filter(Boolean).join(' · ');
}
/** Draws the one card from its feed. `alert` is true only when a task just finished. */
function renderCard(feed, alert) {
  const { live, done } = feed;
  const base = { tag: CARD_TAG, badge: BADGE, icon: ICON, renotify: alert, silent: !alert };
  const liveLine = live.length === 0 ? '' : live.length === 1 ? 'Still working · ' + live[0].phase : 'Still working on ' + live.length + ' tasks';
  if (done.length === 1) {
    const t = done[0];
    const data = { ...t, version: 1, feed };
    const actions = !t.sessionId ? [] : t.kind === 'needs-input' ? [{ action: 'open', title: 'Answer' }] : [
      { action: 'reply', type: 'text', title: 'Reply', placeholder: 'Message Aside…' }, { action: 'open', title: 'Open' }];
    return { title: t.topic || t.title, options: { ...base, body: [t.body, liveLine].filter(Boolean).join('\n'), timestamp: t.at, data, actions } };
  }
  if (done.length > 1) {
    const topics = done.map(t => t.topic).filter(Boolean);
    const body = topics.length ? topics.slice(0, 4).join(' · ') + (done.length > 4 ? ' · +' + (done.length - 4) : '') : 'From ' + done.length + ' conversations';
    return { title: doneHeadline(done), options: { ...base, body: [body, liveLine].filter(Boolean).join('\n'), timestamp: done[0].at, data: { version: 1, feed }, actions: [{ action: 'open', title: 'Open Aside' }] } };
  }
  if (live.length === 1) {
    const t = live[0];
    // What it is working on, then what it is doing right now.
    return { title: t.topic || 'Aside is working', options: { ...base, body: t.phase, timestamp: t.startedAt, data: { ...t, version: 1, feed }, actions: [] } };
  }
  const phases = [...new Set(live.map(t => t.phase))];
  return { title: 'Working on ' + live.length + ' tasks', options: { ...base, body: phases.slice(0, 3).join(' · '), timestamp: Math.min(...live.map(t => t.startedAt)), data: { version: 1, feed }, actions: [] } };
}
async function drawCard(feed, alert) {
  if (!feed.live.length && !feed.done.length) { const n = await currentCard(); if (n) n.close(); return; }
  const { title, options } = renderCard(feed, alert);
  try { await self.registration.showNotification(title, options); }
  catch { // Browsers without text actions get a plain tap-to-open card.
    options.actions = (options.actions || []).filter(a => a.type !== 'text');
    await self.registration.showNotification(title, options);
  }
}
/* Pushes, taps and app messages edit the same card: one at a time, so two
 * near-simultaneous pushes cannot each read the old feed and drop the other. */
let cardQueue = Promise.resolve();
function serial(fn) { const run = cardQueue.then(fn, fn); cardQueue = run.catch(() => {}); return run; }
/** Asks an open app window whether it is on screen; it shows nothing itself. */
async function askApp(client, p) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 500);
    channel.port1.onmessage = e => { clearTimeout(timer); channel.port1.close(); resolve(e.data?.shown === true ? e.data : null); };
    client.postMessage({ type: 'aside:phone-notice', notice: p }, [channel.port2]);
  });
}
self.addEventListener('push', event => event.waitUntil((async () => {
  let p; try { p = event.data?.json(); } catch { return; }
  if (!validNotice(p)) return;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const visible = clients.filter(c => c.visibilityState === 'visible' && new URL(c.url).origin === self.location.origin && new URL(c.url).pathname.startsWith('/app'));
  let inApp = false;
  for (const client of visible) if (await askApp(client, p)) { inApp = true; break; }
  // Chrome's userVisibleOnly contract still requires a shade notification.
  // With the app on screen that redraw is silent; the app clears a reply to
  // the conversation you are reading right after.
  await serial(async () => {
    const feed = mergeNotice(feedOf(await currentCard()), p, Date.now());
    await drawCard(feed, p.kind !== 'progress' && !inApp);
  });
})()));
function phoneDraftStore(operation, key, value) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('aside-notification-drafts', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('drafts');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('drafts', operation === 'get' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('drafts');
      const req = operation === 'put' ? store.put(value, key) : operation === 'delete' ? store.delete(key) : store.get(key);
      tx.oncomplete = () => { const result = req.result; db.close(); resolve(result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
async function openPhoneThread(p, draft = false) {
  const target = new URL('/app', self.location.origin);
  if (p.sessionId && PHONE_SESSION.test(p.sessionId)) target.hash = new URLSearchParams({ session: p.sessionId, ...(draft ? { notificationReply: '1' } : {}) }).toString();
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = clients.find(c => new URL(c.url).origin === target.origin && new URL(c.url).pathname === '/app');
  if (existing) { await existing.navigate(target.href); await existing.focus(); }
  else await self.clients.openWindow(target.href);
}
self.addEventListener('notificationclick', event => event.waitUntil((async () => {
  const p = event.notification.data;
  // Opening reads what the card showed; tasks still running stay on it, quietly.
  const keepLive = async () => {
    const feed = feedOf(event.notification);
    const rest = { live: p && p.sessionId ? feed.live.filter(t => t.sessionId !== p.sessionId) : feed.live, done: [] };
    if (rest.live.length) await serial(() => drawCard(rest, false));
  };
  if (!p || !p.sessionId || !PHONE_SESSION.test(p.sessionId)) { event.notification.close(); await keepLive(); await openPhoneThread({}); return; }
  if (event.action !== 'reply' || typeof event.reply !== 'string' || !event.reply.trim()) {
    event.notification.close(); await keepLive(); await openPhoneThread(p, p.replyDraft === true); return;
  }
  const text = event.reply.trim();
  // Save before network so a lost connection cannot lose what the user typed.
  try { await phoneDraftStore('put', p.sessionId, { text, at: Date.now(), requestId: p.id }); }
  catch { await openPhoneThread(p); return; }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch('/api/notifications/reply', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: p.sessionId, text, requestId: p.id }), signal: controller.signal });
    if (!res.ok) throw new Error('not_confirmed');
    const result = await res.json(); if (result.accepted !== true) throw new Error('not_confirmed');
    await phoneDraftStore('delete', p.sessionId);
    // The sent reply becomes a live task on the same card until Aside answers.
    await serial(() => drawCard(mergeNotice(feedOf(event.notification), { ...p, kind: 'progress', title: 'Message sent', body: 'Message sent', phase: 'Message sent', startedAt: Date.now() }, Date.now()), false));
  } catch {
    const recovery = { ...p, replyDraft: true, feed: withoutSession(feedOf(event.notification), p.sessionId) };
    await serial(() => self.registration.showNotification('Reply not confirmed', { body: 'Your draft is saved. Open the conversation and check before sending again.', badge: BADGE, icon: ICON, tag: CARD_TAG, renotify: true, data: recovery, actions: [{ action: 'open', title: 'Open draft' }] }));
  } finally { clearTimeout(timer); }
})()));
self.addEventListener('message', event => {
  if (!event.source?.url || new URL(event.source.url).origin !== self.location.origin) return;
  const m = event.data;
  // The app opened this conversation: its reply is read. Work still running
  // stays on the card, so the shade keeps showing what Aside is doing.
  if (m?.type === 'aside:notice-seen' && PHONE_SESSION.test(m.sessionId)) {
    event.waitUntil(serial(async () => {
      const n = await currentCard(); if (!n) return;
      const before = feedOf(n), after = { live: before.live, done: before.done.filter(t => (t.sessionId || 'test') !== m.sessionId) };
      if (after.done.length !== before.done.length) await drawCard(after, false);
    }));
    return;
  }
  if (m?.type !== 'aside:notification-draft' || !PHONE_SESSION.test(m.sessionId)) return;
  event.waitUntil(phoneDraftStore(m.clear ? 'delete' : 'get', m.sessionId).then(draft => event.ports[0]?.postMessage({ draft }), () => event.ports[0]?.postMessage({ draft: null })));
});
