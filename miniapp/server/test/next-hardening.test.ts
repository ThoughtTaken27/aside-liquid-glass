import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxSweeper, ReplyDrafter, jevDecider, gateAll, CACHE_VERSION, type MailThread, type Decider } from '../src/inbox.js';
import { agentPromptFor, briefFor, type BriefInput } from '../src/brief.js';

const NOW = new Date('2026-10-12T16:00:00Z');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const email = (over: Partial<MailThread> = {}): MailThread => ({
  threadId: 'thread-f:1234567890123456789', subject: 'Volunteer signup', fromName: 'Counseling',
  fromEmail: 'office@school.example', auth: 'pass', at: '2026-10-12T12:00:00Z',
  body: 'Sign up to volunteer Saturday.', repliedByMe: false, attachments: [], ...over,
});
function rig(messages: MailThread[], decide?: Decider) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-security-')); dirs.push(dir);
  const encode = (code: string, data: unknown) => {
    const marker = /"(@@NEXTMAIL-[0-9a-f]{16}@@)"/.exec(code)![1];
    return marker + Buffer.from(JSON.stringify(data)).toString('base64');
  };
  const complete = vi.fn(async () => JSON.stringify({ kind: 'deadline', title: 'Volunteer Saturday', impact: 2 }));
  const log = vi.fn();
  const cachePath = path.join(dir, 'cache.json'); const feedPath = path.join(dir, 'feed.json');
  const repl = async (code: string) => code.includes('gmail.search')
    ? encode(code, { uid: 1, threads: messages.map(m => ({ id: m.threadId, at: m.at })) })
    : encode(code, { threads: messages });
  const sweeper = new InboxSweeper({ account: 'student@school.example', cachePath, feedPath, now: () => NOW,
    repl, complete, ...(decide ? { decide } : {}), log });
  return { sweeper, complete, cachePath, feedPath, log, repl };
}
const allowed = async () => ({ show: 0.9, aiBait: 0.01 });

describe('school mail is fail-closed', () => {
  it.each(['missing', 'null', 'throw'] as const)('never calls the text model for a %s safety gate', async failure => {
    const decide = failure === 'missing' ? undefined : async () => {
      if (failure === 'throw') throw new Error('synthetic outage');
      return null;
    };
    const r = rig([email()], decide); const result = await r.sweeper.sweep();
    expect(r.complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sorted: 0, items: 0, pending: 1 });
    expect(JSON.parse(fs.readFileSync(r.cachePath, 'utf8')).threads).toEqual({});
    expect(JSON.parse(fs.readFileSync(r.feedPath, 'utf8')).signals).toEqual([]);
  });
  it('a failed chunk invalidates the whole mail check', async () => {
    const r = rig([email({ body: 'Ordinary volunteer instructions. '.repeat(180) })], async state => state.includes('[continued]') ? null : allowed());
    expect((await r.sweeper.sweep()).pending).toBe(1);
    expect(r.complete).not.toHaveBeenCalled();
  });
  it('retries the same unchanged mail after the safety gate recovers', async () => {
    let online = false; const r = rig([email()], async () => online ? allowed() : null);
    await r.sweeper.sweep(); expect(r.complete).not.toHaveBeenCalled();
    online = true; expect(await r.sweeper.sweep()).toMatchObject({ sorted: 1, pending: 0 });
    expect(r.complete).toHaveBeenCalledTimes(1);
    await r.sweeper.sweep(); expect(r.complete).toHaveBeenCalledTimes(1);
  });
  it('rejects empty, thrown, or malformed probability answers', async () => {
    expect(await gateAll(allowed, [])).toBeNull();
    expect(await gateAll(async () => { throw new Error('offline'); }, ['data'])).toBeNull();
    for (const answer of [{ show: NaN, aiBait: 0 }, { show: 1, aiBait: Infinity }, { show: 2, aiBait: 0 }, { show: 1, aiBait: 0, done: -1 }, undefined]) {
      expect(await gateAll(async () => answer as never, ['data'])).toBeNull();
    }
  });
  it('checks the complete transformed view, not just the first 6000 raw characters', async () => {
    const body = ('https://school.example/' + 'x'.repeat(1000) + ' ').repeat(8) + 'UNVERIFIED-TAIL';
    const r = rig([email({ body })], async state => state.includes('UNVERIFIED-TAIL') ? null : allowed());
    await r.sweeper.sweep(); expect(r.complete).not.toHaveBeenCalled();
  });
  it('checks the student reply before the text model can read it', async () => {
    const r = rig([email({ repliedByMe: true, myReply: 'UNVERIFIED-REPLY' })], async state => state.includes('UNVERIFIED-REPLY') ? null : allowed());
    await r.sweeper.sweep(); expect(r.complete).not.toHaveBeenCalled();
  });
  it('never reuses a done signal left by a failed classification', async () => {
    let first = true; const r = rig([email()], async () => first ? { show: 0.9, aiBait: 0.01, done: 0.9 } : { show: 0.01, aiBait: 0.01 });
    r.complete.mockRejectedValueOnce(new Error('synthetic model outage'));
    await r.sweeper.sweep(); first = false; await r.sweeper.sweep();
    expect(JSON.parse(fs.readFileSync(r.feedPath, 'utf8')).signals).toEqual([]);
  });
  it('invalidates cached classifications from the previous unsafe rules', async () => {
    const r = rig([email()], async () => null);
    fs.writeFileSync(r.cachePath, JSON.stringify({ version: 5, threads: {
      [email().threadId]: { at: email().at, sortedAt: NOW.toISOString(), entry: { id: 'legacy-unsafe', title: 'Old unsafe verdict' } },
    } }));
    expect(CACHE_VERSION).toBeGreaterThan(5);
    expect(await r.sweeper.sweep()).toMatchObject({ items: 0, pending: 1 });
    expect(r.complete).not.toHaveBeenCalled();
  });
});

describe('recognized sensitive school mail stays local', () => {
  it.each([
    { subject: 'Verification code', body: 'Your code is 123456.' },
    { subject: 'Payment received', body: 'Your card ending 1234 was charged.' },
    { subject: 'Account security alert', body: 'New sign-in from a device.' },
    { subject: 'Patient portal', body: 'Medical test results are available.' },
    { subject: 'Appointment', body: 'Private attachment', attachments: ['I-797.pdf'] },
  ])('does not expose $subject to either model or telemetry', async sensitive => {
    const decide = vi.fn(allowed); const r = rig([email(sensitive)], decide);
    expect(await r.sweeper.sweep()).toMatchObject({ sorted: 1, items: 0, pending: 0 });
    expect(decide).not.toHaveBeenCalled(); expect(r.complete).not.toHaveBeenCalled();
    const stored = fs.readFileSync(r.feedPath, 'utf8') + fs.readFileSync(r.cachePath, 'utf8') + JSON.stringify(r.log.mock.calls);
    expect(stored).not.toContain(sensitive.subject); expect(stored).not.toContain(sensitive.body);
  });
});

const task: BriefInput = { kind: 'coursework', source: 'schoology', title: 'Physics lab', context: 'Physics',
  dueISO: null, url: 'https://school.schoology.com/assignment/123456789', steps: [], taint: null, flag: null };
describe('action helpers have a code-level stop', () => {
  it('offers read-only research but no action-capable preparation', () => {
    const brief = briefFor(task); expect(brief.mode).toBe('none');
    expect(brief.research?.kind).toBe('reader');
    expect(brief.note).toMatch(/approval|disabled|unavailable/i);
  });
  it('does not build an action prompt even from a forged agent brief', () => {
    expect(agentPromptFor(task, { ...briefFor(task), mode: 'agent' })).toBeNull();
  });
  it('keeps tool-less school reply drafting separate', () => {
    expect(briefFor({ ...task, source: 'school-mail', kind: 'reply', taint: 'email' }).mode).toBe('draft');
    expect(briefFor({ ...task, source: 'mail', kind: 'reply', taint: 'email' })).toMatchObject({ mode: 'none', research: null });
  });
});


describe('reply drafts honor current safety, not just cached task flags', () => {
  it.each(['missing', 'null', 'throw'] as const)('refuses an unchecked draft when the gate is %s', async failure => {
    const r = rig([email()]);
    const decide = failure === 'missing' ? undefined : async () => { if (failure === 'throw') throw new Error('offline'); return null; };
    const d = new ReplyDrafter({ account: 'student@school.example', repl: r.repl, complete: r.complete, ...(decide ? { decide } : {}) });
    expect(await d.draft(email().threadId)).toEqual({ error: 'safety_unavailable' });
    expect(r.complete).not.toHaveBeenCalled();
  });
  it('refuses a newly sensitive email before either model', async () => {
    const r = rig([email({ body: 'Your verification code is 123456.' })]); const decide = vi.fn(allowed);
    const d = new ReplyDrafter({ account: 'student@school.example', repl: r.repl, complete: r.complete, decide });
    expect(await d.draft(email().threadId)).toEqual({ error: 'private_mail' });
    expect(decide).not.toHaveBeenCalled(); expect(r.complete).not.toHaveBeenCalled();
  });
  it('still returns a tool-less draft for an ordinary fully checked email', async () => {
    const r = rig([email()]); r.complete.mockResolvedValue('Hi teacher,\n\nI can volunteer Saturday.\n\nThank you.');
    const d = new ReplyDrafter({ account: 'student@school.example', repl: r.repl, complete: r.complete, decide: allowed });
    expect(await d.draft(email().threadId)).toMatchObject({ text: expect.stringContaining('volunteer Saturday') });
    expect(r.complete).toHaveBeenCalledTimes(1);
  });
});

describe('safety endpoint cannot be moved outside loopback', () => {
  it.each(['https://outside.example/v1', 'http://127.0.0.1.evil.example/v1', 'not a URL'])('refuses %s without any fetch', async baseUrl => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const decide = jevDecider({ baseUrl, apiKey: 'synthetic-only', model: 'synthetic' }, fetcher);
    expect(await decide('synthetic state')).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
  });
});
