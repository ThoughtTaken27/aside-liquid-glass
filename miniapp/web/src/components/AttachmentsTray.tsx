import { useEffect, useRef, useState } from 'react';
import { usePresenceItems } from '../hooks/usePresenceItems';
import { Collapse } from './Collapse';
import { DoneCheck } from './Affect';
import {
  AlertCircle,
  File as FileGlyph,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Music,
  RotateCw,
  X,
} from 'lucide-react';
import type { Attachment, ComposerAttachment } from '../types';
import { fileKind, formatBytes, splitName, typeLabel, type FileKind } from '../utils/files';
import { openImage } from './ImageLightbox';
import '../theme/attachments.css';

/**
 * What is going with the message, after the AI SDK Agents attachments tray.
 *
 * In the composer: a header (mark, "Attachments", a ready/uploading/failed
 * count), image thumbnails that open the image viewer, and one column of
 * file tiles with a type mark, the name (extension kept through
 * truncation), and type and size. Failures say why, in the tile, and offer
 * retry when another attempt could succeed. Phone changes: remove and retry
 * are always visible with 44px targets (the reference reveals them on
 * hover), there is no second "+" (the composer has one), and uploading
 * shows a spinner, not a percentage, because upload progress is not
 * measured.
 *
 * Sent: the same tiles, read-only and right-aligned above the bubble. A
 * sent message keeps only names and types, so images are tiles there too.
 */

const MARKS: Record<FileKind, typeof FileGlyph> = {
  image: FileImage,
  video: FileVideo,
  audio: Music,
  pdf: FileText,
  sheet: FileSpreadsheet,
  code: FileCode,
  archive: FileArchive,
  doc: FileText,
  file: FileGlyph,
};

function FileName({ name }: { name: string }) {
  const { stem, ext } = splitName(name);
  return (
    <span className="att-name">
      <span className="att-stem">{stem}</span>
      {ext ? <span className="att-ext">{ext}</span> : null}
    </span>
  );
}

function Mark({ kind, state, finished = false }: { kind: FileKind; state: ComposerAttachment['status'] | 'sent'; finished?: boolean }) {
  const Icon = MARKS[kind];
  return (
    <span className="att-mark" aria-hidden>
      {finished ? <DoneCheck size={18} animate /> : state === 'uploading' ? (
        <svg className="att-spinner" viewBox="0 0 20 20" width="20" height="20">
          <circle cx="10" cy="10" r="8" fill="none" strokeWidth="2" className="att-spinner-track" />
          <circle cx="10" cy="10" r="8" fill="none" strokeWidth="2" strokeLinecap="round" strokeDasharray="14 50.3" className="att-spinner-arc" />
        </svg>
      ) : state === 'failed' ? (
        <AlertCircle size={16} strokeWidth={1.8} />
      ) : (
        <Icon size={16} strokeWidth={1.8} />
      )}
    </span>
  );
}

function subline(item: ComposerAttachment): string {
  if (item.status === 'uploading') return 'Uploading…';
  if (item.status === 'failed') return item.error || 'Upload failed';
  const size = item.size !== undefined ? formatBytes(item.size) : '';
  return size ? `${typeLabel(item.name, item.mimeType)} · ${size}` : typeLabel(item.name, item.mimeType);
}

export function trayStatus(items: ComposerAttachment[]): string {
  const n = (s: ComposerAttachment['status']) => items.filter((i) => i.status === s).length;
  const parts = [
    n('ready') ? `${n('ready')} ready` : '',
    n('uploading') ? `${n('uploading')} uploading` : '',
    n('failed') ? `${n('failed')} failed` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

export function AttachmentsTray({
  items,
  onRemove,
  onRetry,
}: {
  items: ComposerAttachment[];
  onRemove: (key: string) => void;
  onRetry?: (key: string) => void;
}) {
  const rows = usePresenceItems(items, item => item.key);
  if (!rows.length) return null;
  return (
    <Collapse open={items.length > 0} className="att-tray-presence">
      <section className="att-tray" aria-label="Attachments" data-slot="attachments-tray" data-empty={items.length === 0 || undefined}>
        <div className="att-head"><span className="att-title">Attachments</span><output className="att-status">{trayStatus(items)}</output></div>
        <ul className="att-items">
          {rows.map(row => <li key={row.key} className="att-presence-row" data-open={row.present && !row.entering ? 'true' : 'false'} data-leaving={!row.present || undefined} inert={!row.present || row.entering || undefined} aria-hidden={!row.present || row.entering || undefined}>
            <div className="att-row-clip"><AttachmentRow item={row.item} leaving={!row.present} onRemove={onRemove} onRetry={onRetry} /></div>
          </li>)}
        </ul>
      </section>
    </Collapse>
  );
}

/** A status change touches its fixed glyph slot, never reorders the row. */
function AttachmentRow({ item, leaving, onRemove, onRetry }: { item: ComposerAttachment; leaving: boolean; onRemove: (key: string) => void; onRetry?: (key: string) => void }) {
  const [prior, setPrior] = useState(item.status);
  const [pulse, setPulse] = useState<'done' | 'error' | null>(null);
  const removed = useRef(false);
  if (prior !== item.status) {
    setPrior(item.status);
    setPulse(prior === 'uploading' && item.status === 'ready' ? 'done' : item.status === 'failed' ? 'error' : null);
  }
  useEffect(() => { if (!pulse) return; const timer = window.setTimeout(() => setPulse(null), pulse === 'done' ? 900 : 420); return () => clearTimeout(timer); }, [pulse]);
  useEffect(() => { if (!leaving) removed.current = false; }, [leaving]);
  const image = Boolean(item.previewUrl && item.mimeType.startsWith('image/'));
  return <div className="att-item" data-status={item.status} data-pulse={pulse ?? undefined}>
    <span className="att-leading">
      {image && item.status !== 'failed' ? <button type="button" className="att-preview" disabled={leaving} aria-label={`Open ${item.name}${item.status === 'uploading' ? ', uploading' : ''}`} onClick={() => openImage({ src: item.previewUrl!, alt: item.name })}>
        <img src={item.previewUrl} alt="" draggable={false} />
        {item.status === 'uploading' || pulse === 'done' ? <span className="att-preview-busy" aria-hidden><Mark kind="image" state={item.status} finished={pulse === 'done'} /></span> : null}
      </button> : <Mark kind={fileKind(item.name, item.mimeType)} state={item.status} finished={pulse === 'done'} />}
    </span>
    <span className="att-text"><FileName name={item.name} /><span className="att-sub">{subline(item)}</span></span>
    {item.status === 'failed' && item.retryable && onRetry ? <button type="button" className="att-row-action" disabled={leaving} aria-label={`Retry ${item.name}`} onClick={() => onRetry(item.key)}><RotateCw size={15} strokeWidth={1.8} /></button> : null}
    <button type="button" className="att-row-action" disabled={leaving} aria-label={`Remove ${item.name}`} onClick={event => { if (!removed.current) {
      removed.current = true;
      const composer = event.currentTarget.closest('.composer');
      const restoreKeyboardFocus = event.detail === 0 && document.activeElement === event.currentTarget;
      onRemove(item.key);
      if (restoreKeyboardFocus) requestAnimationFrame(() => {
        if (!composer?.isConnected) return;
        const target = composer.querySelector<HTMLButtonElement>('.att-presence-row:not([data-leaving]) .att-row-action[aria-label^="Remove "]') ?? composer.querySelector<HTMLButtonElement>('[data-composer-control="attach"]');
        target?.focus({ preventScroll: true });
      });
    } }}><X size={15} strokeWidth={1.8} /></button>
  </div>;
}

export function SentAttachments({ files }: { files: Attachment[] }) {
  if (!files.length) return null;
  return (
    <ul className="att-sent" aria-label="Attached files">
      {files.map((file, index) => (
        <li key={`${file.name}-${index}`} className="att-tile is-sent">
          <Mark kind={fileKind(file.name, file.mimeType)} state="sent" />
          <span className="att-text">
            <FileName name={file.name} />
            <span className="att-sub">{typeLabel(file.name, file.mimeType)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
