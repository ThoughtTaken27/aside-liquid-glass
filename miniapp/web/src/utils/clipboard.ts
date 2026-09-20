/**
 * Copy text to the clipboard, from inside a Telegram webview.
 *
 * There is no Telegram API for this -- the WebApp SDK can READ the
 * clipboard (`readTextFromClipboard`) but never write to it, so this is the
 * browser's job, and the browser is a WKWebView or an Android WebView with
 * the usual caveats:
 *
 *  - `navigator.clipboard.writeText` is the real path, but it only exists
 *    in a secure context (fine -- the tunnel is https) AND only resolves
 *    when called during a user gesture. Called from a timeout or a promise
 *    continuation it rejects with `NotAllowedError`.
 *  - Older Android WebViews do not expose `navigator.clipboard` at all.
 *
 * So: try the real API, fall back to the `execCommand` trick, and report
 * honestly which one worked rather than assuming success. A copy button
 * that flashes a checkmark without copying anything is worse than one that
 * does nothing, because the user walks away believing they have the text.
 *
 * The fallback's `<textarea>` deliberately sits at the top-left with
 * `position: fixed` and no size rather than off-screen at -9999px: on iOS,
 * focusing an element outside the viewport scrolls the page to reach it,
 * which yanks the thread out from under the reader mid-tap.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through: permission denied, or not in a gesture. The legacy
      // path below is frequently still allowed in exactly that case.
    }
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.width = '1px';
    area.style.height = '1px';
    area.style.padding = '0';
    area.style.border = 'none';
    area.style.opacity = '0';
    document.body.appendChild(area);

    // iOS ignores `select()` on a readonly textarea and needs the explicit
    // range, which is the one incantation that makes this work there.
    area.contentEditable = 'true';
    const range = document.createRange();
    range.selectNodeContents(area);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    area.setSelectionRange(0, text.length);

    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
