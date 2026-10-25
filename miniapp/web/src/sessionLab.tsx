import './fit';
import './keyboard';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './theme/tokens.css';
import './theme/base.css';
import './theme/components.css';
import './theme/next.css';
import './theme/next3.css';
import './theme/next-polish.css';
import './theme/polish.css';
import './theme/polish-next.css';
import './theme/refine.css';
import './theme/fits.css';
import './theme/craft.css';
import './theme/next-top.css';
import './theme/keyboard.css';
import './theme/queue.css';
import './theme/turn.css';
import './theme/materials.css';
import './theme/scroll-depth.css';
import './theme/affect.css';

import './App';
import './theme/system.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Composer } from './components/Composer';
import { useDockHeight } from './hooks/useDockHeight';
import { useEndFollow } from './hooks/useEndFollow';
import { WorkFold } from './components/WorkFold';
import { QueuedMessages } from './components/QueuedMessages';
import { TodoSection } from './components/TodoSection';
import { SessionPanel } from './components/SessionPanel';
import { ImageLightbox } from './components/ImageLightbox';
import { installSlashLab } from './slashFixtures';
import { api } from './api';
import { ChevronLeft, MoreVertical } from './components/Icons';
import type { ArtifactsResponse, ComposerAttachment, Todo, WorkBlock } from './types';
const params = new URLSearchParams(location.search);
const mode = params.get('state') || 'ready';
const dark = params.get('theme') !== 'light';
document.documentElement.dataset.client = 'standalone';
document.documentElement.dataset.fit = dark ? 'midnight' : 'paper';
document.documentElement.classList.toggle('dark', dark);
if (params.has('kb')) { document.documentElement.dataset.vk = 'on'; document.documentElement.dataset.kb = 'open'; document.documentElement.style.setProperty('--kb', '360px'); }
installSlashLab();
let attempts = 0;
api.artifacts = async () => {
  if (mode === 'loading') return new Promise<ArtifactsResponse>(() => {});
  if (mode === 'error' && ++attempts === 1) throw new Error('Unavailable');
  return { sessionId: 'lab', groups: mode === 'files' ? [{ id: 'artifacts', files: [{ path: 'interface-notes.md', name: 'interface-notes.md', size: 2800, mtime: Date.now() - 90000, kind: 'text' }] }, { id: 'attachments', files: [{ path: 'reference.png', name: 'reference.png', size: 92000, mtime: Date.now() - 200000, kind: 'image' }] }] : [] };
};
api.mute = async () => ({ ok: true, mutedForHours: 24 });
api.unmute = async () => ({ ok: true });
const tasks: Todo[] = [
  { id: 'one', content: 'Inspect the existing panels and shared controls', status: 'completed' },
  { id: 'two', content: 'Refine the Session panel and composer context without changing their actions', status: 'in_progress' },
  { id: 'three', content: 'Check empty, loading, failed, and narrow-screen states', status: 'pending' },
  { id: 'four', content: 'Verify light and dark production styles and reversible motion', status: 'pending' },
  { id: 'five', content: 'Run the focused regressions and full web tests', status: 'pending' },
];
const picture = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="160"><rect width="200" height="160" fill="#ada9a3"/><rect x="20" y="18" width="160" height="124" rx="12" fill="#f6f5f3"/><rect x="32" y="34" width="104" height="9" rx="4" fill="#484643"/><rect x="32" y="58" width="136" height="48" rx="7" fill="#dfddd8"/><rect x="32" y="120" width="74" height="5" rx="2" fill="#99958d"/></svg>');
const image: ComposerAttachment = { key: 'image', name: 'panel-reference.png', size: 184000, mimeType: 'image/png', previewUrl: params.has('blob') ? URL.createObjectURL(new Blob([decodeURIComponent(picture.split(',')[1])], { type: 'image/svg+xml' })) : picture, status: 'ready' };
const file: ComposerAttachment = { key: 'file', name: 'shared-interface-notes-with-a-long-filename.pdf', size: 1240000, mimeType: 'application/pdf', status: 'ready' };
const work: WorkBlock = { kind: 'work', id: 'lab-work', running: false, durationMs: 45000, items: Array.from({ length: 25 }, (_, i) => ({ kind: 'step', id: 'step-' + i, label: 'Checking interface behavior ' + (i + 1), tool: 'bash', icon: 'terminal', status: 'success', diffstat: null, detail: { command: 'Inspect component state ' + (i + 1), output: 'Checked the rendered layout and controls.' }, images: [] })) };
function Lab() {
  const host = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLElement>(null);
  const pinned = useRef(false), landing = useRef(false), touching = useRef(false);
  const update = useCallback(() => {}, []);
  const follow = useEndFollow(scroll, { pinned, landing, touching }, update);
  useDockHeight(host, dock);
  const [panel, setPanel] = useState(params.has('panel'));
  const [draft, setDraft] = useState(params.has('longDraft') ? Array(12).fill('Keep the field and controls reachable.').join('\n') : '');
  const [muted, setMuted] = useState(false);
  const [files, setFiles] = useState<ComposerAttachment[]>(mode === 'empty' ? [] : mode === 'pair' ? [image, file] : mode === 'mixed' ? [image, file, { ...image, key: 'failed', name: 'large-reference.png', status: 'failed', error: 'The upload timed out. Try again.', retryable: true }, { ...file, key: 'upload', name: 'uploading-report.pdf', status: 'uploading' }] : [image]);
  useEffect(() => {
    const update = () => setFiles(previous => previous.map(item => item.key === 'image' ? { ...item, status: item.status === 'ready' ? 'uploading' : 'ready' } : item));
    window.addEventListener('aside:lab-upload', update);
    return () => window.removeEventListener('aside:lab-upload', update);
  }, []);
  return <div className="app app-thread" ref={host}>
    <header className="thread-header" data-condensed="false"><div className="thread-header-left"><button type="button" className="icon-button" aria-label="Back"><ChevronLeft size={20} /></button></div><span className="thread-titles"><span className="thread-title">Component review</span><span className="thread-subtitle">Review in progress</span></span><div className="thread-header-right"><button type="button" className="icon-button" aria-label="Session" onClick={() => setPanel(true)}><MoreVertical size={19} /></button></div></header>
    <main className="thread-scroll" ref={scroll} onWheel={() => follow.cancel()} onTouchStart={() => { touching.current = true; follow.cancel(); }} onTouchEnd={() => { touching.current = false; }} style={{ paddingTop: 24, paddingInline: 20, fontSize: 14, lineHeight: 1.6 }}><p>I'll keep the same controls and refine how the parts fit together.</p><p>The session brings progress and files into view; the composer keeps the next message ready.</p>{params.has('thinking') ? <><WorkFold block={work} sessionId="lab" live={false} subagentSteps={{}} onInspectSubagent={() => {}} sources={{}} onOpenCitation={() => {}} /><p>Later messages stay below the expanded work.</p></> : null}<div className="thread-dock-spacer" aria-hidden="true" /></main>
    <footer className="thread-footer" ref={dock} data-at-end="true">{params.has('queued') ? <QueuedMessages items={[{ id: 'queued', text: 'Check the draft, thinking bar, and keyboard together.', attachments: ['reference.png', 'notes.pdf'], at: 1 }]} onSendNow={() => {}} onEdit={() => {}} onRemove={() => {}} /> : null}<Composer variant="reply" value={draft} onChange={setDraft} onSubmit={() => {}} pills={{ modelLabel: 'Claude Opus', effortLabel: 'High', effortId: 'high', provider: 'claude-code' }} onOpenModel={() => {}} attachments={files} onAddFiles={() => {}} onRemoveAttachment={key => { const removed = files.find(item => item.key === key); if (removed?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(removed.previewUrl); setFiles(old => old.filter(item => item.key !== key)); }} onRetryAttachment={key => setFiles(old => old.map(item => item.key === key ? { ...item, status: 'uploading' } : item))} streaming onStop={() => {}} above={mode === 'empty' ? undefined : <TodoSection todos={tasks} />} /></footer>
    {panel ? <SessionPanel sessionId="lab" subagents={mode === 'empty' ? [] : [{ id: 'review', title: 'Review the overlay motion and interaction details', status: 'done', toolCallId: 'review', modelLabel: null, running: false }]} todos={mode === 'empty' ? [] : tasks} muted={muted} onToggleMute={setMuted} onInspectSubagent={() => {}} onClose={() => setPanel(false)} /> : null}
    <ImageLightbox />
    {params.has('kb') ? createPortal(<div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: 360, background: '#e9e9ed', color: '#555', display: 'grid', placeItems: 'center', fontSize: 13, zIndex: 20 }}>Keyboard area (360px)</div>, document.body) : null}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Lab />);
