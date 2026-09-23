import { useEffect, useState } from 'react';
import {
  isOnBackup,
  isPrimaryBack,
  navigateToRelay,
  primaryRelay,
} from '../relays';

/** How often a page on the backup re-checks whether the primary is back. */
const RECHECK_MS = 60_000;

/**
 * Failover status for a page living on a backup relay.
 *
 * Invisible on the primary and in Telegram: `isOnBackup` is false there,
 * because the meta tag either names this origin first or does not exist.
 * On a backup it shows a slim note -- the owner should know the primary is
 * down rather than wondering why the app feels different -- and it polls
 * the primary so the moment it answers again the banner offers the way
 * back. The switch is always the owner's tap, never automatic: dropping
 * them mid-thread the instant the primary flickers would be worse than
 * staying put.
 */
export function RelayBanner() {
  // The origin cannot change without a reload, so this is mount-time state.
  const [onBackup] = useState(isOnBackup);
  const [primaryBack, setPrimaryBack] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!onBackup) return;
    let cancelled = false;
    const check = async () => {
      try {
        if (!cancelled && (await isPrimaryBack())) setPrimaryBack(true);
      } catch {
        // A failed probe is information, not an error: the primary is
        // still down and the banner stays as it is until the next check.
      }
    };
    void check();
    const timer = setInterval(check, RECHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [onBackup]);

  if (!onBackup || dismissed) return null;

  const primary = primaryRelay();
  return (
    <aside className="relay-banner" role="note">
      <span className="relay-banner-dot" aria-hidden="true" />
      <p className="relay-banner-text">
        {primaryBack ? 'Primary address is back.' : 'On the backup address.'}
      </p>
      {primaryBack && primary && (
        <button
          type="button"
          className="relay-banner-switch"
          onClick={() => navigateToRelay(primary)}
        >
          Switch
        </button>
      )}
      <button
        type="button"
        className="relay-banner-close"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </aside>
  );
}
