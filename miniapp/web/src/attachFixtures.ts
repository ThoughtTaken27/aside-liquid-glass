/** Lab-only attachments: generic, made-up files covering every tray state. */
import type { ComposerAttachment, ThreadItem } from './types';

const svg = (body: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">${body}</svg>`)}`;

const SCREEN = svg(
  '<rect width="320" height="320" fill="#f6f7f9"/><rect x="0" y="0" width="320" height="34" fill="#fff"/><rect x="20" y="13" width="90" height="8" rx="4" fill="#d6d9de"/>' +
  '<rect x="20" y="60" width="150" height="14" rx="4" fill="#1f2328"/><rect x="20" y="92" width="200" height="12" rx="4" fill="#dfe3e8"/><rect x="20" y="114" width="170" height="12" rx="4" fill="#dfe3e8"/>' +
  '<rect x="20" y="150" width="280" height="40" rx="8" fill="#2f6fde"/><rect x="230" y="60" width="70" height="66" rx="6" fill="#fde8e6"/>',
);
const CHART = svg(
  '<rect width="320" height="320" fill="#fbfbfa"/><g stroke="#e6e6e3" stroke-width="2"><line x1="0" y1="80" x2="320" y2="80"/><line x1="0" y1="160" x2="320" y2="160"/><line x1="0" y1="240" x2="320" y2="240"/></g>' +
  '<polyline points="0,90 60,100 120,90 180,180 240,230 320,215" fill="none" stroke="#3b6fd8" stroke-width="5"/><polyline points="0,85 80,80 160,86 240,82 320,84" fill="none" stroke="#e0784f" stroke-width="4"/>',
);

export function labAttachments(mode: string): ComposerAttachment[] {
  const all: ComposerAttachment[] = [
    { key: 'l1', name: 'checkout-step.png', mimeType: 'image/png', previewUrl: SCREEN, size: 700_416, status: 'ready', path: '/x/1' },
    { key: 'l2', name: 'conversion-by-browser.png', mimeType: 'image/png', previewUrl: CHART, size: 217_088, status: 'uploading' },
    { key: 'l3', name: 'incident-review-for-the-october-release.pdf', mimeType: 'application/pdf', size: 2_516_582, status: 'ready', path: '/x/3' },
    { key: 'l4', name: 'middleware.ts', mimeType: 'video/mp2t', size: 1_229, status: 'ready', path: '/x/4' },
    { key: 'l5', name: 'session-replay.mp4', mimeType: 'video/mp4', size: 9_400_000, status: 'uploading' },
    { key: 'l6', name: 'network-export.zip', mimeType: 'application/zip', size: 31_457_280, status: 'failed', error: 'Over the 20 MB limit' },
  ];
  if (mode === 'one') return [all[2]];
  if (mode === 'images') return all.slice(0, 2);
  if (mode === 'retry') return [{ ...all[2], key: 'r1', status: 'failed', error: 'Could not reach your Mac', retryable: true }, all[0]];
  return all.slice(0, 5).concat(all[5]).slice(0, 5); // five: the real cap
}

export const LAB_SENT: ThreadItem[] = [
  { kind: 'user', id: 'att-user', text: 'Here is what the checkout shows at the payment step.', ts: 1,
    attachments: [{ name: 'checkout-step.png', mimeType: 'image/png' }, { name: 'middleware.ts', mimeType: 'text/plain' }] },
  { kind: 'answer', id: 'att-answer', text: 'Thanks. I can see the payment step and the middleware.', ts: 2 },
];
