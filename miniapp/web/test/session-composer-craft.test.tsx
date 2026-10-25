import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api } from '../src/api';
import { SessionPanel } from '../src/components/SessionPanel';
import { AttachmentsTray } from '../src/components/AttachmentsTray';
import { TodoSection } from '../src/components/TodoSection';
import type { ArtifactsResponse, ComposerAttachment, Todo } from '../src/types';
import type { ReactNode } from 'react';

vi.mock('../src/components/Sheet', () => ({ Sheet: ({ title, children, className }: { title: string; children: ReactNode; className: string }) => <section role="dialog" aria-label={title} className={className}>{children}</section> }));
vi.mock('../src/components/FileViewer', () => ({ FileViewer: ({ file }: { file: { name: string } }) => <div role="dialog" aria-label={file.name} /> }));
const empty = (sessionId = 'sample'): ArtifactsResponse => ({ sessionId, groups: [{ id: 'artifacts', files: [] }, { id: 'attachments', files: [] }] });
const files = (name = 'notes.md'): ArtifactsResponse => ({ sessionId: 'sample', groups: [{ id: 'artifacts', files: [{ path: name, name, size: 1200, mtime: Date.now(), kind: 'text' }] }, { id: 'attachments', files: [] }] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const props = { sessionId: 'sample', subagents: [], todos: [], muted: false, onToggleMute: vi.fn(), onInspectSubagent: vi.fn(), onClose: vi.fn() };
beforeEach(() => { vi.spyOn(api, 'artifacts').mockResolvedValue(empty()); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('Session panel states', () => {
  it('keeps loading distinct from empty and exposes the styling hook', async () => {
    const request = deferred<ArtifactsResponse>();
    vi.mocked(api.artifacts).mockReturnValueOnce(request.promise);
    render(<SessionPanel {...props} />);
    expect(screen.getByRole('dialog', { name: 'Session' }).classList.contains('session-panel')).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Loading files');
    expect(screen.queryByText('No files in this session yet.')).toBeNull();
    await act(async () => request.resolve(empty()));
    expect(screen.getByText('No files in this session yet.')).toBeTruthy();
  });
  it('offers a real retry after a failed read rather than reporting no files', async () => {
    vi.mocked(api.artifacts).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(files());
    render(<SessionPanel {...props} />);
    expect(await screen.findByText('Couldn’t load files.')).toBeTruthy();
    expect(screen.queryByText('No files in this session yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /notes.md/ })).toBeTruthy();
    expect(api.artifacts).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('ignores a previous session read that arrives after the new session', async () => {
    const old = deferred<ArtifactsResponse>();
    const next = deferred<ArtifactsResponse>();
    vi.mocked(api.artifacts).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const view = render(<SessionPanel {...props} />);
    view.rerender(<SessionPanel {...props} sessionId="another" />);
    await act(async () => next.resolve(files('current.md')));
    expect(screen.getByRole('button', { name: /current.md/ })).toBeTruthy();
    await act(async () => old.resolve(files('stale.md')));
    expect(screen.queryByRole('button', { name: /stale.md/ })).toBeNull();
    expect(screen.getByRole('button', { name: /current.md/ })).toBeTruthy();
  });
  it('counts nonempty groups and still opens the selected file', async () => {
    vi.mocked(api.artifacts).mockResolvedValueOnce(files());
    render(<SessionPanel {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: /notes.md/ }));
    expect(screen.getByRole('dialog', { name: 'notes.md' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Attachments' })).toBeNull();
  });
  it('keeps the entire subagent title and inspection action', async () => {
    const child = { id: 'review', title: 'Review a long title without losing the session inspection action', status: 'done', toolCallId: 'call', modelLabel: null, running: false };
    render(<SessionPanel {...props} subagents={[child]} />);
    fireEvent.click(screen.getByRole('button', { name: `${child.title}, Done` }));
    expect(props.onInspectSubagent).toHaveBeenCalledWith('review', child.title);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
  it('makes a single optimistic mute request and names the saving state', async () => {
    const request = deferred<{ ok: boolean; mutedForHours: number }>();
    vi.spyOn(api, 'mute').mockReturnValueOnce(request.promise);
    render(<SessionPanel {...props} />);
    const toggle = screen.getByRole('switch', { name: 'Notifications' });
    fireEvent.click(toggle); fireEvent.click(toggle);
    expect(props.onToggleMute).toHaveBeenCalledWith(true);
    expect(api.mute).toHaveBeenCalledTimes(1);
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(toggle.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Updating…')).toBeTruthy();
    await act(async () => request.resolve({ ok: true, mutedForHours: 24 }));
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
  });
  it('restores the previous mute state and explains a failed update', async () => {
    vi.spyOn(api, 'mute').mockRejectedValueOnce(new Error('offline'));
    render(<SessionPanel {...props} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Notifications' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Couldn’t update notifications. Try again.');
    expect(props.onToggleMute.mock.calls.map(call => call[0])).toEqual([true, false]);
  });
  it('unmutes through the existing endpoint and explains the 24-hour state', async () => {
    vi.spyOn(api, 'unmute').mockResolvedValueOnce({ ok: true });
    render(<SessionPanel {...props} muted />);
    const toggle = screen.getByRole('switch', { name: 'Notifications' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Muted for 24 hours')).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(api.unmute).toHaveBeenCalledWith('sample'));
    expect(props.onToggleMute).toHaveBeenCalledWith(false);
  });
});

const attachment = (over: Partial<ComposerAttachment>): ComposerAttachment => ({ key: 'file', name: 'notes.pdf', mimeType: 'application/pdf', size: 2048, status: 'ready', ...over });
describe('stable composer attachment rows', () => {
  it('keeps original mixed-file order and the same row when an image fails', () => {
    const image = attachment({ key: 'image', name: 'reference.png', mimeType: 'image/png', previewUrl: 'blob:sample' });
    const file = attachment({});
    const retry = vi.fn(); const remove = vi.fn();
    const view = render(<AttachmentsTray items={[file, image]} onRemove={remove} onRetry={retry} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0].textContent).toContain('notes.pdf');
    expect(rows[1].textContent).toContain('reference.png');
    view.rerender(<AttachmentsTray items={[file, { ...image, status: 'failed', error: 'Upload timed out.', retryable: true }]} onRemove={remove} onRetry={retry} />);
    expect(screen.getAllByRole('listitem')[1]).toBe(rows[1]);
    expect(screen.getAllByRole('listitem')[0]).toBe(rows[0]);
    expect(screen.queryByRole('button', { name: 'Open reference.png' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry reference.png' }));
    expect(retry).toHaveBeenCalledWith('image');
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference.png' }));
    expect(remove).toHaveBeenCalledWith('image');
  });
  it('retains the preview control and row through uploading to ready', () => {
    const image = attachment({ key: 'image', name: 'reference.png', mimeType: 'image/png', previewUrl: 'blob:sample', status: 'uploading' });
    const view = render(<AttachmentsTray items={[image]} onRemove={() => {}} />);
    const row = screen.getByRole('listitem'); const preview = screen.getByRole('button', { name: 'Open reference.png, uploading' });
    view.rerender(<AttachmentsTray items={[{ ...image, status: 'ready' }]} onRemove={() => {}} />);
    expect(screen.getByRole('listitem')).toBe(row);
    expect(screen.getByRole('button', { name: 'Open reference.png' })).toBe(preview);
    expect(screen.getByRole('status').textContent).toBe('1 ready');
  });
});

describe('compact task states', () => {
  const pending: Todo[] = [{ id: 'one', content: 'Read the references', status: 'pending' }];
  it('does not claim work is running before a task starts', () => {
    render(<TodoSection todos={pending} />);
    expect(screen.queryByRole('img', { name: 'working' })).toBeNull();
    expect(screen.getByRole('button').textContent).toContain('Read the references');
  });
  it('shows completed history settled, without replaying its check', () => {
    render(<TodoSection todos={[{ ...pending[0], status: 'completed' }]} />);
    expect(document.querySelector('.todo-toggle .af-check.is-animated')).toBeNull();
  });
  it('still animates a completion that happens while the summary is mounted', () => {
    const view = render(<TodoSection todos={pending} />);
    view.rerender(<TodoSection todos={[{ ...pending[0], status: 'completed' }]} />);
    expect(document.querySelector('.todo-toggle .af-check.is-animated')).toBeTruthy();
  });
  it('preserves user ownership of disclosure when a task label updates', () => {
    const view = render(<TodoSection todos={pending} />);
    const toggle = screen.getByRole('button');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    view.rerender(<TodoSection todos={[{ ...pending[0], status: 'completed' }, { id: 'two', content: 'Check the build', status: 'in_progress' }]} />);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(document.querySelector('.todo-list')!).getByText('Check the build')).toBeTruthy();
  });
});
