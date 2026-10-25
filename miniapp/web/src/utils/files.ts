/**
 * Small, pure helpers for showing a file: what kind it is, its short type
 * label, a readable size, and its name split so the extension survives
 * truncation ("incident-re….pdf" rather than "incident-review.p…").
 */

export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'sheet' | 'code' | 'archive' | 'doc' | 'file';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|json|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|yml|yaml|toml|sql|html|css|scss|xml|md)$/i;
const SHEET = /\.(csv|tsv|xls|xlsx|numbers|ods)$/i;
const ARCHIVE = /\.(zip|tar|gz|tgz|bz2|7z|rar|xz)$/i;
const DOC = /\.(doc|docx|rtf|txt|pages|odt|ppt|pptx|key)$/i;

export function fileKind(name: string, mimeType = ''): FileKind {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  // Extensions first: browsers report a TypeScript ".ts" as video/mp2t.
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (SHEET.test(name)) return 'sheet';
  if (ARCHIVE.test(name)) return 'archive';
  if (CODE.test(name)) return 'code';
  if (DOC.test(name)) return 'doc';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (/spreadsheet|excel|csv/.test(mime)) return 'sheet';
  if (/zip|x-tar|gzip|compressed/.test(mime)) return 'archive';
  if (/json|javascript|typescript|x-python|x-sh/.test(mime)) return 'code';
  if (mime.startsWith('text/') || /word|presentation/.test(mime)) return 'doc';
  return 'file';
}

/** "PDF", "TS", "PNG": the extension, else the MIME subtype, else "File". */
export function typeLabel(name: string, mimeType = ''): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1];
  if (ext) return ext.toUpperCase();
  const sub = mimeType.split('/')[1]?.split(/[+;.-]/)[0];
  return sub ? sub.toUpperCase() : 'File';
}

/** 2.4 MB, 684 KB, 1.2 KB, 512 B. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The name minus its extension, and the extension (with its dot). */
export function splitName(name: string): { stem: string; ext: string } {
  const at = name.lastIndexOf('.');
  if (at <= 0 || at === name.length - 1 || name.length - at > 9) return { stem: name, ext: '' };
  return { stem: name.slice(0, at), ext: name.slice(at) };
}
