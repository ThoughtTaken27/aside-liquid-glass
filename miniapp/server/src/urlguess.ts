/**
 * Is this text a destination or a search?
 *
 * Every address bar has to answer this on every keystroke, and the answer
 * is a judgement call rather than a parse. `node.js streams` contains a
 * dot. `localhost:3000` contains no dot at all and is definitely a
 * destination. Getting it wrong in the permissive direction is the worse
 * failure: a wrongly-guessed URL sends you to a dead domain and loses the
 * query, while a wrongly-guessed search still shows you the site you meant
 * as the first result.
 *
 * So this stays strict. Anything with whitespace is a search, and a bare
 * `host.tld` only counts when the TLD looks like one.
 *
 * Deliberately duplicated from the client's `utils/openUrl.ts` rather than
 * shared through a package: the server and the web app have separate build
 * graphs here, and a shared module would mean a build-order dependency
 * between them for forty lines of regex. `urlguess.test.ts` asserts the two
 * agree, which is the property that actually matters.
 */
export function asUrl(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;

  if (/^https?:\/\//i.test(text)) {
    try {
      return new URL(text).href;
    } catch {
      return null;
    }
  }

  if (/^localhost(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;

  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(text)) {
    return `https://${text}`;
  }

  return null;
}

/**
 * Google's mobile result page, in embeddable mode.
 *
 * `igu=1` is the whole trick. Google omits `X-Frame-Options` for it, which
 * is what allows the real result page to be rendered inside the app rather
 * than scraped and redrawn. It is an undocumented parameter that has worked
 * since at least 2012, and it has one visible side effect: the page is
 * served signed-out. That costs personalised results and gains a page that
 * loads in a few hundred milliseconds from the phone itself.
 *
 * `hl`/`gl` are pinned so the page does not drift with whatever Google
 * infers from the network, and the vertical is Google's own `udm`, so the
 * app's tabs and Google's tabs cannot disagree.
 */
export const SEARCH_UDM: Record<string, string | null> = {
  web: null,
  images: '2',
  videos: '7',
  news: '12',
  shopping: '28',
};

export function googleSearchUrl(
  query: string,
  opts: { vertical?: string; hl?: string; gl?: string } = {},
): string {
  const params = new URLSearchParams();
  params.set('q', query);
  params.set('igu', '1');
  params.set('hl', opts.hl ?? 'en');
  params.set('gl', opts.gl ?? 'us');
  const udm = SEARCH_UDM[opts.vertical ?? 'web'];
  if (udm) params.set('udm', udm);
  return `https://www.google.com/search?${params.toString()}`;
}
