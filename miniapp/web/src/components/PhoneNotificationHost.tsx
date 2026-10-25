import { useEffect } from 'react';
import { markNoticeSeen, viewingSession, type PhoneNotice } from '../phoneNotifications';
/*
 * No banners inside the app. Live status belongs in the notification shade,
 * the way an ongoing task does in Claude or ChatGPT: pull down to see what
 * Aside is doing, and nothing slides over the screen you are using.
 *
 * The worker still asks before it draws, and the answer keeps the shade
 * quiet: while the app is on screen every redraw is silent. A reply that
 * lands in the conversation you are reading has nothing to tell you, so it
 * is cleared from the card a moment after Chrome's push contract is met.
 */
export function PhoneNotificationHost() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const onMessage = (e: MessageEvent) => {
      const p = e.data?.notice as PhoneNotice | undefined;
      if (e.data?.type !== 'aside:phone-notice' || !p || p.version !== 1 || document.visibilityState !== 'visible') return;
      const viewing = viewingSession();
      e.ports[0]?.postMessage({ shown: true, viewing });
      if (p.kind !== 'progress' && p.sessionId && p.sessionId === viewing) {
        const timer = setTimeout(() => { timers.delete(timer); if (viewingSession() === viewing) markNoticeSeen(viewing); }, 1_500);
        timers.add(timer);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => { navigator.serviceWorker.removeEventListener('message', onMessage); timers.forEach(clearTimeout); };
  }, []);
  return null;
}
