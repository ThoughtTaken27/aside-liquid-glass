import { useEffect, useState } from 'react';
import { Bell, ChevronRight } from 'lucide-react';
import { BLOCKED_HELP, deviceId, disablePhoneNotifications, enablePhoneNotifications, notificationsBlocked, pushSupport, readNotificationDevice, reportSetupFailure, testPhoneNotification, updatePhoneNotifications, type NotificationDevice } from '../phoneNotifications';
import '../theme/notifications.css';
export function NotificationSettings() {
  const [device, setDevice] = useState<NotificationDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [tested, setTested] = useState(false);
  const unsupported = pushSupport();
  /*
   * A blocked permission used to disable the button and leave a grey
   * sentence -- which reads as "broken". It stays tappable, says exactly
   * where the switch is, and re-checks the moment Aside comes back to the
   * foreground from Android's settings.
   */
  const [blocked, setBlocked] = useState(notificationsBlocked);
  useEffect(() => {
    const recheck = () => { if (document.visibilityState === 'visible') setBlocked(notificationsBlocked()); };
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);
    return () => { document.removeEventListener('visibilitychange', recheck); window.removeEventListener('focus', recheck); };
  }, []);
  useEffect(() => {
    if (unsupported || !deviceId()) { setChecking(false); return; }
    let live = true;
    void readNotificationDevice().then(d => { if (live) setDevice(d); }, e => { if (live) setError(e.message); }).finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, []); // permission is refreshed when this settings screen is reopened
  const act = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await fn(); } catch (e) { reportSetupFailure(e); setError(e instanceof Error ? e.message : 'Could not update notifications.'); setBlocked(notificationsBlocked()); } finally { setBusy(false); } };
  return <section className="settings-section notification-settings" aria-labelledby="phone-notifications-title">
    <h2 className="settings-heading" id="phone-notifications-title">Notifications</h2>
    <div className="notification-connect">
      <div className="notification-connect-top">
        <Bell size={21} strokeWidth={1.7} aria-hidden />
        <span className="notification-connect-title">{device ? 'Connected to this phone' : 'Live status on this phone'}</span>
      </div>
      <p className="notification-connect-copy">{device ? 'Replies and questions arrive here, not in Telegram. Tap an alert to open its conversation.' : 'See what Aside is doing while it works, then get an alert when the reply is ready or it needs you, even with Aside closed.'}</p>
      {!device ? <button className="notification-enable" disabled={busy || checking || Boolean(unsupported)} onClick={() => void act(async () => setDevice(await enablePhoneNotifications()))}>
        {busy ? 'Connecting…' : checking ? 'Checking…' : blocked ? 'Try again' : 'Enable on this phone'}<ChevronRight size={16} aria-hidden />
      </button> : null}
    </div>
    {device ? <div className="settings-rows surface-group notification-preferences">
      <Preference title="Show summaries" description="Include the conversation title and a short preview on your lock screen." checked={device.preferences.previews} disabled={busy} onChange={() => void act(async () => setDevice(await updatePhoneNotifications({ previews: !device.preferences.previews })))} />
      <Preference title="Live status while working" description="A silent notification that follows each step, then turns into the reply alert." checked={device.preferences.progress} disabled={busy} onChange={() => void act(async () => setDevice(await updatePhoneNotifications({ progress: !device.preferences.progress })))} />
      <button className="notification-setting-action" disabled={busy} onClick={() => void act(async () => { await testPhoneNotification(); setTested(true); })}><span>{tested ? 'Send another test' : 'Send a test notification'}</span><ChevronRight size={16} aria-hidden /></button>
      <button className="notification-setting-action" disabled={busy} onClick={() => void act(async () => { await disablePhoneNotifications(); setDevice(null); setTested(false); })}>Turn off on this phone</button>
    </div> : null}
    {unsupported || error || (blocked && !device) ? <p className="notification-help" role={error ? 'alert' : undefined}>{error || unsupported || BLOCKED_HELP}</p> : null}
    {tested ? <p className="notification-help" role="status">The push service accepted the test. Check this banner or your notification shade to confirm delivery.</p> : null}
    <p className="settings-note">Summaries stay private unless you turn them on. Android controls banners, sounds and lock-screen visibility. Your Mac needs to be awake and connected.</p>
  </section>;
}
function Preference({ title, description, checked, disabled, onChange }: { title: string; description: string; checked: boolean; disabled: boolean; onChange: () => void }) {
  return <div className="settings-row surface-row notification-preference">
    <span className="settings-row-text"><span className="settings-row-title">{title}</span><span className="settings-row-description">{description}</span></span>
    <button className={'switch' + (checked ? ' is-on' : '')} role="switch" aria-label={title} aria-checked={checked} disabled={disabled} onClick={onChange}><span className="switch-knob" /></button>
  </div>;
}
