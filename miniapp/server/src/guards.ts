/**
 * Hard guardrails for Next. Plain code, no model anywhere in this file.
 *
 *  1. No Claude in the background. Anything that runs without a tap
 *     (email sorting, the Jev first look, standby helpers) refuses a Claude
 *     model and falls back to Space Bunny.
 *  2. Mail scripts are read-only. Every script sent to `aside repl` for mail
 *     is checked before it runs: the only Gmail calls allowed are search and
 *     getThread, and the only page fetch allowed is Gmail's own read-only
 *     "Show original" summary. Anything else throws; nothing runs.
 *  3. Private mail never reaches any model. Sign-in codes, banks and money,
 *     government and immigration, health, security alerts, legal and tax,
 *     and family are recognised here, before Jev or Space Bunny see a byte.
 *     When in doubt it counts as private: a missed task costs little, a
 *     leaked code or visa notice costs a lot.
 */

// --------------------------------------------------------------------------
// 1. Models

export const SAFE_BACKGROUND_MODEL = '9router/oc/space-bunny-free';

/** True for any Claude model, on any route (plan, Bedrock, Anthropic, 9router aliases). */
export function isClaudeModel(model: string | null | undefined): boolean {
  if (!model) return false;
  return /claude|anthropic|\bhaiku\b|\bsonnet\b|\bopus\b|bedrock-claude|claude-code/i.test(model);
}

/** The model a background job may use: never Claude. */
export function backgroundModel(model: string | null | undefined, fallback = SAFE_BACKGROUND_MODEL): string {
  return !model || isClaudeModel(model) ? fallback : model;
}

// --------------------------------------------------------------------------
// 2. Read-only mail scripts

const ALLOWED_GMAIL = new Set(['search', 'getThread']);

/** Words that must never appear in a mail script, as calls or property reads. */
const FORBIDDEN = [
  // Any use of gmail other than .search( or .getThread( : brackets, aliases, spreads.
  /\bgmail\b(?!\s*\.\s*(search|getThread)\s*\()/,
  /\b(eval|Function|import)\s*\(|\bnew\s+Function\b|\bglobalThis\b|\bReflect\b|\bProxy\b/,
  /\bgoogleAccounts\s*\.\s*(?!list\s*\()\w+/,
  /\b(send|sendMessage|reply|forward|createDraft|saveDraft|draft|compose|trash|delete|archive|modify|batchModify|markAs\w*|addLabel|removeLabel|setLabel|snooze|mute|unsubscribe)\s*\(/i,
  /\.\s*(click|fill|type|press|check|uncheck|selectOption|setInputFiles|tap|dispatchEvent|dblclick|hover)\s*\(/i,
  /\b(keyboard|mouse)\s*\./i,
  /method\s*:\s*['"`](POST|PUT|PATCH|DELETE)/i,
  /\b(XMLHttpRequest|sendBeacon|WebSocket)\b/,
  /\b(vault|autofill|passwords?Manager)\b/i,
];

export class UnsafeMailScript extends Error {
  constructor(readonly why: string) {
    super(`unsafe mail script: ${why}`);
    this.name = 'UnsafeMailScript';
  }
}

export function assertReadOnlyMailScript(raw: string): void {
  // Data (addresses, queries, ids) is spliced in as JSON, in double quotes.
  // It cannot run, so it is blanked before checking; code keeps its words.
  const code = raw.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  for (const m of code.matchAll(/\bgmail\s*\.\s*(\w+)/g)) {
    if (!ALLOWED_GMAIL.has(m[1])) throw new UnsafeMailScript(`gmail.${m[1]} is not allowed`);
  }
  for (const re of FORBIDDEN) {
    const hit = re.exec(code);
    if (hit) throw new UnsafeMailScript(`"${hit[0].slice(0, 40)}" is not allowed`);
  }
  // Page fetches: only Gmail's read-only "Show original" view, and the
  // read-only unread feed of the Primary tab. Both are plain GETs.
  for (const m of code.matchAll(/\bfetch\s*\(([^\n]*)/g)) {
    if (!/view=om/.test(m[1]) && !/^'\/mail\/u\/' \+ __u \+ '\/feed\/atom\/%5Esq_ig_i_personal'\)/.test(m[1].trim()))
      throw new UnsafeMailScript('fetch outside Show original and the unread feed');
  }
  // Tabs: only Gmail itself.
  for (const m of code.matchAll(/\bopenTab\s*\(([^)]*)\)/g)) {
    if (!/^'https:\/\/mail\.google\.com\/mail\/u\/'/.test(m[1].trim())) throw new UnsafeMailScript('opens a tab outside Gmail');
  }
}

export type Runner = (code: string) => Promise<string>;

/** Wrap a repl runner so every script is checked first. A bad script never runs. */
export function readOnlyRepl(repl: Runner): Runner {
  return async (code) => {
    assertReadOnlyMailScript(code);
    return repl(code);
  };
}

// --------------------------------------------------------------------------
// 3. Private mail

export type PrivateKind = 'code' | 'money' | 'government' | 'health' | 'security' | 'legal' | 'family' | 'listed' | 'sensitive';

export const PRIVATE_WORD: Record<PrivateKind, string> = {
  code: 'sign-in or verification code',
  money: 'bank, card, or payment',
  government: 'government or immigration',
  health: 'health',
  security: 'account security',
  legal: 'legal or tax',
  family: 'family',
  listed: 'on your private list',
  sensitive: 'that looked sensitive',
};

const MONEY_HOSTS = [
  'chase.com', 'bankofamerica.com', 'bofa.com', 'wellsfargo.com', 'capitalone.com', 'citi.com', 'citibank.com', 'discover.com',
  'americanexpress.com', 'aexp.com', 'usbank.com', 'pnc.com', 'truist.com', 'regions.com', 'fifththird.com', 'ally.com', 'sofi.com',
  'paypal.com', 'venmo.com', 'zellepay.com', 'cash.app', 'square.com', 'squareup.com', 'robinhood.com', 'fidelity.com', 'schwab.com',
  'vanguard.com', 'etrade.com', 'coinbase.com', 'stripe.com', 'wise.com', 'remitly.com', 'westernunion.com', 'navyfederal.org',
  'greenlight.com', 'step.com', 'apple.com', 'affirm.com', 'klarna.com', 'afterpay.com', 'creditkarma.com', 'experian.com',
  'equifax.com', 'transunion.com', 'icicibank.com', 'hdfcbank.com', 'sbi.co.in', 'axisbank.com', 'kotak.com', 'paytm.com', 'phonepe.com',
];
const GOV_HOSTS = ['uscis.gov', 'state.gov', 'dhs.gov', 'cbp.gov', 'ice.gov', 'irs.gov', 'ssa.gov', 'usps.gov', 'passportindia.gov.in', 'vfsglobal.com', 'ustraveldocs.com', 'usvisa-info.com', 'fragomen.com', 'bal.com', 'envoyglobal.com'];
const HEALTH_HOSTS = ['mychart.com', 'epic.com', 'followmyhealth.com', 'cvs.com', 'walgreens.com', 'labcorp.com', 'questdiagnostics.com', 'zocdoc.com', 'teladoc.com', 'bcbs.com', 'cigna.com', 'aetna.com', 'uhc.com', 'anthem.com', 'humana.com', 'vumc.org', 'williamsonhealth.org'];

const SUBJECT_OR_BODY: Array<[PrivateKind, RegExp]> = [
  ['code', /\b(verification|security|one[- ]?time|login|log[- ]in|sign[- ]?in|access|confirmation|authentication|2fa|two[- ]factor|passcode|otp|pin)\s*(code|number|pin|link)\b/i],
  ['code', /\b\d{4,8}\b\s*(is|as)\s*(your|the)\b/i],
  ['code', /\b(your|the)\s+code\s*(is|:)\s*\S+/i],
  ['code', /\b(reset|change|recover)\s+(your\s+)?password\b|\bpassword\s+(reset|recovery|change)\b|\bmagic\s+link\b/i],
  ['security', /\b(new|unusual|suspicious)\s+(sign[- ]?in|login|log[- ]in|device|activity)\b|\bsecurity\s+(alert|notice|check)\b|\baccount\s+(locked|suspended|compromised)\b/i],
  ['money', /\b(account|card)\s+(ending|number)\b|\bstatement\s+is\s+(ready|available)\b|\b(balance|deposit|withdrawal|transfer|wire|direct deposit|payment\s+(received|sent|due|failed)|transaction|refund\s+issued|overdraft)\b/i],
  ['money', /\b(routing|iban|swift|ifsc)\b/i],
  ['government', /\b(uscis|i-?94|i-?797|i-?20|i-?539|ds-?160|ds-?2019|sevis|ead|green\s*card|visa|passport|consulate|embassy|immigration|biometrics|naturali[sz]ation|h-?4|l-?2|l-?1|h-?1b|f-?1|social\s+security|ssn|itin|aadhaar|pan\s+card|oci)\b/i],
  ['health', /\b(diagnos\w*|prescription|pharmacy|lab\s+results?|test\s+results?|patient\s+portal|medical|doctor|dr\.\s+\w+\s+(office|appointment)|appointment\s+(reminder|confirmed)|insurance\s+(claim|card)|explanation\s+of\s+benefits|vaccin\w*|therap\w*|dental|dentist)\b/i],
  ['legal', /\b(tax\s+(return|document|form)|w-?2|1099|1098|irs|subpoena|lawsuit|attorney|notari[sz]\w*|court)\b/i],
];

function hostOf(email: string): string {
  return (email.split('@')[1] ?? '').toLowerCase().trim();
}

function under(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`);
}

export interface PrivateConfig {
  /** Extra senders (full address or domain) that are always private. */
  privateSenders: string[];
  /** Family surnames: mail from people with these names is private. */
  familyNames: string[];
  /** His own address, so his own name never counts as family. */
  self: string;
}

/**
 * The private check. Runs on sender, subject, attachment names, and the
 * body, before any model. Returns why it is private, or null.
 */
export function privateKind(
  t: { fromName: string; fromEmail: string; subject: string; body: string; attachments?: string[]; myReply?: string },
  cfg: PrivateConfig,
): PrivateKind | null {
  const from = t.fromEmail.toLowerCase().trim();
  const host = hostOf(from);
  if (!host) return 'listed';
  for (const s of cfg.privateSenders) {
    const x = s.toLowerCase().trim();
    if (!x) continue;
    if (x.startsWith('@') || !x.includes('@') ? under(host, x.replace(/^@/, '')) : from === x) return 'listed';
  }
  if (from !== cfg.self.toLowerCase() && cfg.familyNames.some((n) => n && new RegExp(`\\b${n.replace(/[^\w]/g, '')}\\b`, 'i').test(t.fromName))) return 'family';
  if (host.endsWith('.gov') || host.endsWith('.gov.in') || host.endsWith('.nic.in') || GOV_HOSTS.some((h) => under(host, h))) return 'government';
  if (MONEY_HOSTS.some((h) => under(host, h))) return 'money';
  if (HEALTH_HOSTS.some((h) => under(host, h))) return 'health';
  const text = `${t.subject}\n${(t.attachments ?? []).join(' ')}\n${t.body}\n${t.myReply ?? ''}`
    .normalize('NFKC')
    .replace(/[\u00ad\u034f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .slice(0, 20_000);
  for (const [kind, re] of SUBJECT_OR_BODY) if (re.test(text)) return kind;
  return null;
}

/**
 * Last scrub before a non-private email reaches Space Bunny: digit runs
 * (codes, account and phone numbers) and money amounts become placeholders.
 */
export function scrubNumbers(text: string): string {
  return text
    .replace(/[$€£₹]\s?\d[\d,]*(\.\d+)?/g, '[amount]')
    .replace(/\b\d[\d -]{2,}\d\b/g, (m) => (m.replace(/\D/g, '').length >= 4 ? '[number]' : m));
}

/** An answer from a model that mentions private things is thrown away. */
/** Any private kind in free text (no sender known). */
export function privateText(text: string): PrivateKind | null {
  for (const [kind, re] of SUBJECT_OR_BODY) if (re.test(text)) return kind;
  return null;
}

export function leaksPrivate(text: string): boolean {
  if (/\b\d{4,}\b/.test(text.replace(/\b(19|20)\d{2}\b/g, ''))) return true;
  return SUBJECT_OR_BODY.some(([kind, re]) => (kind === 'code' || kind === 'government' || kind === 'money') && re.test(text));
}
