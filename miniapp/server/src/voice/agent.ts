/**
 * Full Aside tasks from the phone, with limits Aside itself enforces.
 *
 * Two kinds of task, each run only in a pre-locked session from the voice
 * standby pool (armed.ts): rules are written, then the session sits idle
 * past Aside's 10-minute unload so the daemon -- not the model -- checks
 * every tool call, page action, and network request against them.
 *
 *  - research: the public web only. No clicking or typing, no files,
 *    memory, logins, or shell. Starts straight from a spoken question.
 *  - act: can use websites, but never email, accounts, money sites, code
 *    hosts or Common App, and no shell, files, downloads, or raw network.
 *    It is told to stop before any final submit. Starts only after the
 *    phone sends a ticket signed by the fingerprint-bound action key for
 *    this exact request (routes.ts verifies it).
 *
 * No locked session ready -> no task. There is no unlocked fallback.
 */

export type VoiceTaskKind = 'research' | 'act';

export interface VoiceTaskStatus {
  state: 'running' | 'done' | 'failed';
  /** The agent's current step title, never its arguments. */
  step: string | null;
  /** Speakable summary (before the --- divider). */
  say: string | null;
  /** The rest of the answer, for the card. */
  detail: string | null;
  /** How many actions Aside refused during the task. */
  denied: number;
}

export interface VoiceAgent {
  /** Plain-words limits for the confirm card. */
  limits(kind: VoiceTaskKind): string;
  /** Minutes until a locked session of this kind is ready; 0 = ready now. */
  readyIn(kind: VoiceTaskKind): number | null;
  start(kind: VoiceTaskKind, request: string): Promise<{ taskId: string } | { error: 'warming'; readyInMin: number | null } | { error: 'failed' }>;
  status(taskId: string): VoiceTaskStatus | null;
  stop(taskId: string): boolean;
}

const RESEARCH =
  /\b(research|look into|dig into|deep dive|investigate|compare|find (me )?(the )?(best|cheapest|top|good|latest|most)|what are the best|which is better|pros and cons|reviews? (of|for)|summari[sz]e (the )?(news|latest)|latest news (on|about))\b/i;
/** Doing something on a website for him. Email/money/accounts are refused by the rules anyway. */
const LEAD = String.raw`^\s*(?:(?:hey )?aside[, ]+)?(?:please |can you |could you |go ahead and |i (?:want|need) you to )?`;
const ACT = new RegExp(LEAD + String.raw`(?:book|reserve|fill (?:out|in)|sign (?:me )?up|register|apply|order|buy|purchase|add .{1,40} to (?:my )?cart|cancel my|schedule)\b`, 'i');
/** Web errands that only count when a website or the Mac is named ("go to amazon.com and ..."). */
const ACT_WEB = new RegExp(LEAD + String.raw`(?:download|install|subscribe|unsubscribe|go to .{1,60} and|open .{1,60} and)\b`, 'i');
const WEBSITE = /\b(website|web ?site|web ?page|online|[a-z0-9-]+\.(?:com|org|net|io|edu|gov|co|app))\b/i;
/** He named the Mac ("on my laptop", "using the browser"). */
export const MAC_EXPLICIT = /\b(?:on|using|with|from|in) (?:my |the )?(?:mac|macbook|laptop|computer|desktop|browser)\b/i;
/**
 * Things that live on the phone (Owner, Oct 6: most of what he asks for is on his phone). These never
 * become Mac tasks unless he names the Mac. The phone handles them, or says plainly what it can't do.
 */
export const PHONE_FIRST =
  /\b(play(?:ing)?|listen(?:ing)? to|watch(?:ing)?|put on|youtube|yt music|spotify|music|songs?|album|playlist|podcasts?|videos?|maps?|directions|navigate|take me to|alarms?|timers?|flashlight|torch|volume|wi-?fi|bluetooth|camera|photos?|selfie|screenshot|instagram|snapchat|tiktok|reels?|apps?|my phone)\b/i;

const PHONE_TALK = /\b(text(ing)?|message|messages app|msg|sms|whats ?app|imessage|call|dial|ring|facetime)\b/i;

/** Which kind of Aside task a spoken request is, or null for the normal voice lanes. */
export function classifyTask(text: string): VoiceTaskKind | null {
  // Messages and calls belong to the phone (it opens the draft or dialer), never to the Mac.
  if (PHONE_TALK.test(text)) return null;
  const mac = MAC_EXPLICIT.test(text);
  // Research only reads, so "find the best podcast apps" may still go to the Mac; doing never does.
  if (RESEARCH.test(text) && !/\b(play|put on|open|watch|listen)\b/i.test(text)) return 'research';
  if (PHONE_FIRST.test(text) && !mac) return null;
  if (ACT.test(text)) return 'act';
  if (ACT_WEB.test(text) && (mac || WEBSITE.test(text))) return 'act';
  return null;
}

/** The task prompt. The phone's text is quoted as the request, never as instructions about limits. */
export function taskPrompt(kind: VoiceTaskKind, request: string): string {
  const spoken =
    'This request was spoken on Owner’s phone and will be read aloud. Start your final answer with one to three short, natural sentences that carry the real result (names, numbers, prices), then a line containing only ---, then any detail and the source links. No preamble.';
  const limits =
    kind === 'research'
      ? 'Research only: read and report. Do not click, type, sign in, or submit anything.'
      : 'Do the task in the browser, but stop BEFORE any final step that sends, submits, pays, books, or confirms. Describe exactly what is left for Owner to tap. Never enter passwords or payment details.';
  return `${spoken}\n${limits}\n\nRequest: “${request.replace(/[“”"]/g, "'").slice(0, 400)}”`;
}

/** Split an agent reply on the spoken/detail divider. */
export function splitReply(text: string | null): { say: string | null; detail: string | null } {
  if (!text) return { say: null, detail: null };
  const clean = text.replace(/\r/g, '').trim();
  const parts = clean.split(/\n\s*---+\s*\n/);
  const say = parts[0].replace(/[*_#`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
  const detail = parts.length > 1 ? parts.slice(1).join('\n').trim().slice(0, 1500) || null : null;
  return { say, detail };
}
