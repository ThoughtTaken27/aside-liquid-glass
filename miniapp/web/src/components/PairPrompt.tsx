import { useState } from 'react';
import { api } from '../api';
import { storeName, storeToken } from '../standalone';
import { haptic } from '../telegram';

/**
 * Pairing an installed app that has no code in its URL.
 *
 * Every install needs this now: pairing codes are one-time and expire
 * after ten minutes, so there is nothing durable to bake into the APK.
 * Both platforms paste one fresh link from the Mac's pairing page into
 * this screen on first run.
 *
 * Tapping the QR link on the phone opens the tailnet URL *in Safari*, and
 * pairing there writes the session into Safari's storage. Adding the app
 * to the Home Screen then produces something with its own separate
 * storage, launched at the manifest's `start_url` with the `#pair=`
 * fragment stripped. So the new icon opens to an app that has never seen
 * a code, and cannot be handed one, because re-scanning the QR just opens
 * Safari again. Without this screen that is a dead end.
 *
 * Accepting the whole link rather than only the code is the point. The
 * realistic way this gets across is Universal Clipboard -- copy the link
 * on the Mac, paste on the phone -- and asking someone to first edit the
 * code out of a URL would be a poor reward for that.
 */
export function PairPrompt({
  onPaired,
}: {
  onPaired: (token: string, name?: string) => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = extractPairingKey(value);

  const submit = async () => {
    if (!key || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.pair(key);
      storeToken(res.token);
      if (res.name) storeName(res.name);
      haptic('success');
      onPaired(res.token, res.name);
    } catch (err) {
      haptic('error');
      const status = (err as { status?: number }).status;
      setError(
        status === 401
          ? 'That link was rejected or already used. Generate a fresh one on your Mac.'
          : "Couldn't reach your Mac. Check it's awake and on the same tailnet.",
      );
      setBusy(false);
    }
  };

  return (
    <form
      className="pair-prompt destination-surface"
      data-surface="destination"
      data-destination="pairing"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        className="pair-prompt-input surface-row"
        data-surface-row="input"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        placeholder="Paste the pairing link"
        /*
         * Every one of these is off for a reason. iOS will happily
         * capitalise, autocorrect and spell-check a hex string into
         * something that no longer matches, and the failure would surface
         * as a flat rejection with no hint that the text was altered.
         */
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
        inputMode="url"
        enterKeyHint="go"
        disabled={busy}
        aria-label="Pairing link or key"
      />
      <button
        type="submit"
        className="pair-prompt-go surface-row"
        data-surface-row="submit"
        disabled={!key || busy}
      >
        {busy ? 'Pairing…' : 'Pair'}
      </button>
      {error ? (
        <p
          className="pair-prompt-error surface-meta"
          data-surface-meta="error"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Find a pairing code in whatever got pasted.
 *
 * Handles the full link, the bare code, and the link with surrounding
 * whitespace that a copy off a terminal tends to bring with it. Returns
 * null rather than guessing when the text holds nothing code-shaped, so
 * the button stays disabled instead of sending a request that cannot
 * succeed. Codes are base64url, so the shape is deliberately loose: the
 * server is the authority on whether one is live.
 */
export function extractPairingKey(input: string): string | null {
  const text = input.trim();
  if (!text) return null;

  // `pair=` in either a query string or a fragment.
  const tagged = /[#?&]pair=([A-Za-z0-9_-]{16,64})/.exec(text);
  if (tagged) return tagged[1];

  // A bare code, possibly the only thing on the clipboard.
  if (/^[A-Za-z0-9_-]{16,64}$/.test(text)) return text;

  return null;
}
