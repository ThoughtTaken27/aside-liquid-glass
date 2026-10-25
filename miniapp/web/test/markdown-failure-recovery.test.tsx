import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Markdown } from '../src/components/MarkdownAsync';
vi.mock('../src/components/Markdown', () => { throw new Error('Synthetic chunk failure'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('a failed renderer chunk preserves readable text and the reply controls', async () => {
 vi.spyOn(console, 'error').mockImplementation(() => {});
 const view = render(<div><Markdown text="Keep this answer readable." /><button>Reply</button></div>);
 await waitFor(() => expect(view.container.querySelector('.md-format-unavailable')).not.toBeNull());
 expect(screen.getByText('Keep this answer readable.')).toBeTruthy();
 expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy();
 expect(view.container.querySelector('.md-pending')).toBeNull();
});
