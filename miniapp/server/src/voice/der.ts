/**
 * A minimal DER reader, just enough to walk an Android key attestation
 * extension. It never allocates beyond the input and throws on anything
 * malformed, so a hostile certificate fails closed instead of confusing
 * the parser.
 */

export interface DerNode {
  /** Tag class: 0 universal, 1 application, 2 context-specific, 3 private. */
  cls: number;
  constructed: boolean;
  /** Tag number (high-tag-number form supported, e.g. [704]). */
  tag: number;
  /** Content bytes (no header). */
  value: Buffer;
  /** Total encoded length including the header. */
  size: number;
}

export class DerError extends Error {
  constructor(msg: string) {
    super(`der: ${msg}`);
    this.name = 'DerError';
  }
}

export function readNode(buf: Buffer, offset = 0): DerNode {
  if (offset >= buf.length) throw new DerError('truncated header');
  const first = buf[offset];
  const cls = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  let p = offset + 1;
  if (tag === 0x1f) {
    tag = 0;
    for (let i = 0; ; i++) {
      if (p >= buf.length || i > 4) throw new DerError('bad tag');
      const b = buf[p++];
      tag = (tag << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
  }
  if (p >= buf.length) throw new DerError('truncated length');
  let len = buf[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new DerError('bad length');
    len = 0;
    for (let i = 0; i < n; i++) {
      if (p >= buf.length) throw new DerError('truncated length');
      len = len * 256 + buf[p++];
    }
  }
  const end = p + len;
  if (end > buf.length) throw new DerError('truncated value');
  return { cls, constructed, tag, value: buf.subarray(p, end), size: end - offset };
}

/** Children of a constructed node (SEQUENCE / SET / explicit tag). */
export function children(node: DerNode): DerNode[] {
  if (!node.constructed) throw new DerError('not constructed');
  const out: DerNode[] = [];
  let p = 0;
  while (p < node.value.length) {
    const c = readNode(node.value, p);
    out.push(c);
    p += c.size;
    if (out.length > 512) throw new DerError('too many children');
  }
  return out;
}

export function readInteger(node: DerNode): number {
  if (node.cls !== 0 || (node.tag !== 2 && node.tag !== 10)) throw new DerError('not an integer');
  if (node.value.length === 0 || node.value.length > 6) throw new DerError('integer size');
  let v = 0;
  for (const b of node.value) v = v * 256 + b;
  // Negative numbers never appear in the fields we read; refuse them.
  if (node.value[0] & 0x80) throw new DerError('negative integer');
  return v;
}

export function readOctets(node: DerNode): Buffer {
  if (node.cls !== 0 || node.tag !== 4) throw new DerError('not an octet string');
  return node.value;
}

export function readBoolean(node: DerNode): boolean {
  if (node.cls !== 0 || node.tag !== 1 || node.value.length !== 1) throw new DerError('not a boolean');
  return node.value[0] !== 0;
}
