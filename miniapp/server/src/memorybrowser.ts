/**
 * Read-only browser for this account's own Aside memory folder
 * (`~/.aside/u/<id>/memory`) -- the semantic pages the agent itself
 * maintains. Day 4 plan 8.1: a tree, and a single file's content.
 *
 * Editing memory from a phone is explicitly out of scope (plan section
 * 10): "Corrupting memory from a thumb is a bad trade." This module has
 * no write path at all, by construction, not just by the routes that call
 * it.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Markdown is the format this memory system is written in; anything else in that tree is not a page meant to be read this way. */
const ALLOWED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const SKIP_ENTRIES = new Set(['.git', 'node_modules']);

export interface MemoryNode {
  name: string;
  /** Relative to the memory root -- what the client sends back to read it. */
  relPath: string;
  type: 'file' | 'dir';
  children?: MemoryNode[];
}

function walk(absDir: string, relDir: string): MemoryNode[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: MemoryNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_ENTRIES.has(entry.name)) continue;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const children = walk(path.join(absDir, entry.name), rel);
      if (children.length) {
        nodes.push({ name: entry.name, relPath: rel, type: 'dir', children });
      }
      continue;
    }
    if (!ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    nodes.push({ name: entry.name, relPath: rel, type: 'file' });
  }
  // Directories first, then alphabetical -- matches how a file tree reads.
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

export function buildMemoryTree(root: string): MemoryNode[] {
  return walk(root, '');
}

/**
 * Resolve a client-supplied relative path against the memory root with
 * the same realpath-containment discipline `localfiles.ts` uses for
 * images: a symlink or a `..` cannot walk the read outside the root.
 */
export function resolveMemoryFile(root: string, relPath: unknown): string | null {
  if (typeof relPath !== 'string' || !relPath || relPath.includes('\0')) {
    return null;
  }
  if (!ALLOWED_EXTENSIONS.has(path.extname(relPath).toLowerCase())) return null;
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = fs.realpathSync(root);
    realTarget = fs.realpathSync(path.resolve(root, relPath));
  } catch {
    return null;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    return null;
  }
  const stat = fs.statSync(realTarget, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) return null;
  return realTarget;
}

export function readMemoryFile(absPath: string): string {
  return fs.readFileSync(absPath, 'utf8');
}
