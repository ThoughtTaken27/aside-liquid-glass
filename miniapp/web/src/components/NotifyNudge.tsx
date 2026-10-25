/**
 * One-tap notification setup on the home screen.
 *
 * Settings is two taps behind the model sheet, so the only switch for
 * notifications was effectively invisible: in practice the phone never
 * once reached the Mac's notification routes. This puts the same setup
 * where the eye already is, once, until it is on or dismissed.
 *
 * Visibility is decided synchronously from local state, so the centred
 * greeting never hops when the card arrives.
 */
import { useEffect, useRef, useState } from 'react';
import { Collapse } from './Collapse';
import { Bell, Check, X } from 'lucide-react';
import { BLOCKED_HELP, deviceId, enablePhoneNotifications, notificationsBlocked, pushSupport, reportSetupFailure } from '../phoneNotifications';
import { isStandaloneEntry } from '../standalone';
import '../theme/notifications.css';

const DISMISS_KEY = 'aside.notifyNudge.v1';

export function nudgeWanted(): boolean {
  try {
    return isStandaloneEntry() && !pushSupport() && !deviceId() && localStorage.getItem(DISMISS_KEY) !== 'dismissed';
  } catch {
    return false;
  }
}

type Phase = 'idle' | 'busy' | 'done' | 'leaving' | 'gone';

export function NotifyNudge() {
  const [phase, setPhase] = useState<Phase>(() => (nudgeWanted() ? 'idle' : 'gone'));
  const [error, setError] = useState('');
  const lastHelp = useRef('');
  const [blocked, setBlocked] = useState(notificationsBlocked);

  useEffect(() => {
    if (phase === 'gone') return;
    const recheck = () => { if (document.visibilityState === 'visible') setBlocked(notificationsBlocked()); };
    document.addEventListener('visibilitychange', recheck);
    return () => document.removeEventListener('visibilitychange', recheck);
  }, [phase]);

  useEffect(() => {
    if (phase === 'done') { const t = setTimeout(() => setPhase('leaving'), 1800); return () => clearTimeout(t); }
    if (phase === 'leaving') { const t = setTimeout(() => setPhase('gone'), 260); return () => clearTimeout(t); }
  }, [phase]);

  if (phase === 'gone') return null;

  const turnOn = async () => {
    if (phase !== 'idle') return;
    setPhase('busy'); setError('');
    try { await enablePhoneNotifications(); setPhase('done'); }
    catch (e) {
      reportSetupFailure(e);
      setError(e instanceof Error ? e.message : 'Couldn’t turn on notifications. Try again.');
      setBlocked(notificationsBlocked());
      setPhase('idle');
    }
  };
  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, 'dismissed'); } catch { /* still hide for this run */ }
    setPhase('leaving');
  };

  const done = phase === 'done' || phase === 'leaving';
  const help = error || (blocked ? BLOCKED_HELP : '');
  if (help) lastHelp.current = help;
  return (
    <div className={`notify-nudge${phase === 'leaving' ? ' is-leaving' : ''}`} role="group" aria-label="Notifications">
      <div className="notify-nudge-inner">
        <div className="notify-nudge-row">
          <span className="notify-nudge-mark" aria-hidden>{done ? <Check size={18} strokeWidth={2} /> : <Bell size={18} strokeWidth={1.75} />}</span>
          <span className="notify-nudge-text">
            <span className="notify-nudge-title">{done ? 'Live status is on' : 'Live status'}</span>
            <span className="notify-nudge-sub">{done ? 'Each step shows up, then the reply.' : 'Follow tasks from your notifications.'}</span>
          </span>
          {done ? null : (
            <>
              <button type="button" className="notify-nudge-on" onClick={() => void turnOn()} disabled={phase === 'busy'}>
                {phase === 'busy' ? 'Turning on…' : error || blocked ? 'Try again' : 'Turn on'}
              </button>
              <button type="button" className="notify-nudge-dismiss" aria-label="Not now" onClick={dismiss}>
                <X size={16} strokeWidth={1.75} />
              </button>
            </>
          )}
        </div>
        <Collapse open={Boolean(help) && !done}>
          <p className="notify-nudge-help" role={help && !done ? 'alert' : undefined}>{lastHelp.current}</p>
        </Collapse>
      </div>
    </div>
  );
}
