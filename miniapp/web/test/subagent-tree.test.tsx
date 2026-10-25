import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SubagentTree } from '../src/components/SubagentTree';
import type { ChildSteps, SubagentSpawn, WorkStep } from '../src/types';
afterEach(() => { cleanup(); vi.useRealTimers(); });
let scope = 0;
beforeEach(() => { scope += 1; });
const step = (id: string, status: WorkStep['status'] = 'success'): WorkStep => ({kind:'step', id, icon:'search', label:`Search ${id}`, tool:'websearch', status, diffstat:null, detail:null, images:[]});
const spawn = (running = true, status = running ? 'running' : 'idle'): SubagentSpawn => ({ callId:`call-${scope}`, description:'Research materials', prompt:'Compare the public documentation.', hue:0, child:{id:'child-1',title:'Material research',status,toolCallId:'call-1',modelLabel:'Example model',running} });
const data = (steps: WorkStep[] = [step('1'),step('2','pending')]): Record<string,ChildSteps> => ({'child-1':{childId:'child-1',steps,total:steps.length}});
const renderTree = (spawns = [spawn()], tails = data(), inspect = vi.fn()) => render(<SubagentTree spawns={spawns} subagentSteps={tails} onInspect={inspect} />);
describe('subagent run tree', () => {
  it('is absent without spawns', () => { const {container}=renderTree([]); expect(container.childElementCount).toBe(0); });
  it('expands locally and keeps full-thread navigation separate', () => {
    const inspect=vi.fn(); renderTree([spawn()],data(),inspect);
    const row=screen.getByRole('button',{name:/Research materials.*Expand/});
    expect(row.getAttribute('aria-expanded')).toBe('false'); fireEvent.click(row);
    expect(inspect).not.toHaveBeenCalled();
    expect(screen.getByRole('button',{name:'Open full thread'}).getAttribute('aria-description')).toContain('Example model');
    expect(screen.getByText('Compare the public documentation.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Open full thread'}));
    expect(inspect).toHaveBeenCalledWith('child-1','Material research');
    fireEvent.click(row); expect(row.getAttribute('aria-expanded')).toBe('false');
  });
  it('retains the same row and open panel through live updates and completion', () => {
    const view=renderTree(); const row=screen.getByRole('button',{name:/Expand details/}); fireEvent.click(row);
    const id=row.getAttribute('aria-controls');
    view.rerender(<SubagentTree spawns={[spawn()]} subagentSteps={data([step('1'),step('2'),step('3','pending')])} onInspect={vi.fn()} />);
    expect(screen.getByRole('button',{name:/Collapse details/})).toBe(row);
    view.rerender(<SubagentTree spawns={[spawn(false)]} subagentSteps={data([step('1'),step('2'),step('3')])} onInspect={vi.fn()} />);
    expect(screen.getByRole('button',{name:/Research materials.*Done.*Collapse/})).toBe(row);
    expect(row.getAttribute('aria-controls')).toBe(id); expect(document.getElementById(id!)?.hidden).toBe(false);
    expect(document.querySelector('.agent-tree-current')?.textContent).toContain('Search 3');
  });
  it('restores a reader-opened branch after virtualized remount', () => {
    const first=renderTree(); fireEvent.click(screen.getByRole('button',{name:/Expand details/})); first.unmount();
    renderTree(); expect(screen.getByRole('button',{name:/Collapse details/}).getAttribute('aria-expanded')).toBe('true');
  });
  it('keeps identity and expansion when the child session first arrives', () => {
    const waiting={...spawn(),child:undefined}; const view=renderTree([waiting],{});
    const row=screen.getByRole('button',{name:/Starting.*Expand/}); fireEvent.click(row);
    expect(screen.queryByRole('button',{name:'Open full thread'})).toBeNull();
    view.rerender(<SubagentTree spawns={[spawn()]} subagentSteps={data()} onInspect={vi.fn()} />);
    expect(screen.getByRole('button',{name:/Running.*Collapse/})).toBe(row);
    expect(screen.getByRole('button',{name:'Open full thread'})).toBeTruthy();
  });
  it.each(['errored','interrupted','paused','pendingApproval'])('never reports %s as done or spins a stale pending tool', status => {
    renderTree([spawn(false,status)]); fireEvent.click(screen.getByRole('button',{name:/Expand/}));
    expect(screen.queryByText('Finished 2 steps')).toBeNull();
    expect(document.querySelector('.agent-tree-step .agent-tree-spinner')).toBeNull();
    expect(screen.getByText('Needs attention')).toBeTruthy();
  });
  it('reports truncated tails honestly and limits the expanded preview', () => {
    const d=data(Array.from({length:12},(_,i)=>step(String(i))));d['child-1'].total=20;
    renderTree([spawn()],d);fireEvent.click(screen.getByRole('button',{name:/Expand/}));
    expect(screen.getByText('16 earlier steps')).toBeTruthy();
    expect(document.querySelectorAll('.agent-tree-step')).toHaveLength(4);
  });
  it('uses semantic lists, unique panels and does not confuse sibling controls', () => {
    renderTree([spawn(),{...spawn(),callId:'call-2',description:'Check results'}]);
    const buttons=screen.getAllByRole('button',{name:/Expand details/});
    expect(new Set(buttons.map(b=>b.getAttribute('aria-controls'))).size).toBe(2);
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(2);
    fireEvent.click(buttons[1]);expect(buttons[0].getAttribute('aria-expanded')).toBe('false');
  });
  it('paces rapid labels and flushes the final status immediately', () => {
    vi.useFakeTimers();const view=renderTree();
    const rerender=(running:boolean,id:string)=>view.rerender(<SubagentTree spawns={[spawn(running)]} subagentSteps={data([step(id)])} onInspect={vi.fn()} />);
    rerender(true,'3');rerender(true,'4');rerender(true,'5');
    expect(document.querySelector('.agent-tree-current')?.textContent).not.toContain('Search 5');
    rerender(false,'5');expect(document.querySelector('.agent-tree-current')?.textContent).toContain('Search 5');
  });
  it('renders nested agents when supplied and stops cyclic spawn references', () => {
    const first=spawn();const nested={...spawn(),callId:'nested',description:'Verify material',child:{...spawn().child!,id:'child-2'}};
    const d=data([{...step('delegate'),subagent:nested}]);d['child-2']={childId:'child-2',steps:[{...step('cycle'),subagent:first}],total:1};
    renderTree([first],d);
    expect(screen.getAllByRole('button',{name:/Expand details/})).toHaveLength(2);
  });
  it('shows real elapsed time and aggregates each nested agent usage', () => {
    const root=spawn(false);root.child={...root.child!,createdAt:1000,updatedAt:9000};
    const nested={...spawn(false),callId:'nested-stat',description:'Verify result',child:{...spawn(false).child!,id:'child-2',createdAt:2000,updatedAt:5000}};
    const tails=data([step('work')]);tails['child-1']={...tails['child-1'],tokens:2000,spawns:[nested]};
    tails['child-2']={childId:'child-2',total:1,steps:[step('verify')],tokens:500,summary:'Verified the source.'};
    renderTree([root],tails);expect(screen.getByText('Ran 2 agents')).toBeTruthy();
    expect(screen.getByText('8s · 2.5K tokens')).toBeTruthy();
    expect(document.querySelectorAll('.agent-tree-row')).toHaveLength(2);
  });
  it('retains a nested branch when its spawn leaves the sliding tool tail', () => {
    const nested={...spawn(),callId:'retained-nested',description:'Verify result',child:{...spawn().child!,id:'child-2'}};
    const tails=data([step('new-tool')]);tails['child-1'].spawns=[nested];
    renderTree([spawn()],tails);
    expect(screen.getByRole('button',{name:/Verify result.*Expand/})).toBeTruthy();
  });
});
