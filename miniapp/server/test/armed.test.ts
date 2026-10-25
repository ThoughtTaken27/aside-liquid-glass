import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';
import { ArmedPool, INTERACTION, RULES_VERSION, UNLOAD_MS, countDenied, kindForTask, researchKindFor, rulesFor, slotKey, type RuleMatch, type SessionRules } from '../src/armed.js';

/**
 * A faithful copy of Aside's own rule evaluation (daemon `hasPermission` +
 * `matchesRule` + `matchesUrlGlob`, read from the 1.26.923 build): deny,
 * then approved, then ask, then allow, then the default. Glob matching is
 * minimatch with dot:true, against the full URL, the hostname, the host,
 * or the origin.
 */
type Req =
  | { type: 'tool'; tool: string; args?: Record<string, unknown> }
  | { type: 'browser'; action: 'read' | 'modify' | 'download'; url: string }
  | { type: 'network'; url: string };

const glob = (pattern: string, value: string) => minimatch(value, pattern, { dot: true });
function urlGlob(pattern: string, url: string): boolean {
  if (glob(pattern, url)) return true;
  try {
    const u = new URL(url);
    return glob(pattern, u.hostname) || glob(pattern, u.host) || glob(pattern, u.origin);
  } catch {
    return false;
  }
}
function matches(rule: RuleMatch, req: Req): boolean {
  if (req.type === 'tool' && rule.type === 'tool') {
    if (!glob(rule.tool, req.tool)) return false;
    for (const [k, m] of Object.entries(rule.args ?? {})) {
      const v = req.args?.[k];
      if (m.$ === 'eq' && v !== m.value) return false;
      if (m.$ === 'regex' && (v == null || !new RegExp(m.value).test(String(v)))) return false;
    }
    return true;
  }
  if (req.type === 'browser' && rule.type === 'browser') {
    if (rule.action !== req.action) return false;
    return rule.url ? urlGlob(rule.url, req.url) : true;
  }
  return req.type === 'network' && rule.type === 'network' && urlGlob(rule.url, req.url);
}
function verdict(r: SessionRules, req: Req): 'allow' | 'deny' {
  for (const x of r.rules.deny) if (matches(x, req)) return 'deny';
  for (const x of r.rules.approved) if (matches(x, req)) return 'allow';
  for (const x of r.rules.ask) if (matches(x, req)) return 'deny'; // headless: ask = deny
  for (const x of r.rules.allow) if (matches(x, req)) return 'allow';
  return r.rules.default;
}

const tool = (name: string, code?: string): Req => ({ type: 'tool', tool: name, ...(code ? { args: { code } } : {}) });
const withArgs = (name: string, args: Record<string, unknown>): Req => ({ type: 'tool', tool: name, args });
const act = (url: string): Req => ({ type: 'browser', action: 'modify', url });
const read = (url: string): Req => ({ type: 'browser', action: 'read', url });
const SESS = '/Users/x/.aside/u/0/sessions';

describe('INTERACTION', () => {
  const re = new RegExp(INTERACTION);
  it('refuses every way to touch a page', () => {
    for (const code of [
      "await page.locator('e3').click()",
      "await page.locator('e3') . click ()",
      "await el?.click()",
      "await page.fill('#q', 'x')",
      "await page.getByRole('textbox').type('hi')",
      "await page.keyboard.press('Enter')",
      "await page.mouse.click(10, 10)",
      "await page.locator('form').evaluate((f) => f.submit())",
      "await page.evaluate(() => 1)",
      "await page.$eval('a', (a) => a.click())",
      "el['click']()",
      'el["fill"]("x")',
      'el[`type`]("x")',
      "el['cl' + 'ick']()",
      "el[`${verb}`]()",
      "await vault.autofill()",
      "await page.selectOption('#s', 'a')",
      "await page.setInputFiles('#f', '/etc/passwd')",
      "await page.check('#agree')",
      "await page.locator('a').hover()",
      "await page.addInitScript('x')",
      "await page.route('**', r => r.abort())",
      "eval('1')",
      "new Function('return 1')()",
      "Reflect.get(el, 'click')",
      "await fs.writeFile('/x', 'y')",
      "aside.sessions.update('x', {})",
      "aside.settings.set('permission', {})",
    ]) {
      expect(re.test(code), code).toBe(true);
    }
  });
  it('lets reading through', () => {
    for (const code of [
      "const t = await openTab('https://wcs.schoology.com/assignment/1')",
      "await page.goto('https://wcs.schoology.com/course/2')",
      "const s = await snapshot(page); console.log(s.tree)",
      "console.log(await page.locator('a').first().getAttribute('href'))",
      "console.log(await page.locator('main').innerText())",
      "console.log(await page.locator('h1').textContent())",
      "await sleep(500)",
      "console.log(rows[i + 1])",
      "const typeName = 'x'; console.log(typeof typeName)",
    ]) {
      expect(re.test(code), code).toBe(false);
    }
  });
});

describe('rulesFor: web', () => {
  const r = rulesFor('web', undefined, SESS);
  it('searches and fetches the public web', () => {
    expect(verdict(r, tool('websearch'))).toBe('allow');
    expect(verdict(r, withArgs('webfetch', { url: 'https://x.org', useCookies: false }))).toBe('allow');
    expect(verdict(r, { type: 'network', url: 'https://x.org/page' })).toBe('allow');
  });
  it('never uses his logins, files, memory, or the browser', () => {
    expect(verdict(r, withArgs('webfetch', { url: 'https://x.org', useCookies: true }))).toBe('deny');
    expect(verdict(r, tool('repl', "await openTab('https://x.org')"))).toBe('deny');
    expect(verdict(r, tool('memory_search'))).toBe('deny');
    expect(verdict(r, withArgs('read_file', { path: '/Users/x/.aside/u/0/memory/USER.md' }))).toBe('deny');
    expect(verdict(r, withArgs('read_file', { path: `${SESS}/abc/tmp/../../../memory/USER.md` }))).toBe('deny');
    expect(verdict(r, withArgs('read_file', { path: `${SESS}/2026-09-25_abc/tmp/websearch-result.txt` }))).toBe('allow');
    expect(verdict(r, tool('bash'))).toBe('deny');
  });
});

describe('rulesFor: reader', () => {
  const r = rulesFor('reader', 'wcs.schoology.com', SESS);
  it('reads its own site by address', () => {
    expect(verdict(r, act('https://wcs.schoology.com/assignment/1'))).toBe('allow');
    expect(verdict(r, read('https://wcs.schoology.com/assignment/1'))).toBe('allow');
    expect(verdict(r, tool('repl', "await openTab('https://wcs.schoology.com/assignment/1')"))).toBe('allow');
  });
  it('cannot interact, leave the site, or send anything out', () => {
    expect(verdict(r, tool('repl', "await page.locator('e3').click()"))).toBe('deny');
    expect(verdict(r, tool('repl', "console.log(await fs.readFile('/Users/x/.aside/u/0/memory/USER.md','utf8'))"))).toBe('deny');
    expect(verdict(r, act('https://wikipedia.org'))).toBe('deny');
    expect(verdict(r, act('https://wcs.schoology.com.attacker.io/'))).toBe('deny');
    expect(verdict(r, act('https://mail.google.com/'))).toBe('deny');
    expect(verdict(r, { type: 'network', url: 'https://httpbin.org/get' })).toBe('deny');
    expect(verdict(r, tool('memory_search'))).toBe('deny');
    expect(verdict(r, withArgs('read_file', { path: '/Users/x/.aside/u/0/memory/USER.md' }))).toBe('deny');
    expect(verdict(r, tool('webfetch'))).toBe('deny');
    expect(verdict(r, { type: 'browser', action: 'download', url: 'https://wcs.schoology.com/f.pdf' })).toBe('deny');
    expect(verdict(r, act('javascript:alert(1)'))).toBe('deny');
  });
  it('a Google Forms reader can read the form but never submit it by address', () => {
    const f = rulesFor('reader', 'docs.google.com', SESS);
    expect(verdict(f, act('https://docs.google.com/forms/d/e/1FAIpQL/viewform'))).toBe('allow');
    expect(verdict(f, act('https://docs.google.com/forms/d/e/1FAIpQL/formResponse?entry.1=x&submit=Submit'))).toBe('deny');
    expect(verdict(f, act('https://docs.google.com/forms/u/0/d/e/1FAIpQL/formResponse'))).toBe('deny');
  });
  it('rejects a bad host', () => {
    expect(() => rulesFor('reader', 'not a host')).toThrow();
    expect(() => rulesFor('reader')).toThrow();
  });
});

describe('rulesFor: inspector', () => {
  const r = rulesFor('inspector', undefined, SESS);
  it('reads memory, Common App, and Docs by address', () => {
    expect(verdict(r, tool('memory_search'))).toBe('allow');
    expect(verdict(r, withArgs('read_file', { path: '/Users/x/.aside/u/0/memory/USER.md' }))).toBe('allow');
    expect(verdict(r, act('https://apply.commonapp.org/dashboard'))).toBe('allow');
    expect(verdict(r, act('https://docs.google.com/document/d/1'))).toBe('allow');
  });
  it('cannot interact, sign in, leave, or send anything out', () => {
    expect(verdict(r, tool('repl', "await page.getByRole('button', { name: 'Sign in' }).click()"))).toBe('deny');
    expect(verdict(r, tool('repl', "await vault.autofill()"))).toBe('deny');
    expect(verdict(r, act('https://www.purdue.edu/'))).toBe('deny');
    expect(verdict(r, act('https://docs.google.com/forms/d/e/1FAIpQL/formResponse?entry.1=x&submit=Submit'))).toBe('deny');
    expect(verdict(r, act('https://docs.google.com/forms/d/e/1FAIpQL/viewform'))).toBe('deny');
    expect(verdict(r, act('https://mail.google.com/'))).toBe('deny');
    expect(verdict(r, { type: 'network', url: 'https://attacker.example/?d=1' })).toBe('deny');
    expect(verdict(r, tool('webfetch'))).toBe('deny');
    expect(verdict(r, tool('bash'))).toBe('deny');
    expect(verdict(r, tool('write_file'))).toBe('deny');
  });
});

describe('researchKindFor', () => {
  it('maps items to the right researcher', () => {
    expect(researchKindFor({ kind: 'coursework', source: 'schoology', taint: null, url: 'https://WCS.schoology.com/assignment/1' })).toEqual({ kind: 'reader', host: 'wcs.schoology.com' });
    expect(researchKindFor({ kind: 'coursework', source: 'schoology', taint: null, url: 'http://wcs.schoology.com/a' })).toBeNull();
    expect(researchKindFor({ kind: 'form', source: 'school-mail', taint: 'email', link: { host: 'Forms.Example.org', verified: true } })).toEqual({ kind: 'reader', host: 'forms.example.org' });
    expect(researchKindFor({ kind: 'form', source: 'school-mail', taint: 'email', link: { host: 'x.org', verified: false } })).toBeNull();
    expect(researchKindFor({ kind: 'opportunity', source: 'school-mail', taint: 'email', link: null })).toEqual({ kind: 'web', host: null });
    expect(researchKindFor({ kind: 'opportunity', source: 'school-mail', taint: 'email', flag: 'suspicious' })).toBeNull();
    expect(researchKindFor({ kind: 'reply', source: 'school-mail', taint: 'email' })).toBeNull();
    expect(researchKindFor({ kind: 'event', source: 'school-mail', taint: 'email' })).toBeNull();
    expect(researchKindFor({ kind: 'project', source: 'project', taint: null })).toBeNull();
    expect(researchKindFor({ kind: 'errand', source: 'manual', taint: null })).toEqual({ kind: 'web', host: null });
  });
  it('keys standbys by kind and host', () => {
    expect(slotKey('reader', 'www.Example.org')).toBe('reader:example.org');
    expect(slotKey('web')).toBe('web');
  });
});

describe('ArmedPool', () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-armed-'));
    const created: string[] = [];
    const armed: Array<{ id: string; rules: SessionRules; title: string }> = [];
    const busy = new Set<string>();
    const writes = new Map<string, number>();
    const foreign = new Set<string>();
    let n = 0;
    const pool = new ArmedPool({
      file: path.join(dir, 'armed.json'),
      create: async () => {
        const id = `sess${String(++n).padStart(6, '0')}`;
        created.push(id);
        return id;
      },
      arm: async (id, rules, title) => {
        armed.push({ id, rules, title });
      },
      busy: (id) => busy.has(id),
      lastWrite: (id) => writes.get(id) ?? null,
      isOurs: (id) => !foreign.has(id),
    });
    return { pool, created, armed, busy, writes, foreign };
  }

  it('creates, arms after the warm-up, and is ready only after the unload window', async () => {
    const { pool, created, armed, busy, writes } = setup();
    const t0 = Date.parse('2026-09-25T20:00:00Z');
    await pool.ensure([{ kind: 'inspector' }], t0);
    expect(created).toHaveLength(1);
    const id = created[0];
    // Warm-up still running: not armed yet.
    busy.add(id);
    await pool.ensure([{ kind: 'inspector' }], t0 + 30_000);
    expect(armed).toHaveLength(0);
    busy.delete(id);
    writes.set(id, t0 + 40_000);
    await pool.ensure([{ kind: 'inspector' }], t0 + 60_000);
    expect(armed).toHaveLength(1);
    expect(armed[0].title).toMatch(/Next · getting ready/);
    expect(pool.take('inspector', null, t0 + 60_000 + UNLOAD_MS - 1000)).toBeNull();
    const slot = pool.take('inspector', null, t0 + 60_000 + UNLOAD_MS + 1000);
    expect(slot?.sessionId).toBe(id);
    // Used once, never again.
    expect(pool.take('inspector', null, t0 + 60_000 + UNLOAD_MS + 2000)).toBeNull();
  });

  it('any later write to the standby restarts its unload clock', async () => {
    const { pool, created, writes } = setup();
    const t0 = Date.parse('2026-09-25T20:00:00Z');
    await pool.ensure([{ kind: 'web' }], t0);
    writes.set(created[0], t0 + 10_000);
    await pool.ensure([{ kind: 'web' }], t0 + 100_000);
    writes.set(created[0], t0 + 300_000);
    expect(pool.take('web', null, t0 + 100_000 + UNLOAD_MS + 1000)).toBeNull();
    expect(pool.take('web', null, t0 + 300_000 + UNLOAD_MS + 1000)).not.toBeNull();
  });

  it('keeps one standby per key and at most five', async () => {
    const { pool, created } = setup();
    const t0 = Date.now();
    const wanted = [{ kind: 'inspector' as const }, { kind: 'web' as const }, { kind: 'reader' as const, host: 'a.org' }, { kind: 'reader' as const, host: 'b.org' }, { kind: 'reader' as const, host: 'd.org' }, { kind: 'reader' as const, host: 'c.org' }];
    await pool.ensure(wanted, t0);
    await pool.ensure(wanted, t0 + 1000);
    expect(created).toHaveLength(5);
  });
});

describe('ArmedPool identity', () => {
  it('never arms or hands out a session that is not its own standby', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-armed-'));
    const armed: string[] = [];
    let ours = false;
    const pool = new ArmedPool({
      file: path.join(dir, 'a.json'),
      create: async () => 'sessForeign1',
      arm: async (id) => void armed.push(id),
      busy: () => false,
      lastWrite: () => 1,
      isOurs: () => ours,
    });
    const t0 = Date.now();
    await pool.ensure([{ kind: 'inspector' }], t0);
    await pool.ensure([], t0 + 100_000);
    expect(armed).toEqual([]);
    ours = true;
    expect(pool.take('inspector', null, t0 + UNLOAD_MS * 3)).toBeNull();
  });
});

describe('ArmedPool rules version', () => {
  it('retires slots armed under older rules and keeps current ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-armed-'));
    const file = path.join(dir, 'a.json');
    const base = { host: null, state: 'armed', createdAt: new Date(0).toISOString(), armedAt: new Date(0).toISOString(), usedAt: null };
    fs.writeFileSync(file, JSON.stringify({ slots: [
      { ...base, key: 'inspector', kind: 'inspector', sessionId: 'sessOld001' },
      { ...base, key: 'web', kind: 'web', sessionId: 'sessNew001', rulesVersion: RULES_VERSION },
      { ...base, key: 'bogus', kind: 'bogus', sessionId: 'sessBad001', rulesVersion: RULES_VERSION },
    ] }));
    const pool = new ArmedPool({ file, create: async () => 'x', arm: async () => undefined, busy: () => false, lastWrite: () => null, isOurs: () => true });
    expect(pool.read().map((s) => [s.key, s.state])).toEqual([['inspector', 'retired'], ['web', 'armed']]);
    expect(pool.take('inspector', null, Date.now())).toBeNull();
  });
});

describe('task helpers (start only from his tap)', () => {
  it('site helper acts only on its site and never submits a Google Form by address', () => {
    const r = rulesFor('site', 'docs.google.com');
    expect(verdict(r, act('https://docs.google.com/forms/d/e/x/viewform'))).toBe('allow');
    expect(verdict(r, tool('repl', "await page.fill('#q','x')"))).toBe('allow');
    expect(verdict(r, act('https://docs.google.com/forms/d/e/x/formResponse?entry.1=a'))).toBe('deny');
    expect(verdict(r, act('https://mail.google.com/'))).toBe('deny');
    expect(verdict(r, { type: 'network', url: 'https://x.org' })).toBe('deny');
    expect(verdict(r, tool('bash'))).toBe('deny');
    expect(verdict(r, tool('repl', "await fs.writeFile('/x','y')"))).toBe('deny');
  });
  it('coursework stays on Schoology and Docs; open web avoids never-sites', () => {
    const c = rulesFor('coursework');
    expect(verdict(c, act('https://wcs.schoology.com/assignment/1'))).toBe('allow');
    expect(verdict(c, act('https://apply.commonapp.org/'))).toBe('deny');
    const o = rulesFor('open-web');
    expect(verdict(o, act('https://www.google.com/search?q=x'))).toBe('allow');
    expect(verdict(o, act('https://apply.commonapp.org/'))).toBe('deny');
    expect(verdict(o, { type: 'network', url: 'https://x.org' })).toBe('deny');
  });
  it('maps tasks to helpers', () => {
    expect(kindForTask({ kind: 'coursework', source: 'schoology', taint: null })).toEqual({ kind: 'coursework', host: null });
    expect(kindForTask({ kind: 'form', source: 'school-mail', taint: 'email', link: { host: 'www.Forms.org', verified: true } })).toEqual({ kind: 'site', host: 'forms.org' });
    expect(kindForTask({ kind: 'opportunity', source: 'school-mail', taint: 'email', link: null })).toEqual({ kind: 'open-web', host: null });
    expect(kindForTask({ kind: 'errand', source: 'manual', taint: null })).toBeNull();
    expect(slotKey('site', 'www.X.org')).toBe('site:x.org');
  });
});

describe('countDenied', () => {
  it('counts refusals after the start time', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'next-den-')), 'messages.jsonl');
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ role: 'toolResult', timestamp: 100, content: [{ type: 'text', text: "Permission denied: tool 'bash' usage is blocked by policy" }] }),
        JSON.stringify({ role: 'toolResult', timestamp: 2000, content: [{ type: 'text', text: "Permission denied: browser modify 'https://mail.google.com' is blocked by policy" }] }),
        JSON.stringify({ role: 'assistant', timestamp: 2100, content: [{ type: 'text', text: 'ok' }] }),
      ].join('\n') + '\n',
    );
    const d = countDenied(f, 1000);
    expect(d.denied).toBe(1);
    expect(d.samples[0]).toBe("browser modify 'https://mail.google.com'");
  });
});

describe('ArmedPool model switch', () => {
  it('retires standbys made on a different model, so a switch takes effect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-armed-model-'));
    let model = 'claude-code/claude-haiku-4-5';
    let n = 0;
    const pool = new ArmedPool({
      file: path.join(dir, 'armed.json'),
      create: async () => `sess${String(++n).padStart(6, '0')}`,
      arm: async () => undefined,
      busy: () => false,
      lastWrite: () => null,
      isOurs: () => true,
      model: () => model,
    });
    const t0 = Date.parse('2026-09-25T20:00:00Z');
    await pool.ensure([{ kind: 'web' }], t0);
    await pool.ensure([{ kind: 'web' }], t0 + 120_000);
    expect(pool.status(t0 + 120_000)[0]).toMatchObject({ state: 'armed', model: 'claude-code/claude-haiku-4-5' });
    model = '9router/oc/space-bunny-free';
    // The old slot is gone and can never be taken.
    expect(pool.status(t0 + 3 * 3600e3)).toHaveLength(0);
    expect(pool.take('web', null, t0 + 3 * 3600e3)).toBeNull();
    await pool.ensure([{ kind: 'web' }], t0 + 3 * 3600e3);
    expect(pool.status(t0 + 3 * 3600e3)[0]).toMatchObject({ sessionId: 'sess000002', model: '9router/oc/space-bunny-free' });
  });
});

describe('ArmedPool discard hook', () => {
  it('discards an expired never-used standby exactly once and never a used one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'armed-discard-'));
    const file = path.join(dir, 'pool.json');
    const old = new Date(Date.now() - 21 * 60 * 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify({ version: 1, slots: [
      { key: 'web', kind: 'web', host: null, sessionId: 'expiredAAAA', state: 'armed', createdAt: old, armedAt: old, usedAt: null, model: null, rulesVersion: RULES_VERSION },
      { key: 'open-web', kind: 'open-web', host: null, sessionId: 'usedBBBBBB', state: 'used', createdAt: old, armedAt: old, usedAt: old, model: null, rulesVersion: RULES_VERSION },
    ] }));
    const discarded: string[] = [];
    let n = 0;
    const pool = new ArmedPool({
      file, create: async () => `freshCCCC${n++}`, arm: async () => undefined, busy: () => false,
      lastWrite: () => null, isOurs: () => true, discard: (s) => discarded.push(s.sessionId),
    });
    await pool.ensure([{ kind: 'web' }]);
    await pool.ensure([{ kind: 'web' }]);
    expect(discarded).toEqual(['expiredAAAA']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
