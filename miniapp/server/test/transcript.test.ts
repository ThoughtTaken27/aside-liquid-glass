import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LIVE_TRANSCRIPT_WINDOW_MS,
  parseTranscript,
  stripMarkdown,
  tailIsUnfinishedTurn,
  TranscriptLiveness,
  transcriptIsLive,
  TranscriptParser,
} from '../src/transcript.js';
import { readFixture } from './helpers.js';

function jsonl(...records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

const userMsg = { role: 'user', content: 'hi', timestamp: 1 };
function toolCallMsg(id: string, stopReason = 'toolUse') {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'read_file', arguments: {} }],
    stopReason,
    timestamp: 2,
  };
}
function toolResultMsg(id: string) {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read_file',
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    timestamp: 3,
  };
}
function assistantTextMsg(stopReason = 'endTurn') {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    stopReason,
    timestamp: 4,
  };
}

describe('transcript parser', () => {
  it('parses text, thinking, tool calls and tool results', () => {
    const { entries } = parseTranscript(readFixture('2026-01-02_fixtureAAAA'));
    const kinds = entries.map((e) => e.kind);

    // the system-message line produces nothing
    expect(kinds).toEqual([
      'user',
      'thinking',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'assistant_text',
    ]);

    const user = entries[0] as any;
    expect(user.text).toBe('Summarize the fixture plan');
    expect(user.line).toBe(1);

    const thinking = entries[1] as any;
    expect(thinking.text).toContain('summary of the fixture plan');

    const titled = entries[2] as any;
    expect(titled.title).toBe('Read example.txt'); // arguments.title wins
    expect(titled.name).toBe('read_file');

    const untitled = entries[4] as any;
    expect(untitled.title).toBe('list_directory'); // falls back to tool name

    const errored = entries[5] as any;
    expect(errored.isError).toBe(true);
    expect(errored.preview).toBe('example.txt notes.md');

    const final = entries[6] as any;
    expect(final.text).toContain('fixture summary');
    expect(final.model).toBe('claude-sonnet-5');
  });

  it('gives every entry a stable id keyed on line and part', () => {
    const { entries } = parseTranscript(readFixture('2026-01-02_fixtureAAAA'));
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[1]).toBe('2:0');
    expect(ids[2]).toBe('2:1');
  });

  it('tracks the subagent lifecycle across the task_id re-key', () => {
    const { entries } = parseTranscript(readFixture('2026-01-03_fixtureBBBB'));
    const subagents = entries.filter((e) => e.kind === 'subagent') as any[];

    expect(subagents.map((s) => s.event)).toEqual(['spawn', 'wait', 'result']);

    expect(subagents[0].desc).toBe('Audit the config loader'); // whitespace collapsed
    expect(subagents[0].profile).toBe('explore');
    expect(subagents[0].background).toBe(true);

    // wait + result carry only a task_id, yet resolve to the spawn's
    // description because the spawn toolResult re-keyed the registry.
    expect(subagents[1].taskId).toBe('task_fixture_9001');
    expect(subagents[1].desc).toBe('Audit the config loader');
    expect(subagents[2].desc).toBe('Audit the config loader');
    expect(subagents[2].text).toBe(
      'The config loader handles missing files cleanly.',
    );
    expect(subagents[2].isError).toBe(false);
  });

  it('drops the partial trailing line and reports the last complete line', () => {
    const buffer = readFixture('2026-01-03_fixtureBBBB');
    expect(buffer.endsWith('\n')).toBe(false); // fixture ends mid-write
    const { entries, lastLine } = parseTranscript(buffer);

    expect(lastLine).toBe(6); // the 8th line is incomplete
    const texts = entries.filter((e) => e.kind === 'assistant_text') as any[];
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe('The audit came back clean.');
  });

  it('emits the partial line once it is completed', () => {
    const partial = readFixture('2026-01-03_fixtureBBBB');
    const completed = `${partial}ten"}],"timestamp":1767398407}\n`;
    const { entries, lastLine } = parseTranscript(completed);
    const texts = entries.filter((e) => e.kind === 'assistant_text') as any[];
    expect(lastLine).toBe(7);
    expect(texts.map((t) => t.text)).toEqual([
      'The audit came back clean.',
      'this line is still being written',
    ]);
  });

  it('honours afterLine while still replaying subagent state', () => {
    const buffer = readFixture('2026-01-03_fixtureBBBB');
    const { entries } = parseTranscript(buffer, { afterLine: 3 });
    expect(entries.every((e) => e.line > 3)).toBe(true);
    const result = entries.find(
      (e) => e.kind === 'subagent' && (e as any).event === 'result',
    ) as any;
    // desc only resolves if lines 1-2 were replayed despite being filtered
    expect(result.desc).toBe('Audit the config loader');
  });

  it('skips corrupt lines instead of throwing', () => {
    const parser = new TranscriptParser();
    expect(parser.feedLine('{not json', 0)).toEqual([]);
    expect(parser.feedLine('', 1)).toEqual([]);
    expect(parser.feedLine('{"role":"user","content":"ok"}', 2)).toHaveLength(1);
  });

  it('emits one entry per task_id in a multi-subagent wait result', () => {
    const parser = new TranscriptParser();
    parser.feedLine(
      JSON.stringify({
        role: 'toolResult',
        toolCallId: 'toolu_wait',
        toolName: 'subagent_wait',
        content: [
          {
            type: 'text',
            text:
              '<subagent_result task_id="t1">first</subagent_result>' +
              '<subagent_result task_id="t2">second</subagent_result>',
          },
        ],
        isError: false,
        timestamp: 1767398404,
      }),
      0,
    );
    const entries = parser.feedLine(
      JSON.stringify({
        role: 'toolResult',
        toolCallId: 'toolu_wait2',
        toolName: 'subagent_wait',
        content: [
          {
            type: 'text',
            text:
              '<subagent_result task_id="t3">third</subagent_result>' +
              '<subagent_result task_id="t4">fourth</subagent_result>',
          },
        ],
        isError: true,
        timestamp: 1767398405,
      }),
      1,
    ) as any[];
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.taskId)).toEqual(['t3', 't4']);
    expect(entries.map((e) => e.text)).toEqual(['third', 'fourth']);
    expect(entries.every((e) => e.isError)).toBe(true);
    expect(new Set(entries.map((e) => e.id)).size).toBe(2);
  });
});

describe('stripMarkdown', () => {
  it('flattens the syntax that would otherwise show in a card preview', () => {
    expect(stripMarkdown('1. **Opener** — today’s a double SAT day')).toBe(
      'Opener — today’s a double SAT day',
    );
    expect(stripMarkdown('Full plan saved to **`artifacts/plan.md`**')).toBe(
      'Full plan saved to artifacts/plan.md',
    );
    expect(stripMarkdown('## Heading\n- bullet\n> quote')).toBe(
      'Heading\nbullet\nquote',
    );
    expect(stripMarkdown('see [the docs](https://x.com)')).toBe('see the docs');
    expect(stripMarkdown('_emphasis_ and *stars*')).toBe('emphasis and stars');
  });

  it('leaves ordinary prose and intra-word underscores alone', () => {
    expect(stripMarkdown('plain sentence, no markup')).toBe(
      'plain sentence, no markup',
    );
    expect(stripMarkdown('call read_file with a_b_c')).toBe(
      'call read_file with a_b_c',
    );
  });

  it('drops fenced code rather than dumping it into the preview', () => {
    expect(stripMarkdown('before\n```js\nconst x = 1;\n```\nafter').trim())
      .toBe('before\n \nafter'.trim());
  });

  it('handles empty input', () => {
    expect(stripMarkdown('')).toBe('');
  });
});

describe('tailIsUnfinishedTurn', () => {
  it('treats a fully resolved multi-call turn as finished', () => {
    // Two tool calls, both resolved, ending on a terminal assistant stop --
    // this is the exact shape of the fixtureAAAA transcript, and the
    // regression case: a naive backward walk meets each toolResult BEFORE
    // the toolCall it answers, since results are always written after
    // their call. Deleting-on-result before the id exists must not leave
    // the id looking permanently open.
    const buffer = jsonl(
      userMsg,
      toolCallMsg('call-1'),
      toolResultMsg('call-1'),
      toolCallMsg('call-2'),
      toolResultMsg('call-2'),
      assistantTextMsg('endTurn'),
    );
    expect(tailIsUnfinishedTurn(buffer)).toBe(false);
  });

  it('treats an open trailing tool call as unfinished', () => {
    const buffer = jsonl(userMsg, toolCallMsg('call-1'));
    expect(tailIsUnfinishedTurn(buffer)).toBe(true);
  });

  it('treats a resolved call followed by a new open call as unfinished', () => {
    const buffer = jsonl(
      userMsg,
      toolCallMsg('call-1'),
      toolResultMsg('call-1'),
      toolCallMsg('call-2'),
    );
    expect(tailIsUnfinishedTurn(buffer)).toBe(true);
  });

  it('treats a trailing assistant record with no terminal stop as unfinished', () => {
    const buffer = jsonl(userMsg, assistantTextMsg('length'));
    // 'length' is a non-toolUse stop, so per the terminal-stop rule this
    // IS terminal (anything other than 'toolUse' counts). Use an explicit
    // in-flight-style value with no stopReason field at all instead.
    const inFlight = jsonl(userMsg, { ...assistantTextMsg(), stopReason: undefined });
    expect(tailIsUnfinishedTurn(buffer)).toBe(false);
    expect(tailIsUnfinishedTurn(inFlight)).toBe(true);
  });

  it('stops walking back at the user boundary', () => {
    // An open call from a PRIOR turn, closed by the time of the current
    // (finished) turn, must not leak liveness across the user boundary.
    const buffer = jsonl(
      userMsg,
      toolCallMsg('old-call'),
      toolResultMsg('old-call'),
      assistantTextMsg('endTurn'),
      userMsg,
      assistantTextMsg('endTurn'),
    );
    expect(tailIsUnfinishedTurn(buffer)).toBe(false);
  });
});

describe('transcriptIsLive', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-live-test-'));
    file = path.join(dir, 'messages.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is false for a finished transcript even when freshly written', () => {
    fs.writeFileSync(
      file,
      jsonl(
        userMsg,
        toolCallMsg('call-1'),
        toolResultMsg('call-1'),
        toolCallMsg('call-2'),
        toolResultMsg('call-2'),
        assistantTextMsg('endTurn'),
      ),
    );
    expect(transcriptIsLive(file)).toBe(false);
  });

  it('is true for an open trailing call within the recency window', () => {
    fs.writeFileSync(file, jsonl(userMsg, toolCallMsg('call-1')));
    expect(transcriptIsLive(file)).toBe(true);
  });

  it('is false once the open call is outside the recency window', () => {
    fs.writeFileSync(file, jsonl(userMsg, toolCallMsg('call-1')));
    const stale = Date.now() / 1000 - (LIVE_TRANSCRIPT_WINDOW_MS / 1000 + 60);
    fs.utimesSync(file, stale, stale);
    expect(transcriptIsLive(file)).toBe(false);
  });

  it('is false when the file does not exist', () => {
    expect(transcriptIsLive(path.join(dir, 'missing.jsonl'))).toBe(false);
  });

  it('reuses the parsed tail while the file signature is unchanged', () => {
    const fixedLine = (record: unknown) => {
      const json = JSON.stringify(record);
      return `${json}${' '.repeat(512 - json.length)}\n`;
    };
    const fixedTime = new Date('2026-08-24T12:00:00.000Z');
    const now = fixedTime.getTime() + 1_000;
    const liveness = new TranscriptLiveness();

    fs.writeFileSync(file, fixedLine({ ...assistantTextMsg(), stopReason: undefined }));
    fs.utimesSync(file, fixedTime, fixedTime);
    expect(liveness.isLive(file, { now: () => now })).toBe(true);

    // Same path, size and mtime: the expensive tail classification is reused.
    fs.writeFileSync(file, fixedLine(assistantTextMsg('endTurn')));
    fs.utimesSync(file, fixedTime, fixedTime);
    expect(liveness.isLive(file, { now: () => now })).toBe(true);
  });

  it('parses the tail again after the file signature changes', () => {
    const liveness = new TranscriptLiveness();
    fs.writeFileSync(file, jsonl(userMsg, toolCallMsg('call-1')));
    expect(liveness.isLive(file)).toBe(true);

    fs.writeFileSync(file, jsonl(userMsg, assistantTextMsg('endTurn')));
    expect(liveness.isLive(file)).toBe(false);
  });

  it('recalculates recency even when the parsed tail is cached', () => {
    const liveness = new TranscriptLiveness();
    const writtenAt = new Date('2026-08-24T12:00:00.000Z');
    let now = writtenAt.getTime() + 1_000;
    fs.writeFileSync(file, jsonl(userMsg, toolCallMsg('call-1')));
    fs.utimesSync(file, writtenAt, writtenAt);

    expect(liveness.isLive(file, { now: () => now })).toBe(true);
    now += LIVE_TRANSCRIPT_WINDOW_MS + 1;
    expect(liveness.isLive(file, { now: () => now })).toBe(false);
  });
});
