import { describe, expect, it } from 'vitest';
import { JsonlFramer } from '../src/watcher.js';

describe('JsonlFramer', () => {
  it('emits a split record once, only after its newline arrives', () => {
    const framer = new JsonlFramer();

    expect(framer.push(Buffer.from('{"role":"assistant",'))).toEqual([]);
    expect(framer.push(Buffer.from('"content":"done"}'))).toEqual([]);
    expect(framer.push(Buffer.from('\n'))).toEqual([
      '{"role":"assistant","content":"done"}',
    ]);
  });

  it('preserves order when a chunk finishes one line and carries more', () => {
    const framer = new JsonlFramer();
    expect(framer.push(Buffer.from('{"id":1'))).toEqual([]);
    expect(
      framer.push(Buffer.from('}\n{"id":2}\n{"id":3')),
    ).toEqual(['{"id":1}', '{"id":2}']);
    expect(framer.push(Buffer.from('}\n'))).toEqual(['{"id":3}']);
  });

  it('keeps multibyte text intact when a code point is split across chunks', () => {
    const framer = new JsonlFramer();
    const record = Buffer.from('{"text":"smooth ✨"}\n');
    const split = record.indexOf(Buffer.from('✨')) + 1;

    expect(framer.push(record.subarray(0, split))).toEqual([]);
    expect(framer.push(record.subarray(split))).toEqual([
      '{"text":"smooth ✨"}',
    ]);
  });

  it('drops an abandoned partial record on reset', () => {
    const framer = new JsonlFramer();
    expect(framer.push(Buffer.from('{"old":'))).toEqual([]);
    framer.reset();
    expect(framer.push(Buffer.from('{"new":true}\n'))).toEqual([
      '{"new":true}',
    ]);
  });
});
