/**
 * Full-history parsing, and the thread it builds.
 *
 * This is the regression suite for the session that rendered as one bare
 * fold. Its cause was not the grouping rules -- it was the SOURCE.
 * `aside.sessions.messages(id)` returns the agent's current CONTEXT, so on
 * a long session it begins mid-conversation: a `system-message` with a
 * STRING body, one user message, then a wall of tool activity, with the
 * earlier turns gone. The fixtures below reproduce each of those shapes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OMIT_IMAGE_CHARS,
  clearHistoryCache,
  normalizeTimestamp,
  parseHistory,
  readHistory,
  stripOversizedData,
} from '../src/jsonl.js';
import { buildThread, imageParts } from '../src/thread.js';

const line = (obj: unknown) => JSON.stringify(obj);

describe('parseHistory', () => {
  it('reads a plain conversation', () => {
    const messages = parseHistory(
      [
        line({ role: 'user', content: 'hello', timestamp: 1767312000 }),
        line({
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          timestamp: 1767312001,
        }),
      ].join('\n'),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('hello');
    // Seconds on disk, milliseconds everywhere above it.
    expect(messages[0].timestamp).toBe(1767312000000);
  });

  /** The CLI writes user bodies as bare strings, not part arrays. */
  it('accepts a string content body', () => {
    const [msg] = parseHistory(line({ role: 'user', content: 'plain string' }));
    expect(msg.content).toBe('plain string');
  });

  /** The browser hides these; so do we. */
  it('drops system-message records', () => {
    const messages = parseHistory(
      [
        line({
          role: 'system-message',
          kind: 'site_skill',
          content: 'Relevant skill docs are available.',
          timestamp: 1767312000,
        }),
        line({ role: 'user', content: 'the real question' }),
      ].join('\n'),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  /**
   * `user-message-metadata` PRECEDES the user message it belongs to and
   * carries that message's attachments, so it is folded forward rather than
   * surfaced as a row of its own.
   */
  it('folds attachment metadata onto the following user message', () => {
    const messages = parseHistory(
      [
        line({
          role: 'user-message-metadata',
          attachments: [
            {
              id: 'x',
              type: 'file',
              name: 'Screenshot.png',
              mimeType: 'image/png',
              path: './attachments/Screenshot.png',
            },
          ],
          timestamp: 1767312000,
        }),
        line({ role: 'user', content: 'look at this', timestamp: 1767312001 }),
      ].join('\n'),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].attachments).toEqual([
      { name: 'Screenshot.png', mimeType: 'image/png' },
    ]);
  });

  it('carries tool result fields through unchanged', () => {
    const [msg] = parseHistory(
      line({
        role: 'toolResult',
        toolCallId: 'toolu_1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'output' }],
        details: { diff: '+a\n-b' },
        isError: true,
        timestamp: 1767312002,
      }),
    );
    expect(msg.toolName).toBe('bash');
    expect(msg.toolCallId).toBe('toolu_1');
    expect(msg.isError).toBe(true);
    expect(msg.details).toEqual({ diff: '+a\n-b' });
  });

  it('skips corrupt lines instead of failing the read', () => {
    const messages = parseHistory(
      ['{not json', '', line({ role: 'user', content: 'survived' })].join('\n'),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('survived');
  });

  it('normalises both timestamp encodings', () => {
    expect(normalizeTimestamp(1767312000)).toBe(1767312000000);
    expect(normalizeTimestamp(1767312000000)).toBe(1767312000000);
    expect(normalizeTimestamp(0)).toBeUndefined();
    expect(normalizeTimestamp('nope')).toBeUndefined();
  });
});

describe('buildThread over full history', () => {
  /**
   * The acceptance shape: several user bubbles, one fold per work block,
   * and each turn's final answer -- rather than the single fold the facade
   * source produced.
   */
  it('renders every turn of a multi-turn session', () => {
    const messages = parseHistory(
      [
        line({ role: 'system-message', content: 'skill hint', timestamp: 1 }),
        line({ role: 'user', content: 'first question', timestamp: 10 }),
        line({
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hidden' },
            { type: 'toolCall', id: 'c1', name: 'bash', arguments: { title: 'Ran a check' } },
          ],
          timestamp: 11,
        }),
        line({
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'ok' }],
          timestamp: 12,
        }),
        line({
          role: 'assistant',
          content: [{ type: 'text', text: 'first answer' }],
          timestamp: 13,
        }),
        line({ role: 'user', content: 'second question', timestamp: 20 }),
        line({
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c2', name: 'read_file', arguments: { path: '/a/b.ts' } }],
          timestamp: 21,
        }),
        line({
          role: 'toolResult',
          toolCallId: 'c2',
          toolName: 'read_file',
          content: [{ type: 'text', text: 'contents' }],
          timestamp: 22,
        }),
        line({
          role: 'assistant',
          content: [{ type: 'text', text: 'second answer' }],
          timestamp: 23,
        }),
      ].join('\n'),
    );

    const items = buildThread(messages);
    expect(items.map((i) => i.kind)).toEqual([
      'user',
      'work',
      'answer',
      'user',
      'work',
      'answer',
    ]);
    expect((items[0] as any).text).toBe('first question');
    expect((items[2] as any).text).toBe('first answer');
    expect((items[3] as any).text).toBe('second question');
    expect((items[5] as any).text).toBe('second answer');
    // Thinking is never surfaced, here or anywhere.
    expect(JSON.stringify(items)).not.toContain('hidden');
  });

  /**
   * A compacted tail begins with tool activity and no user message in
   * front of it. That must render as a fold and an answer, not vanish --
   * this is the exact shape the facade was handing back.
   */
  it('renders a turn that does not start with a user message', () => {
    const messages = parseHistory(
      [
        line({ role: 'system-message', content: 'injected context' }),
        line({
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { title: 'Mid-turn work' } }],
          timestamp: 11,
        }),
        line({
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'done' }],
          timestamp: 12,
        }),
        line({
          role: 'assistant',
          content: [{ type: 'text', text: 'the tail answer' }],
          timestamp: 13,
        }),
        line({ role: 'user', content: 'a later question', timestamp: 20 }),
        line({
          role: 'assistant',
          content: [{ type: 'text', text: 'a later answer' }],
          timestamp: 21,
        }),
      ].join('\n'),
    );

    const items = buildThread(messages);
    expect(items.map((i) => i.kind)).toEqual([
      'work',
      'answer',
      'user',
      'answer',
    ]);
    expect((items[1] as any).text).toBe('the tail answer');
  });

  /** An assistant record whose body is a string still produces its answer. */
  it('does not lose an answer written as a bare string', () => {
    const items = buildThread(
      parseHistory(
        [
          line({ role: 'user', content: 'q', timestamp: 10 }),
          line({ role: 'assistant', content: 'a string answer', timestamp: 11 }),
        ].join('\n'),
      ),
    );
    expect(items.map((i) => i.kind)).toEqual(['user', 'answer']);
    expect((items[1] as any).text).toBe('a string answer');
  });

  it('puts attachments on the user bubble', () => {
    const items = buildThread(
      parseHistory(
        [
          line({
            role: 'user-message-metadata',
            attachments: [
              { name: 'a.png', mimeType: 'image/png' },
              { name: 'b.pdf', mimeType: 'application/pdf' },
            ],
          }),
          line({ role: 'user', content: 'these two', timestamp: 10 }),
        ].join('\n'),
      ),
    );
    expect((items[0] as any).attachments).toEqual([
      { name: 'a.png', mimeType: 'image/png' },
      { name: 'b.pdf', mimeType: 'application/pdf' },
    ]);
  });

  it('keeps a bubble for an attachments-only message', () => {
    const items = buildThread(
      parseHistory(
        [
          line({ role: 'user-message-metadata', attachments: [{ name: 'a.png' }] }),
          line({ role: 'user', content: '', timestamp: 10 }),
        ].join('\n'),
      ),
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('user');
    expect((items[0] as any).attachments).toHaveLength(1);
  });

  it('marks only the last fold as running', () => {
    const items = buildThread(
      parseHistory(
        [
          line({ role: 'user', content: 'one', timestamp: 10 }),
          line({
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { title: 'A' } }],
            timestamp: 11,
          }),
          line({ role: 'user', content: 'two', timestamp: 20 }),
          line({
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'c2', name: 'bash', arguments: { title: 'B' } }],
            timestamp: 21,
          }),
        ].join('\n'),
      ),
      true,
    );
    const folds = items.filter((i) => i.kind === 'work') as any[];
    expect(folds).toHaveLength(2);
    expect(folds[0].running).toBe(false);
    expect(folds[1].running).toBe(true);
  });
});

describe('readHistory on large and growing transcripts', () => {
  const tmpFile = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-jsonl-'));
    return path.join(dir, 'messages.jsonl');
  };
  const huge = (n: number) => 'A'.repeat(n);

  /**
   * The bug: a screenshot-heavy session's file passed the size cap and the
   * whole thread read as empty, so a running task showed nothing at all.
   */
  it('renders a transcript far past the cap when the bulk is screenshots', () => {
    clearHistoryCache();
    const file = tmpFile();
    const shot = huge(OMIT_IMAGE_CHARS + 10);
    const rows = [line({ role: 'user', content: 'take screenshots', timestamp: 1 })];
    for (let i = 0; i < 6; i += 1) {
      rows.push(
        line({
          role: 'assistant',
          content: [{ type: 'toolCall', id: `c${i}`, name: 'repl', arguments: {} }],
          timestamp: 2 + i,
        }),
        line({
          role: 'toolResult',
          toolCallId: `c${i}`,
          toolName: 'repl',
          content: [{ type: 'text', text: 'shot' }, { type: 'image', data: shot, mimeType: 'image/png' }],
          timestamp: 2 + i,
        }),
      );
    }
    fs.writeFileSync(file, rows.join('\n') + '\n');
    // A cap well under the file's size: retained text is what counts now.
    const messages = readHistory(file, 64 * 1024);
    expect(fs.statSync(file).size).toBeGreaterThan(6 * OMIT_IMAGE_CHARS);
    expect(messages[0].content).toBe('take screenshots');
    expect(messages).toHaveLength(13);
    const result = messages[2].content as Array<Record<string, unknown>>;
    expect(result[1]).toMatchObject({ type: 'image', data: '', omitted: true });
  });

  it('keeps the newest messages, not none, past the retained-text cap', () => {
    clearHistoryCache();
    const file = tmpFile();
    const rows = Array.from({ length: 50 }, (_, i) =>
      line({ role: 'user', content: `${i} ${'x'.repeat(1000)}`, timestamp: i + 1 }),
    );
    fs.writeFileSync(file, rows.join('\n') + '\n');
    const messages = readHistory(file, 10_000);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.length).toBeLessThan(50);
    expect(String(messages.at(-1)!.content).startsWith('49 ')).toBe(true);
  });

  it('parses only what was appended, and holds a half-written line until it lands', () => {
    clearHistoryCache();
    const file = tmpFile();
    fs.writeFileSync(file, line({ role: 'user', content: 'one', timestamp: 1 }) + '\n');
    expect(readHistory(file)).toHaveLength(1);
    fs.appendFileSync(file, '{"role":"user","content":"tw');
    expect(readHistory(file)).toHaveLength(1);
    fs.appendFileSync(file, 'o","timestamp":2}\n');
    const after = readHistory(file);
    expect(after.map((m) => m.content)).toEqual(['one', 'two']);
    // Callers get their own array: mutating it must not leak into the cache.
    after.pop();
    expect(readHistory(file)).toHaveLength(2);
  });

  it('starts over when the file is rewritten rather than appended', () => {
    clearHistoryCache();
    const file = tmpFile();
    fs.writeFileSync(file, line({ role: 'user', content: 'before', timestamp: 1 }) + '\n');
    readHistory(file);
    fs.writeFileSync(file, line({ role: 'user', content: 'after', timestamp: 1 }) + '\n');
    expect(readHistory(file).map((m) => m.content)).toEqual(['after']);
  });

  it('counts a stripped screenshot as not shown instead of dropping it silently', () => {
    expect(
      imageParts([{ type: 'image', data: '', omitted: true }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]),
    ).toEqual({ images: ['data:image/png;base64,AAAA'], dropped: 1 });
  });

  it('leaves a short or quoted "data" field alone', () => {
    const quoted = line({ role: 'user', content: `"data":"${huge(10)}"` });
    expect(stripOversizedData(quoted)).toBe(quoted);
  });
});
