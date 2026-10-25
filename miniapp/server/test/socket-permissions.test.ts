import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { startContextSocket, type ContextSocketOptions } from '../src/contextsocket.js';
import { startJevSocket, type JevSocketOptions } from '../src/jevsocket.js';

const start = (kind: 'context' | 'jev', socketPath: string, log?: (msg: string) => void) => kind === 'context'
  ? startContextSocket({ socketPath, ctx: {} as ContextSocketOptions['ctx'], log })
  : startJevSocket({ socketPath, jev: {} as JevSocketOptions['jev'], complete: () => null, log });

it('overlapping local socket startup preserves the global mask and usable private directories', async () => {
  const original = process.umask(0o022);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sock-mask-'));
  const sockets: Array<{ close: () => Promise<void> }> = [];
  try {
    for (const kind of ['jev', 'context'] as const) {
      sockets.push(start(kind, path.join(dir, kind + '.sock')));
      expect(process.umask()).toBe(0o022);
    }
    const nested = path.join(dir, 'usable');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'probe'), 'synthetic');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(process.umask()).toBe(0o022);
    for (const kind of ['jev', 'context']) expect(fs.statSync(path.join(dir, kind + '.sock')).mode & 0o777).toBe(0o600);
  } finally {
    await Promise.all(sockets.map(socket => socket.close()));
    process.umask(original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['jev', 'context'] as const)('%s bind errors do not change the process mask', async kind => {
  const original = process.umask(0o022);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sock-err-'));
  let socket: { close: () => Promise<void> } | undefined;
  const events: string[] = [];
  try {
    socket = start(kind, path.join(dir, 'x'.repeat(140) + '.sock'), msg => events.push(msg));
    expect(process.umask()).toBe(0o022);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(events.some(msg => msg.includes('socket error'))).toBe(true);
    expect(process.umask()).toBe(0o022);
  } finally {
    await socket?.close();
    process.umask(original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
