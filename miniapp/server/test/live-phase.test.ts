import { describe, expect, it } from 'vitest';
import { LIVE_PHASES, livePhase, phaseForStep } from '../src/live-phase.js';
const step = (tool: string, icon = 'dot', label = 'Searched for "my private query" in /Users/owner/secret.txt') =>
  ({ kind: 'step', id: tool, icon, tool, label, status: 'pending', diffstat: null, detail: null, images: [] }) as never;
const work = (...items: unknown[]) => ({ kind: 'work', id: 'w', items, durationMs: 0, running: true }) as never;
describe('live phase', () => {
  it('maps tools to fixed category words', () => {
    expect(phaseForStep({ tool: 'websearch', icon: 'search' })).toBe('Searching the web');
    expect(phaseForStep({ tool: 'repl', icon: 'globe' })).toBe('Browsing the web');
    expect(phaseForStep({ tool: 'webfetch', icon: 'globe' })).toBe('Reading pages');
    expect(phaseForStep({ tool: 'Bash', icon: 'terminal' })).toBe('Running a command');
    expect(phaseForStep({ tool: 'edit_file', icon: 'file' })).toBe('Editing files');
    expect(phaseForStep({ tool: 'write_todos', icon: 'list' })).toBe('Planning');
    expect(phaseForStep({ tool: 'memory_search', icon: 'search' })).toBe('Checking memory');
    expect(phaseForStep({ tool: 'subagent', icon: 'agent' })).toBe('Working with a helper');
  });
  it('never leaks a step label, query or path', () => {
    const items = [work(step('websearch', 'search'))];
    const phase = livePhase(items);
    expect(LIVE_PHASES).toContain(phase);
    expect(phase).not.toMatch(/private|secret|Users/);
  });
  it('follows the newest step, then the reply', () => {
    expect(livePhase([])).toBe('Thinking');
    expect(livePhase([work(step('websearch'), step('Bash', 'terminal'))])).toBe('Running a command');
    expect(livePhase([work(step('Bash', 'terminal')), { kind: 'answer' } as never])).toBe('Writing the reply');
    expect(livePhase([work(step('Bash', 'terminal'), { kind: 'text', id: 't', text: 'hm' })])).toBe('Thinking');
  });
});
