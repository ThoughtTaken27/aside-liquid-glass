/**
 * The sites a run of steps touched, as Thinking State-style chips.
 *
 * Read from what the steps already carry: a fetch's URL, a browser call's
 * code, a search's result text. Nothing is fetched to build them -- no
 * favicon service hears which sites the agent read -- and private or local
 * hosts never become a chip, so a screenshot of a thread does not leak a
 * home network or a dev server.
 */
import type { WorkStep } from '../types';

export interface StepSource {
  host: string;
  url: string;
}

const URL_RE = /https?:\/\/[^\s"'<>`)\]}]+/gi;

const WEB_TOOLS = new Set(['webfetch', 'websearch', 'repl', 'openTab', 'WebFetch', 'WebSearch']);

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (!h.includes('.')) return true;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (h.endsWith('.ts.net') || h.endsWith('.workers.dev')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  return false;
}

export function displayHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
}

/** Unique public sites, first-seen order, at most `limit`. */
export function sourcesFor(steps: WorkStep[], limit = 12): StepSource[] {
  const seen = new Map<string, StepSource>();
  for (const step of steps) {
    if (!WEB_TOOLS.has(step.tool)) continue;
    const texts = [step.detail?.command || '', step.label || ''];
    // Search output lists its results; reading a page's text would also
    // pick up every link on that page, so only searches contribute it.
    if (/search/i.test(step.tool)) texts.push(step.detail?.output || '');
    for (const text of texts) {
      for (const match of text.matchAll(URL_RE)) {
        let parsed: URL;
        try {
          parsed = new URL(match[0].replace(/[.,;:!?]+$/, ''));
        } catch {
          continue;
        }
        if (isPrivateHost(parsed.hostname)) continue;
        const host = displayHost(parsed.hostname);
        if (!seen.has(host)) seen.set(host, { host, url: parsed.href });
        if (seen.size >= limit) return [...seen.values()];
      }
    }
  }
  return [...seen.values()];
}

/** The letter a site's tile shows: its registrable name's first letter. */
export function monogram(host: string): string {
  const parts = host.split('.');
  const name = parts.length > 2 && parts[parts.length - 2].length <= 3
    ? parts[parts.length - 3]
    : parts[Math.max(0, parts.length - 2)];
  return (name || host).charAt(0).toUpperCase();
}
