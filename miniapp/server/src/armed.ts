/**
 * Hard limits for Next's researchers, enforced by Aside's own code.
 *
 * Next never acts. Its agents read and report; they never click, type,
 * fill, submit, sign in, send, save, or upload. Aside checks every tool
 * call, page navigation, and network request against a per-session rule
 * list (allow / deny by tool and its arguments, by browser action and URL,
 * by network URL). Those checks run in the daemon, not in the model, so a
 * page that talks an agent into trying something still gets "Permission
 * denied". Verified live on 2026-09-25.
 *
 * Three kinds, each holding at most two of {private data, untrusted pages,
 * a way out} (Meta's "Rule of Two"):
 *  - web:       the public web. No files, no memory, no logins, no browser.
 *  - reader:    one logged-in site, read by address. No other site, no
 *               network, no memory.
 *  - inspector: his memory plus Common App and Google Docs, read by
 *               address. No network, no other site.
 *
 * In every kind the browser tool may only navigate and read. Any page
 * interaction (click, type, fill, press, evaluate, autofill...) in repl
 * code is refused by an argument rule before it runs.
 *
 * One catch, also verified: an agent reads its rules when it loads, and a
 * loaded agent keeps the rules it loaded with. Rules written to a running
 * or recently used session do not bind until Aside unloads it, which it
 * does after 10 idle minutes. So Next keeps a small pool of standby
 * sessions: create one, write its rules, let it sit idle past the unload,
 * and only then give it a question. Research never runs anywhere else.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type RuleMatch =
  | { type: 'tool'; tool: string; args?: Record<string, { $: 'eq' | 'regex'; value: string }> }
  | { type: 'browser'; action: 'read' | 'modify' | 'download'; url?: string }
  | { type: 'network'; url: string };

export interface SessionRules {
  rules: { default: 'allow' | 'deny'; allow: RuleMatch[]; approved: RuleMatch[]; deny: RuleMatch[]; ask: RuleMatch[] };
}

/** Tools no Next agent needs. Names are listed in both cases the daemon uses. */
const NEVER_TOOLS = [
  'bash', 'Bash',
  'write_file', 'edit_file',
  'subagent', 'subagent*', 'subagent_wait',
  'routine_update',
  'notification',
  'request_action_confirmation',
  'ask_user_question',
  'history_search',
];

/** Places no Next agent may even open, whatever the task says. */
const NEVER_SITES = [
  'mail.google.com', '*.mail.google.com', 'accounts.google.com', 'myaccount.google.com',
  'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
  'messages.google.com', 'web.whatsapp.com', 'discord.com', '*.discord.com', 'web.telegram.org',
  'apply.commonapp.org', '*.commonapp.org',
  'venmo.com', '*.venmo.com', 'paypal.com', '*.paypal.com', 'cash.app', '*.chase.com', '*.bankofamerica.com', '*.wellsfargo.com',
  'github.com', '*.github.com',
];

/** repl code that writes, moves, or deletes files, or changes Aside itself. */
export const FS_WRITE = String.raw`\bfs\s*\.\s*(writeFile|appendFile|rm|rmdir|unlink|rename|mkdir|copyFile|cp|symlink|truncate|chmod|open|createWriteStream)\b|\baside\s*\.\s*(sessions|routines|settings|channels|projects)\s*\.\s*(update|set|archive|unarchive|create|delete|mark\w*)`;

const VERBS = 'click|dblclick|fill|type|press|pressSequentially|check|uncheck|setChecked|selectOption|setInputFiles|tap|dispatchEvent|dragTo|dragAndDrop|clear|selectText|hover|focus|blur|evaluate|evaluateHandle|evaluateAll|submit|requestSubmit|route|routeFromHAR|setContent|addScriptTag|addStyleTag|addInitScript|exposeFunction|exposeBinding|setExtraHTTPHeaders|setInputValue|insertText|down|up|move|wheel';

/**
 * Any page interaction or script injection in repl code. Reading is fine:
 * openTab, page.goto, snapshot, getAttribute, textContent, innerText.
 */
export const INTERACTION = [
  String.raw`\.\s*(${VERBS})\s*\(`,
  String.raw`\$\$?eval\s*\(`,
  String.raw`\b(keyboard|mouse|touchscreen|vault|autofill|clipboard)\b`,
  String.raw`\beval\s*\(|\bFunction\s*\(|\bReflect\s*\.|\bProxy\b|\bimport\s*\(|\brequire\s*\(`,
  // el['click'](), el["fill"], el[`type`]
  String.raw`\[\s*['"\x60]\s*(${VERBS})\s*['"\x60]\s*\]`,
  // el['cl' + 'ick'] or el[`${x}`]: computed member names built from strings
  String.raw`\[\s*['"\x60][^\]]*(\+|\$\{)[^\]]*\]`,
  FS_WRITE,
].join('|');

/** reader: no file or process access at all from repl code. */
const NO_LOCAL = String.raw`\bfs\b|\bprocess\s*\.|\baside\s*\.|\bchild_process\b`;

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs.map((x) => JSON.stringify(x)))].map((s) => JSON.parse(s) as T);
}

const site = (host: string): RuleMatch[] => [
  { type: 'browser', action: 'modify', url: host },
  { type: 'browser', action: 'read', url: host },
];

const tool = (name: string): RuleMatch => ({ type: 'tool', tool: name });

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Large tool results land in the session's own tmp folder; reading those is fine. */
function ownTmpRead(sessionsDir: string): RuleMatch {
  return {
    type: 'tool',
    tool: 'read_file',
    args: { path: { $: 'regex', value: String.raw`^${escapeRe(sessionsDir)}/[\w-]+/tmp/(?!.*\.\.)[^\n]+$` } },
  };
}

/** Read-only researchers. */
export type ResearchKind = 'inspector' | 'web' | 'reader';
/** Task helpers: act only after his tap, and stop before submitting. */
export type HelperKind = 'coursework' | 'site' | 'open-web';
export type ArmedKind = ResearchKind | HelperKind;

/**
 * Bump when any rule list changes. A locked session armed under another
 * version is retired, never reused, so old rules can never come back.
 */
export const RULES_VERSION = 3;

export function isResearchKind(k: ArmedKind): k is ResearchKind {
  return k === 'inspector' || k === 'web' || k === 'reader';
}

export function defaultSessionsDir(): string {
  return path.join(os.homedir(), '.aside', 'u', '0', 'sessions');
}

export function isHost(h: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && h.length <= 120;
}

/**
 * The rule list for one kind of researcher. Aside checks deny first, then
 * allow, then the default, so the NEVER_* lists always win.
 */
export function rulesFor(kind: ArmedKind, host?: string, sessionsDir = defaultSessionsDir()): SessionRules {
  if (!isResearchKind(kind)) return helperRules(kind, host);
  const deny: RuleMatch[] = [
    ...NEVER_TOOLS.map(tool),
    { type: 'tool', tool: 'repl', args: { code: { $: 'regex', value: INTERACTION } } },
    { type: 'browser', action: 'download' },
    ...FORM_SUBMIT,
  ];
  for (const h of NEVER_SITES) {
    if (kind === 'inspector' && /commonapp/.test(h)) continue;
    deny.push({ type: 'browser', action: 'modify', url: h }, { type: 'browser', action: 'read', url: h });
  }
  let allow: RuleMatch[] = [tool('get_time'), tool('mcp__sequential-thinking__*')];
  switch (kind) {
    case 'web':
      deny.push(
        tool('repl'),
        tool('memory_search'),
        { type: 'tool', tool: 'webfetch', args: { useCookies: { $: 'regex', value: '^true$' } } },
        { type: 'tool', tool: 'WebFetch', args: { useCookies: { $: 'regex', value: '^true$' } } },
      );
      allow.push(tool('websearch'), tool('WebSearch'), tool('webfetch'), tool('WebFetch'), ownTmpRead(sessionsDir), { type: 'network', url: '**' });
      break;
    case 'reader': {
      const h = (host ?? '').toLowerCase().replace(/^www\./, '');
      if (!isHost(h)) throw new Error('bad_host');
      deny.push(
        tool('memory_search'),
        tool('webfetch'),
        tool('WebFetch'),
        { type: 'tool', tool: 'repl', args: { code: { $: 'regex', value: NO_LOCAL } } },
        { type: 'network', url: '**' },
      );
      allow.push(tool('repl'), ownTmpRead(sessionsDir), ...[h, `*.${h}`].flatMap(site));
      break;
    }
    case 'inspector':
      // A Google Form can be submitted by opening an address alone
      // (formResponse?entry...), so forms stay out of reach entirely.
      deny.push(
        tool('webfetch'),
        tool('WebFetch'),
        { type: 'network', url: '**' },
        { type: 'browser', action: 'modify', url: 'https://docs.google.com/forms/**' },
        { type: 'browser', action: 'read', url: 'https://docs.google.com/forms/**' },
      );
      allow.push(
        tool('repl'),
        tool('read_file'),
        tool('memory_search'),
        ...['apply.commonapp.org', '*.commonapp.org', 'docs.google.com', 'drive.google.com'].flatMap(site),
      );
      break;
  }
  allow = uniq(allow);
  return { rules: { default: 'deny', allow, approved: [], ask: [], deny: uniq(deny) } };
}


/** Opening this address alone submits a Google Form. Blocked for every kind. */
const FORM_SUBMIT: RuleMatch[] = [
  { type: 'browser', action: 'modify', url: 'https://docs.google.com/forms/**/formResponse*' },
  { type: 'browser', action: 'read', url: 'https://docs.google.com/forms/**/formResponse*' },
];

/**
 * Task helpers start only from his tap. They may use the page (fill a
 * form, open an assignment) on the sites their task needs, and stop before
 * submitting (instruction; Aside cannot tell a typing click from a submit
 * click on the same site). Never: email, accounts, money, code hosts,
 * Common App, shell, file writes, downloads, or the network.
 */
function helperRules(kind: HelperKind, host?: string): SessionRules {
  const deny: RuleMatch[] = [
    ...NEVER_TOOLS.map(tool),
    tool('webfetch'),
    tool('WebFetch'),
    { type: 'tool', tool: 'repl', args: { code: { $: 'regex', value: FS_WRITE } } },
    ...FORM_SUBMIT,
    { type: 'browser', action: 'download' },
    { type: 'network', url: '**' },
  ];
  for (const h of NEVER_SITES) deny.push({ type: 'browser', action: 'modify', url: h }, { type: 'browser', action: 'download', url: h });
  const allow: RuleMatch[] = ['repl', 'get_time', 'read_file', 'memory_search', 'mcp__sequential-thinking__*', 'WebSearch', 'websearch'].map(tool);
  let def: 'allow' | 'deny' = 'deny';
  switch (kind) {
    case 'coursework':
      allow.push(...['*.schoology.com', 'schoology.com', 'docs.google.com', 'drive.google.com'].flatMap(site));
      break;
    case 'site': {
      const h = (host ?? '').toLowerCase().replace(/^www\./, '');
      if (!isHost(h)) throw new Error('bad_host');
      allow.push(...[h, `*.${h}`].flatMap(site));
      break;
    }
    case 'open-web':
      def = 'allow';
      break;
  }
  return { rules: { default: def, allow: uniq(allow), approved: [], ask: [], deny: uniq(deny) } };
}

/** Which task helper his tap starts, or null when none is offered. */
export function kindForTask(t: { kind: string; source: string; taint: 'email' | null; link?: { host: string; verified: boolean } | null }): { kind: HelperKind; host: string | null } | null {
  if (t.source === 'schoology' || t.kind === 'coursework') return { kind: 'coursework', host: null };
  if (t.taint === 'email' && (t.kind === 'form' || t.kind === 'opportunity')) {
    if (t.link?.verified && t.link.host) return { kind: 'site', host: t.link.host.toLowerCase().replace(/^www\./, '') };
    if (t.kind === 'opportunity') return { kind: 'open-web', host: null };
  }
  return null;
}

/** Plain-words summary for the activity log and the phone. */
export function describeRules(kind: ArmedKind, host?: string | null): string {
  switch (kind) {
    case 'web':
      return "Reads public web pages. Can't see your files, memory, or logins. Can't click, type, or submit.";
    case 'reader':
      return `Locked to ${host ?? 'one site'}, read only. Can't click, type, sign in, or submit anything.`;
    case 'inspector':
      return "Reads your notes, Common App, and Google Docs, read only. Can't click, sign in, or submit.";
    case 'coursework':
      return "Locked to Schoology and Google Docs. Can't reach email, money sites, or send anything out.";
    case 'site':
      return `Locked to ${host ?? 'one site'}. Can't reach email, Common App, or money sites, or send anything out.`;
    case 'open-web':
      return "Can browse, but not email, accounts, Common App, or money sites. Can't send anything out.";
  }
}

// --------------------------------------------------------------------------
// The standby pool.

/** Aside unloads an idle agent after 10 minutes; wait a little longer. */
export const UNLOAD_MS = 11 * 60_000;
/** A standby unused this long is retired so rules never go very stale. */
export const MAX_STANDBY_MS = 20 * 60 * 60_000;
const MAX_SLOTS = 5;

export interface Slot {
  key: string;
  kind: ArmedKind;
  host: string | null;
  sessionId: string;
  state: 'warming' | 'armed' | 'used' | 'retired';
  createdAt: string;
  armedAt: string | null;
  usedAt: string | null;
  /** RULES_VERSION the session was armed with. */
  rulesVersion?: number;
  /** Model the session was created on. A different current model retires it. */
  model?: string | null;
}

export interface PoolDeps {
  file: string;
  /** Start a new session with a harmless first turn. Returns its id. */
  create: (label: string) => Promise<string>;
  /** Write rules + runtime config onto a session. */
  arm: (sessionId: string, rules: SessionRules, title: string) => Promise<void>;
  /** Is a turn running on it now (this server's own runner)? */
  busy: (sessionId: string) => boolean;
  /** Last write to its transcript, ms since epoch, or null. */
  lastWrite: (sessionId: string) => number | null;
  /**
   * Is this really our standby? Its first message must carry the standby
   * marker for this key. Session discovery can pick up the wrong folder
   * when two sessions start at once; this stops Next from ever arming or
   * reusing one of his own sessions.
   */
  isOurs: (sessionId: string, key: string) => boolean;
  /** The model new standbys are created on now. */
  model?: () => string | null;
  /** Called once when a standby that never ran a task is retired (e.g. delete it). */
  discard?: (slot: Slot) => void;
  log?: (msg: string, extra?: unknown) => void;
}

/** The first-message marker a standby is created with. */
export function standbyMarker(key: string): string {
  return `[Next standby: ${key}]`;
}

export function slotKey(kind: ArmedKind, host?: string | null): string {
  const h = (host ?? '').toLowerCase().replace(/^www\./, '');
  if (kind === 'reader') return `reader:${h}`;
  if (kind === 'site') return `site:${h}`;
  return kind;
}

export class ArmedPool {
  private working = false;

  constructor(private readonly d: PoolDeps) {}

  read(): Slot[] {
    try {
      const doc = JSON.parse(fs.readFileSync(this.d.file, 'utf8')) as { slots?: Slot[] };
      const kinds = ['inspector', 'web', 'reader', 'coursework', 'site', 'open-web'];
      return (doc.slots ?? [])
        .filter((s) => s && typeof s.key === 'string' && typeof s.sessionId === 'string' && /^[\w-]{6,80}$/.test(s.sessionId) && kinds.includes(s.kind))
        // Armed under older rules: retired, never reused.
        .map((s) => (s.state === 'armed' && s.rulesVersion !== RULES_VERSION ? { ...s, state: 'retired' as const } : s))
        // Made on a different model than the one picked now: retired, so a
        // model switch (say, off a paid plan) takes effect on the next task.
        .map((s) => ((s.state === 'armed' || s.state === 'warming') && this.d.model && (s.model ?? null) !== this.d.model() ? { ...s, state: 'retired' as const } : s));
    } catch {
      return [];
    }
  }

  private write(slots: Slot[]): void {
    // Retired slots are dropped from the file below, so this runs once per slot.
    for (const s of slots) if (s.state === 'retired' && !s.usedAt) { try { this.d.discard?.(s); } catch { /* best effort */ } }
    fs.mkdirSync(path.dirname(this.d.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.d.file}.${process.pid}.tmp`;
    // Keep a short history of used slots for the record; drop the rest.
    const keep = [...slots.filter((s) => s.state === 'warming' || s.state === 'armed'), ...slots.filter((s) => s.state === 'used').slice(-10)];
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, slots: keep }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.d.file);
  }

  /** Ready = armed, idle past the unload, and not too old. */
  isReady(s: Slot, now = Date.now()): boolean {
    if (s.state !== 'armed' || !s.armedAt) return false;
    if (this.d.busy(s.sessionId)) return false;
    const armed = Date.parse(s.armedAt);
    const last = Math.max(armed, this.d.lastWrite(s.sessionId) ?? 0);
    return now - last >= UNLOAD_MS && now - armed < MAX_STANDBY_MS;
  }

  status(now = Date.now()): Array<Slot & { ready: boolean; readyInMin: number | null }> {
    return this.read()
      .filter((s) => s.state === 'warming' || s.state === 'armed')
      .map((s) => {
        const ready = this.isReady(s, now);
        const base = s.armedAt ? Math.max(Date.parse(s.armedAt), this.d.lastWrite(s.sessionId) ?? 0) : null;
        return { ...s, ready, readyInMin: ready || base === null ? null : Math.max(1, Math.ceil((base + UNLOAD_MS - now) / 60_000)) };
      });
  }

  /**
   * Make sure one standby exists for each wanted key: create, then arm
   * once the first turn is over. Safe to call often; one pass at a time.
   */
  async ensure(wanted: Array<{ kind: ArmedKind; host?: string | null }>, now = Date.now()): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      let slots = this.read();
      // Retire stale standbys.
      slots = slots.map((s) => (s.state === 'armed' && s.armedAt && now - Date.parse(s.armedAt) > MAX_STANDBY_MS ? { ...s, state: 'retired' as const } : s));
      for (const s of slots) {
        if (s.state !== 'warming' || this.d.busy(s.sessionId)) continue;
        const last = this.d.lastWrite(s.sessionId);
        // Give the warm-up turn time to write its transcript.
        if (last === null && now - Date.parse(s.createdAt) < 90_000) continue;
        if (!this.d.isOurs(s.sessionId, s.key)) {
          this.d.log?.('standby is not ours; retiring', { key: s.key, sessionId: s.sessionId });
          s.state = 'retired';
          continue;
        }
        try {
          await this.d.arm(s.sessionId, rulesFor(s.kind, s.host ?? undefined), `Next · getting ready (${s.key})`);
          s.state = 'armed';
          s.rulesVersion = RULES_VERSION;
          s.armedAt = new Date(now).toISOString();
        } catch (err) {
          this.d.log?.('standby arm failed', { err: String(err), key: s.key });
          s.state = 'retired';
        }
      }
      const live = slots.filter((s) => s.state === 'warming' || s.state === 'armed');
      for (const w of wanted.slice(0, MAX_SLOTS)) {
        const key = slotKey(w.kind, w.host);
        if (live.some((s) => s.key === key)) continue;
        if (live.length >= MAX_SLOTS) break;
        try {
          const sessionId = await this.d.create(key);
          const slot: Slot = { key, kind: w.kind, host: w.host ?? null, sessionId, state: 'warming', createdAt: new Date(now).toISOString(), armedAt: null, usedAt: null, model: this.d.model?.() ?? null };
          slots.push(slot);
          live.push(slot);
        } catch (err) {
          this.d.log?.('standby create failed', { err: String(err), key });
        }
      }
      this.write(slots);
    } finally {
      this.working = false;
    }
  }

  /** Take a ready standby for this key, or null. */
  take(kind: ArmedKind, host?: string | null, now = Date.now()): Slot | null {
    const key = slotKey(kind, host);
    const slots = this.read();
    const s = slots.find((x) => x.key === key && this.isReady(x, now) && this.d.isOurs(x.sessionId, x.key));
    if (!s) return null;
    s.state = 'used';
    s.usedAt = new Date(now).toISOString();
    this.write(slots);
    return s;
  }
}

/** Which researcher an item gets, or null when research is not offered. */
export function researchKindFor(t: {
  kind: string;
  source: string;
  taint: 'email' | null;
  flag?: 'suspicious' | null;
  url?: string | null;
  link?: { host: string; verified: boolean } | null;
}): { kind: ArmedKind; host: string | null } | null {
  if (t.flag) return null;
  if (t.kind === 'project' || t.source === 'project') return null;
  if (t.kind === 'reply' || t.kind === 'schedule') return null;
  if (t.source === 'schoology' || t.kind === 'coursework') {
    const host = httpsHost(t.url ?? null);
    return host ? { kind: 'reader', host } : null;
  }
  if (t.taint === 'email') {
    if (t.kind === 'form') return t.link?.verified && isHost(t.link.host.toLowerCase().replace(/^www\./, '')) ? { kind: 'reader', host: t.link.host.toLowerCase().replace(/^www\./, '') } : null;
    if (t.kind === 'opportunity') return { kind: 'web', host: null };
    return null;
  }
  return { kind: 'web', host: null };
}

function httpsHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase().replace(/^www\./, '');
    return u.protocol === 'https:' && isHost(h) ? h : null;
  } catch {
    return null;
  }
}

/** Count what Aside refused during a session, from its transcript. */
export function countDenied(msgFile: string | null, sinceMs: number): { denied: number; samples: string[] } {
  if (!msgFile || !fs.existsSync(msgFile)) return { denied: 0, samples: [] };
  let denied = 0;
  const samples: string[] = [];
  try {
    const stat = fs.statSync(msgFile);
    const size = Math.min(stat.size, 4 * 1024 * 1024);
    const fd = fs.openSync(msgFile, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('Permission denied')) continue;
      try {
        const row = JSON.parse(line) as { timestamp?: number | string };
        if (Number(row.timestamp) < sinceMs) continue;
      } catch {
        continue;
      }
      const m = /Permission denied: ([^"\\]{0,120})/.exec(line);
      denied++;
      if (m && samples.length < 3) samples.push(m[1].replace(/ is blocked by policy.*/, '').trim());
    }
  } catch {
    return { denied: 0, samples: [] };
  }
  return { denied, samples };
}
