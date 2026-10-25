import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkFold } from '../src/components/WorkFold';
import type { WorkBlock } from '../src/types';
const block = (id: string): WorkBlock => ({ kind: 'work', id, durationMs: 45000, running: false, items: [{ kind: 'step', id: id + '-step', label: 'Check the component', tool: 'bash', icon: 'terminal', status: 'success', diffstat: null, detail: { command: 'Inspect the component', output: 'Verified' }, images: [] }] });
afterEach(cleanup);
function fixture(id: string) {
  const states: Array<{ expanded: boolean; surface: string }> = [];
  const view = render(<div onClick={() => {}}><WorkFold block={block(id)} sessionId="lab" live={false} subagentSteps={{}} onInspectSubagent={() => {}} sources={{}} onOpenCitation={() => {}} /></div>);
  view.container.addEventListener('aside:activity-expand', event => {
    const detail = (event as CustomEvent).detail;
    states.push({ expanded: detail.expanded, surface: detail.target.dataset.contentSurface });
  });
  return { view, states };
}
describe('disclosure clicks communicate both directions', () => {
  it('turn record opens and closes with explicit intent', () => {
    const { states } = fixture('outer-intent');
    const toggle = screen.getByRole('button', { name: 'Worked for 45s' });
    fireEvent.click(toggle); fireEvent.click(toggle);
    expect(states).toEqual([{ expanded: true, surface: 'activity-group' }, { expanded: false, surface: 'activity-group' }]);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
  it('thinking bar closes cancel its reveal as well', () => {
    const { view, states } = fixture('inner-intent');
    fireEvent.click(screen.getByRole('button', { name: 'Worked for 45s' }));
    const toggle = view.container.querySelector<HTMLButtonElement>('.fold-row')!;
    fireEvent.click(toggle); fireEvent.click(toggle);
    expect(states.filter(state => state.surface === 'activity-fold').map(state => state.expanded)).toEqual([true, false]);
  });
});
