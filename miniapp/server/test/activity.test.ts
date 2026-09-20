import { describe, expect, it } from 'vitest';
import { ActivityReader, type LiveActivity } from '../src/activity.js';

function fixture() {
  const seen: LiveActivity[] = [];
  const reader = new ActivityReader(a => seen.push(a));
  const event = (e: unknown) => reader.feed(JSON.stringify(e) + '\n');
  const part = (type: string) => event({ type: 'message_update', assistantMessageEvent: { type, delta: 'PRIVATE_REASONING', partial: { secret: 'PRIVATE_ARGUMENT' } } });
  return { seen, reader, event, part };
}
describe('structured live activity', () => {
  it('follows explicit starts and ends, not a busy fallback or text matching', () => {
    const f = fixture();
    f.event({ type: 'agent_start' });
    expect(f.seen.at(-1)).toEqual({ phase: null, tools: [], summary: null });
    f.part('thinking_start');
    expect(f.seen.at(-1)?.phase).toBe('thinking');
    f.part('thinking_end');
    expect(f.seen.at(-1)?.phase).toBeNull();
    f.part('text_start');
    expect(f.seen.at(-1)?.phase).toBe('writing');
    f.part('text_end');
    expect(f.seen.at(-1)?.phase).toBeNull();
  });
  it('forwards no reasoning, message content, arguments, or identifiers', () => {
    const f = fixture();
    f.part('thinking_delta');
    f.event({ type: 'tool_execution_start', toolCallId: 'PRIVATE_ID', toolName: 'functions.read_file', args: { path: 'PRIVATE_PATH', title: 'Measuring sync latency' } });
    expect(f.seen.at(-1)).toEqual({ phase: null, tools: ['read_file'], summary: 'Measuring sync latency' });
    expect(JSON.stringify(f.seen)).not.toContain('PRIVATE');
    expect(JSON.stringify(f.seen)).not.toContain('PRIVATE_PATH');
  });
  it('keeps parallel tools until each actual end, including failed tools', () => {
    const f = fixture();
    f.event({ type: 'tool_execution_start', toolCallId: '1', toolName: 'read_file' });
    f.event({ type: 'tool_execution_start', toolCallId: '2', toolName: 'edit_file' });
    f.event({ type: 'tool_execution_end', toolCallId: '1', isError: true });
    expect(f.seen.at(-1)?.tools).toEqual(['edit_file']);
    expect(f.seen.at(-1)?.summary).toBeNull();
    f.event({ type: 'tool_execution_end', toolCallId: '2' });
    expect(f.seen.at(-1)?.tools).toEqual([]);
    expect(f.seen.at(-1)?.summary).toBeNull();
  });
  it('holds the latest purpose through tool end, later thinking, and writing', () => {
    const f = fixture();
    f.event({ type: 'tool_execution_start', toolCallId: '1', toolName: 'bash', args: { title: 'Planning tool status synchronization' } });
    f.event({ type: 'tool_execution_end', toolCallId: '1' });
    expect(f.seen.at(-1)).toEqual({ phase: null, tools: [], summary: 'Planning tool status synchronization' });
    f.part('thinking_start');
    expect(f.seen.at(-1)?.summary).toBe('Planning tool status synchronization');
    f.part('thinking_end');
    f.part('text_start');
    expect(f.seen.at(-1)).toEqual({ phase: 'writing', tools: [], summary: 'Planning tool status synchronization' });
    f.event({ type: 'agent_end' });
    expect(f.seen.at(-1)).toEqual({ phase: null, tools: [], summary: 'Planning tool status synchronization' });
  });
  it('accepts arbitrary chunk boundaries and suppresses repeated delta announcements', () => {
    const f = fixture();
    const raw = JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } }) + '\n';
    for (const ch of raw) f.reader.feed(ch);
    f.reader.feed(raw);
    expect(f.seen).toEqual([{ phase: 'thinking', tools: [], summary: null }]);
  });
  it('keeps phase honest but clears the old purpose when a new run starts', () => {
    const f = fixture();
    f.event({ type: 'tool_execution_start', toolCallId: '1', toolName: 'bash', args: { title: 'Planning tool status synchronization' } });
    f.event({ type: 'agent_start' });
    expect(f.seen.at(-1)).toEqual({ phase: null, tools: [], summary: null });
  });
  it('clears activity on a malformed frame or explicit pipe reset', () => {
    const f = fixture();
    f.part('thinking_start'); f.reader.feed('not json\n');
    expect(f.seen.at(-1)?.phase).toBeNull();
    f.part('thinking_start'); f.event({ type: 'agent_end' });
    expect(f.seen.at(-1)?.phase).toBeNull();
    f.part('thinking_start'); f.reader.pause();
    expect(f.seen.at(-1)?.phase).toBeNull();
  });
});
