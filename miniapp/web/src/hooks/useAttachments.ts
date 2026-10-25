/**
 * Composer attachments.
 *
 * Files start uploading the moment the OS picker returns, so the bytes are
 * on their way while the user is still typing and Send is a plain JSON
 * call carrying paths. Each file gets its own request: one failure then
 * costs one chip rather than the whole selection.
 *
 * The `path` a chip carries is whatever the server handed back, and the
 * server only accepts paths it issued itself -- a client cannot name a file
 * on the machine and have it read out to the agent.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { ComposerAttachment } from '../types';

const MAX_FILES = 5;
const MAX_BYTES = 20 * 1024 * 1024;

/** A failed upload, in words a person can act on. */
export function uploadReason(err: unknown, status: number): string {
  if (err instanceof TypeError) return 'Could not reach your Mac';
  const reason = err instanceof ApiError ? err.reason : '';
  if (status === 413 && reason === 'too_many_files') return 'Too many files at once';
  if (status === 413 && reason === 'empty') return 'The file is empty';
  if (status === 413) return 'Over the 20 MB limit';
  if (status === 415) return 'This file type is not supported';
  if (status >= 500 || status === 408 || status === 429) return 'Upload failed, try again';
  return 'Upload failed';
}

export interface AttachmentsState {
  items: ComposerAttachment[];
  add: (files: File[], sessionId?: string) => void;
  remove: (key: string) => void;
  /** Re-upload a chip that failed for a reason another attempt could fix. */
  retry: (key: string) => void;
  clear: () => void;
  /** Chips the server has stored, in the order they were picked. */
  ready: () => ComposerAttachment[];
  readyPaths: () => string[];
}

export function useAttachments(): AttachmentsState {
  const [items, setItems] = useState<ComposerAttachment[]>([]);
  // Object URLs are a real resource; they are revoked on removal and on
  // unmount rather than left to the page's lifetime.
  const urls = useRef(new Set<string>());
  const seq = useRef(0);
  /**
   * How many chips are live.
   *
   * `add` needs the count BEFORE the state updater runs, because it decides
   * there and then which uploads to start -- so it cannot read `prev`.
   */
  const count = useRef(0);
  /** The picked files, kept only while their chips live, so retry can resend. */
  const sources = useRef(new Map<string, { file: File; sessionId?: string }>());
  /** The latest chips, so retry can check a chip's state before resending. */
  const latest = useRef<ComposerAttachment[]>([]);
  latest.current = items;

  const revoke = (url?: string) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    urls.current.delete(url);
  };

  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    },
    [],
  );

  /**
   * Take newly picked files: build their chips, then start their uploads.
   *
   * The chips and the upload list are computed HERE, in plain code, and the
   * state updater below is a pure `prev => [...prev, ...chips]`. That split
   * is the whole point of this shape, and it is load-bearing:
   *
   * The first cut collected the accepted files INSIDE the `setItems`
   * updater and looped over them immediately after the call. React does not
   * run an updater synchronously, so the loop always saw an empty list and
   * `api.upload` was never called -- every chip sat at "uploading" forever
   * and `fetch` was provably never invoked. It survived review because the
   * upload endpoint itself was only ever tested directly, over HTTP, with
   * no component in the loop. `useAttachments.test.tsx` drives a real file
   * input through React and would have caught it.
   *
   * `MAX_FILES` is therefore enforced against a ref rather than `prev`: the
   * cap has to be known before the updater runs, since it decides which
   * uploads start.
   */
  const add = useCallback((files: File[], sessionId?: string) => {
    const room = Math.max(0, MAX_FILES - count.current);
    if (room <= 0) return;

    const chips: ComposerAttachment[] = [];
    const accepted: Array<{ key: string; file: File }> = [];

    for (const file of files.slice(0, room)) {
      seq.current += 1;
      const key = `a${seq.current}`;
      let previewUrl: string | undefined;
      if (file.type.startsWith('image/')) {
        previewUrl = URL.createObjectURL(file);
        urls.current.add(previewUrl);
      }
      const tooBig = file.size > MAX_BYTES;
      chips.push({
        key,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        previewUrl,
        size: file.size,
        status: tooBig ? 'failed' : 'uploading',
        error: tooBig ? 'Over the 20 MB limit' : undefined,
      });
      if (!tooBig) {
        accepted.push({ key, file });
        sources.current.set(key, { file, sessionId });
      }
    }

    if (!chips.length) return;
    count.current += chips.length;
    setItems((prev) => [...prev, ...chips]);

    for (const { key, file } of accepted) start(key, file, sessionId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = (key: string, file: File, sessionId?: string) => {
      api.upload([file], sessionId).then(
        (res) => {
          const saved = res.files[0];
          setItems((prev) =>
            prev.map((item) =>
              item.key === key
                ? saved
                  ? { ...item, status: 'ready', path: saved.path, name: saved.name, error: undefined, retryable: undefined }
                  : { ...item, status: 'failed', error: 'Upload failed', retryable: true }
                : item,
            ),
          );
        },
        (err: Error) => {
          // A client error (too large, wrong type) fails the same way twice;
          // a dropped connection, a timeout, or a server hiccup might not.
          const status = err instanceof ApiError ? err.status : 0;
          const retryable = !(status >= 400 && status < 500 && status !== 408 && status !== 429);
          const error = uploadReason(err, status);
          setItems((prev) =>
            prev.map((item) =>
              item.key === key ? { ...item, status: 'failed', error, retryable } : item,
            ),
          );
        },
      );
  };

  const retry = useCallback((key: string) => {
    const held = sources.current.get(key);
    const chip = latest.current.find((item) => item.key === key);
    if (!held || !chip || chip.status !== 'failed' || !chip.retryable) return;
    // Mark it uploading in the ref too, so a double tap cannot send twice.
    latest.current = latest.current.map((item) => (item.key === key ? { ...item, status: 'uploading' } : item));
    setItems((prev) =>
      prev.map((item) =>
        item.key === key ? { ...item, status: 'uploading', error: undefined, retryable: undefined } : item,
      ),
    );
    start(key, held.file, held.sessionId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = useCallback((key: string) => {
    setItems((prev) => {
      const hit = prev.find((item) => item.key === key);
      if (!hit) return prev;
      revoke(hit.previewUrl);
      sources.current.delete(key);
      const next = prev.filter((item) => item.key !== key);
      count.current = next.length;
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    count.current = 0;
    sources.current.clear();
    setItems((prev) => {
      for (const item of prev) revoke(item.previewUrl);
      return [];
    });
  }, []);

  const ready = useCallback(
    () => items.filter((item) => item.status === 'ready' && item.path),
    [items],
  );

  return {
    items,
    add,
    remove,
    retry,
    clear,
    ready,
    readyPaths: () =>
      items
        .filter((item) => item.status === 'ready' && item.path)
        .map((item) => item.path as string),
  };
}
