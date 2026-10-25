/**
 * The attachments tray, rebuilt on the AI SDK Agents attachments tray.
 *
 * Locks in what a phone user relies on: images preview and open the viewer,
 * every other file names its type and size with the extension surviving
 * truncation, a failure says why and offers retry only when another try
 * could work, retry really resends, paste adds files, and a sent message
 * shows its files beside the bubble rather than inside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AttachmentsTray, SentAttachments, trayStatus } from '../src/components/AttachmentsTray';
import { IMAGE_EVENT } from '../src/components/ImageLightbox';
import { Composer } from '../src/components/Composer';
import { UserBubble } from '../src/components/Thread';
import { useAttachments, uploadReason } from '../src/hooks/useAttachments';
import { ApiError, setAuthToken } from '../src/api';
import { fileKind, formatBytes, splitName, typeLabel } from '../src/utils/files';
import type { ComposerAttachment } from '../src/types';

beforeEach(() => {
  setAuthToken('test-token');
  let n = 0;
  globalThis.URL.createObjectURL = vi.fn(() => `blob:mock/${(n += 1)}`);
  globalThis.URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const item = (over: Partial<ComposerAttachment>): ComposerAttachment => ({
  key: 'k', name: 'report.pdf', mimeType: 'application/pdf', status: 'ready', size: 2_516_582, ...over,
});

describe('file helpers', () => {
  it('trust the extension over an ambiguous browser type', () => {
    expect(fileKind('middleware.ts', 'video/mp2t')).toBe('code');
    expect(fileKind('clip.mp4', 'video/mp4')).toBe('video');
    expect(fileKind('shot.png', 'image/png')).toBe('image');
    expect(fileKind('data.csv', 'text/csv')).toBe('sheet');
    expect(fileKind('bundle.zip', '')).toBe('archive');
  });
  it('label, size, and split names the way the tray shows them', () => {
    expect(typeLabel('incident-review.pdf')).toBe('PDF');
    expect(typeLabel('blob', 'image/png')).toBe('PNG');
    expect(formatBytes(2_516_582)).toBe('2.4 MB');
    expect(formatBytes(1_229)).toBe('1.2 KB');
    expect(formatBytes(700_416)).toBe('684 KB');
    expect(splitName('incident-review.pdf')).toEqual({ stem: 'incident-review', ext: '.pdf' });
    expect(splitName('.env')).toEqual({ stem: '.env', ext: '' });
    expect(splitName('README')).toEqual({ stem: 'README', ext: '' });
  });
  it('summarize only the states present', () => {
    expect(trayStatus([item({}), item({ status: 'uploading' }), item({ status: 'failed' })])).toBe('1 ready · 1 uploading · 1 failed');
    expect(trayStatus([item({}), item({ key: 'b' })])).toBe('2 ready');
  });
});

describe('the composer tray', () => {
  it('previews images, opens them in the viewer, and lists files with type and size', () => {
    const opened = vi.fn();
    window.addEventListener(IMAGE_EVENT, opened as EventListener);
    render(
      <AttachmentsTray
        items={[
          item({ key: 'i', name: 'shot.png', mimeType: 'image/png', previewUrl: 'blob:x' }),
          item({ key: 'f' }),
        ]}
        onRemove={vi.fn()}
      />,
    );
    const tray = screen.getByRole('region', { name: 'Attachments' });
    expect(within(tray).getByText('2 ready')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open shot.png' }));
    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ src: 'blob:x', alt: 'shot.png' });
    expect(screen.getByText('PDF · 2.4 MB')).toBeTruthy();
    expect(screen.getByText('.pdf')).toBeTruthy();
    window.removeEventListener(IMAGE_EVENT, opened as EventListener);
  });

  it('gives a failed image room to say why, and offers retry only when it could work', () => {
    const onRetry = vi.fn();
    const onRemove = vi.fn();
    render(
      <AttachmentsTray
        items={[
          item({ key: 'big', name: 'huge.png', mimeType: 'image/png', previewUrl: 'blob:y', status: 'failed', error: 'Over the 20 MB limit' }),
          item({ key: 'net', name: 'notes.pdf', status: 'failed', error: 'Could not reach your Mac', retryable: true }),
        ]}
        onRemove={onRemove}
        onRetry={onRetry}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Open huge/ })).toBeNull();
    expect(screen.getByText('Over the 20 MB limit')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry huge.png' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry notes.pdf' }));
    expect(onRetry).toHaveBeenCalledWith('net');
    fireEvent.click(screen.getByRole('button', { name: 'Remove huge.png' }));
    expect(onRemove).toHaveBeenCalledWith('big');
  });
});

describe('upload failures', () => {
  it('read as plain reasons', () => {
    expect(uploadReason(new TypeError('Failed to fetch'), 0)).toBe('Could not reach your Mac');
    expect(uploadReason(new ApiError(413, 'file_too_large'), 413)).toBe('Over the 20 MB limit');
    expect(uploadReason(new ApiError(413, 'too_many_files'), 413)).toBe('Too many files at once');
    expect(uploadReason(new ApiError(502, 'bad_gateway'), 502)).toBe('Upload failed, try again');
  });

  it('retry really resends a file that failed on the network, once', async () => {
    let attempt = 0;
    globalThis.fetch = vi.fn(async (_input: unknown, init: { body?: FormData } = {}) => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('Failed to fetch');
      const sent = init.body?.get('files') as File;
      return { ok: true, status: 200, statusText: 'ok', text: async () => JSON.stringify({ files: [{ path: `/u/${sent.name}`, name: sent.name }] }) } as Response;
    }) as unknown as typeof fetch;
    let state: ReturnType<typeof useAttachments> | undefined;
    function Harness() {
      const a = useAttachments();
      state = a;
      return <AttachmentsTray items={a.items} onRemove={a.remove} onRetry={a.retry} />;
    }
    render(<Harness />);
    act(() => state!.add([new File(['x'], 'notes.pdf', { type: 'application/pdf' })]));
    await waitFor(() => expect(screen.getByText('Could not reach your Mac')).toBeTruthy());
    const retry = screen.getByRole('button', { name: 'Retry notes.pdf' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(state!.readyPaths()).toEqual(['/u/notes.pdf']));
    expect(attempt).toBe(2);
  });
});

describe('paste', () => {
  it('adds pasted files to the tray and leaves pasted text alone', () => {
    const onAddFiles = vi.fn();
    render(
      <Composer variant="reply" value="" onChange={vi.fn()} onSubmit={vi.fn()}
        pills={{ modelLabel: 'Model A', effortLabel: 'High', effortId: 'high' }}
        onOpenModel={vi.fn()} attachments={[]} onAddFiles={onAddFiles} onRemoveAttachment={vi.fn()} />,
    );
    const field = screen.getByRole('textbox');
    const shot = new File(['x'], 'screenshot.png', { type: 'image/png' });
    const withFile = fireEvent.paste(field, { clipboardData: { files: [shot], getData: () => '' } });
    expect(onAddFiles).toHaveBeenCalledWith([shot]);
    expect(withFile).toBe(false);
    const withText = fireEvent.paste(field, { clipboardData: { files: [], getData: () => 'hello' } });
    expect(withText).toBe(true);
    expect(onAddFiles).toHaveBeenCalledTimes(1);
  });
});

describe('a sent message', () => {
  it('shows its files as read-only tiles, outside the bubble', () => {
    const { container } = render(
      <>
        <SentAttachments files={[{ name: 'middleware.ts', mimeType: 'video/mp2t' }, { name: 'shot.png', mimeType: 'image/png' }]} />
        <UserBubble text="Here it is" />
      </>,
    );
    const list = screen.getByRole('list', { name: 'Attached files' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('TS')).toBeTruthy();
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelector('.user-bubble .att-sent')).toBeNull();
  });
});
