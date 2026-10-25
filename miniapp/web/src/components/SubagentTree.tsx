import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useSteadyText } from '../hooks/useSteadyText';
import { haptic } from '../telegram';
import type { ChildSteps, SubagentSpawn, WorkStep } from '../types';

const disclosurePins = new Map<string, boolean>();
function rememberDisclosure(id: string, open: boolean) {
  disclosurePins.delete(id); disclosurePins.set(id, open);
  if (disclosurePins.size > 256) disclosurePins.delete(disclosurePins.keys().next().value!);
}
function statusOf(s: SubagentSpawn) { return !s.child ? 'starting' : s.child.running ? 'running' : s.child.status || 'unknown'; }
function statusLabel(s: string) {
  return ({ starting: 'Starting', running: 'Running', idle: 'Done', errored: 'Failed', interrupted: 'Interrupted', pendingApproval: 'Needs approval', paused: 'Paused', stopped: 'Stopped', unknown: 'Status unavailable' } as Record<string, string>)[s] || s.charAt(0).toUpperCase() + s.slice(1);
}
function nestedOf(spawn: SubagentSpawn, data: Record<string, ChildSteps>) {
  const tail = spawn.child ? data[spawn.child.id] : undefined;
  return tail?.spawns ?? tail?.steps.flatMap(s => s.subagent ? [s.subagent] : []) ?? [];
}
function allAgents(spawns: SubagentSpawn[], data: Record<string, ChildSteps>) {
  const seen = new Set<string>(), result: SubagentSpawn[] = [];
  const visit = (list: SubagentSpawn[], depth: number) => { for (const spawn of list) {
    if (seen.has(spawn.callId) || result.length >= 64) continue;
    seen.add(spawn.callId); result.push(spawn);
    if (depth < 7) visit(nestedOf(spawn, data), depth + 1);
  } }; visit(spawns, 0); return result;
}
function compact(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K` : String(n); }
function elapsed(start: number | undefined, end: number) {
  if (!start || !Number.isFinite(start)) return '–';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Measured public run-tree geometry and motion, not a mobile reinterpretation. */
export function SubagentTree({ spawns, subagentSteps, onInspect }: {
  spawns: SubagentSpawn[]; subagentSteps: Record<string, ChildSteps>;
  onInspect: (id: string, title: string) => void; fresh?: boolean;
}) {
  const agents = allAgents(spawns, subagentSteps);
  const live = agents.some(s => ['starting', 'running'].includes(statusOf(s)));
  const issues = agents.some(s => !['starting', 'running', 'idle'].includes(statusOf(s)));
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!live) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [live]);
  if (!agents.length) return null;
  const starts = agents.flatMap(s => s.child?.createdAt ? [s.child.createdAt] : []);
  const end = live ? now : Math.max(0, ...agents.map(s => s.child?.updatedAt || 0));
  const count = agents.length;
  const tokens = agents.reduce((n, s) => n + (s.child ? subagentSteps[s.child.id]?.tokens || 0 : 0), 0);
  const hasTokens = agents.some(s => s.child && subagentSteps[s.child.id]?.tokens !== undefined);
  return <section className="agent-tree" aria-label="Subagents">
    <div className="agent-tree-heading">
      <span className="agent-tree-header-icon"><StatusMark status={live ? 'running' : issues ? 'stopped' : 'idle'} /></span>
      <output className="agent-tree-heading-label"><TreeText text={`${live ? 'Running' : 'Ran'} ${count} agent${count === 1 ? '' : 's'}`} /></output>
      <span className="agent-tree-tally">{starts.length ? elapsed(Math.min(...starts), end) : '–'} · {hasTokens ? compact(tokens) : '–'} tokens</span>
      {issues ? <span className="sr-only">Needs attention</span> : null}
    </div>
    <Branches spawns={spawns} data={subagentSteps} onInspect={onInspect} ancestors={[]} now={now} />
  </section>;
}
function Branches({ spawns, data, onInspect, ancestors, now }: {
  spawns: SubagentSpawn[]; data: Record<string, ChildSteps>; onInspect: (id: string, title: string) => void; ancestors: string[]; now: number;
}) {
  return <ul className="agent-tree-branches">{spawns.filter(s => !ancestors.includes(s.callId)).map(spawn => <Branch key={spawn.callId} spawn={spawn} data={data} onInspect={onInspect} ancestors={ancestors} now={now} />)}</ul>;
}
function Branch({ spawn, data, onInspect, ancestors, now }: {
  spawn: SubagentSpawn; data: Record<string, ChildSteps>; onInspect: (id: string, title: string) => void; ancestors: string[]; now: number;
}) {
  const [open, setOpen] = useState(() => disclosurePins.get(spawn.callId) ?? false), panelId = useId();
  const child = spawn.child, status = statusOf(spawn), running = status === 'running' || status === 'starting';
  const title = spawn.description || child?.title || 'Subagent';
  const tail = child ? data[child.id] : undefined, rows = tail?.steps ?? [], total = tail?.total ?? rows.length;
  const label = running ? rows.at(-1)?.label || statusLabel(status) : status === 'idle' ? tail?.summary || rows.at(-1)?.label || 'Finished' : statusLabel(status);
  const paced = useSteadyText(label, running);
  const visible = rows.filter(s => !s.subagent).slice(-4), earlier = Math.max(0, total - visible.length - rows.filter(s => s.subagent).length);
  const nested = nestedOf(spawn, data);
  const openThread = child ? () => { haptic('light'); onInspect(child.id, child.title || title); } : undefined;
  const modelDescription = child?.modelLabel ? `Model: ${child.modelLabel}${child.effort ? `, ${child.effort}` : ''}` : undefined;
  return <li className="agent-tree-branch" data-spawn={spawn.callId} data-status={status}>
    <span className="agent-tree-elbow" aria-hidden="true" /><span className="agent-tree-rail" aria-hidden="true" />
    <button type="button" className="agent-tree-row" aria-expanded={open} aria-controls={panelId}
      aria-label={`${title}. ${statusLabel(status)}. ${total} step${total === 1 ? '' : 's'}. ${open ? 'Collapse' : 'Expand'} details.`}
      onClick={() => { haptic('light'); setOpen(v => { rememberDisclosure(spawn.callId, !v); return !v; }); }}>
      <StatusMark status={status} />
      <span className="agent-tree-name" title={title}>{title}</span>
      <TreeText className="agent-tree-current" text={paced} />
      <span className="agent-tree-elapsed">{elapsed(child?.createdAt, running ? now : child?.updatedAt || 0)}</span>
      <span className="agent-tree-tokens" title={`${tail?.tokens ?? 'Unknown'} tokens`}>{tail?.tokens !== undefined ? compact(tail.tokens) : '–'}</span>
      <span className={`agent-tree-chevron${open ? ' is-open' : ''}`} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg></span>
    </button>
    <TreeDisclosure id={panelId} open={open}><div className="agent-tree-detail-inner">
      {nested.length ? <span className="agent-tree-detail-rail" aria-hidden="true" /> : null}
      {spawn.prompt ? openThread && (running || !tail?.summary)
        ? <button type="button" className="agent-tree-brief agent-tree-open-inline" aria-label="Open full thread" aria-description={modelDescription} title={child?.modelLabel || undefined} onClick={openThread}>{spawn.prompt}</button>
        : <p className="agent-tree-brief">{spawn.prompt}</p> : null}
      {earlier > 0 ? <p className="agent-tree-earlier">{earlier} earlier step{earlier === 1 ? '' : 's'}</p> : null}
      <ul className="agent-tree-steps" aria-label={`${title} steps`}>{visible.map((step, i) => <Step key={step.id} step={step} running={running} onOpen={i === 0 && !spawn.prompt && (running || !tail?.summary) ? openThread : undefined} modelDescription={modelDescription} />)}</ul>
      {!rows.length ? openThread && !spawn.prompt && (running || !tail?.summary)
        ? <button type="button" className="agent-tree-earlier agent-tree-open-inline" aria-label="Open full thread" aria-description={modelDescription} onClick={openThread}>{running ? 'Waiting for the first step…' : 'No steps reported.'}</button>
        : <p className="agent-tree-earlier">{running ? 'Waiting for the first step…' : 'No steps reported.'}</p> : null}
      {!running && tail?.summary ? <button type="button" className="agent-tree-result agent-tree-open-inline" aria-label="Open full thread" aria-description={modelDescription} title={child?.modelLabel || undefined} onClick={openThread}>{tail.summary}</button> : null}
    </div></TreeDisclosure>
    {nested.length && ancestors.length < 7 ? <Branches spawns={nested} data={data} onInspect={onInspect} ancestors={[...ancestors, spawn.callId]} now={now} /> : null}
  </li>;
}
/** Only a reader's toggle animates layout, as the reference does; pushes do not.
 * Retarget from the presented height/opacity so a rapid reversal never snaps.
 */
function TreeDisclosure({id, open, children}: {id: string; open: boolean; children: ReactNode}) {
  const node = useRef<HTMLDivElement>(null), mounted = useRef(false), previousOpen = useRef(open);
  const motion = useRef<{height: Animation; opacity: Animation} | null>(null);
  useLayoutEffect(() => {
    const el = node.current; if (!el) return;
    if (!mounted.current) { mounted.current = true; el.hidden = !open; return; }
    if (previousOpen.current === open) return;
    previousOpen.current = open;
    const hidden = el.hidden, from = hidden ? 0 : el.getBoundingClientRect().height;
    const opacity = hidden ? 0 : Number.parseFloat(getComputedStyle(el).opacity) || 0;
    motion.current?.height.cancel(); motion.current?.opacity.cancel(); motion.current = null;
    if (!el.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.hidden = !open; return; }
    el.hidden = false;
    const target = open ? el.firstElementChild!.getBoundingClientRect().height : 0;
    const height = el.animate([{height: from + 'px'}, {height: target + 'px'}], {duration: 220, easing: 'cubic-bezier(0.22,1,0.36,1)', fill: 'both'});
    const fade = el.animate([{opacity}, {opacity: open ? 1 : 0}], {duration: 220, easing: 'cubic-bezier(0.4,0,0.2,1)', fill: 'both'});
    const current = {height, opacity: fade}; motion.current = current;
    void Promise.all([height.finished, fade.finished]).then(() => {
      if (motion.current !== current) return;
      el.hidden = !open; motion.current = null; height.cancel(); fade.cancel();
    }, () => {});
  }, [open]);
  useEffect(() => () => { const current=motion.current; motion.current=null; current?.height.cancel(); current?.opacity.cancel(); }, []);
  return <div ref={node} id={id} className="agent-tree-detail" aria-hidden={!open} inert={!open}>{children}</div>;
}

function Step({ step, running, onOpen, modelDescription }: { step: WorkStep; running: boolean; onOpen?: () => void; modelDescription?: string }) {
  const status = step.status === 'pending' ? running ? 'running' : 'stopped' : step.status === 'error' ? 'errored' : 'idle';
  return <li className="agent-tree-step"><StatusMark status={status} /><span title={step.label}>{onOpen ? <button type="button" className="agent-tree-open-inline" aria-label="Open full thread" aria-description={modelDescription} onClick={onOpen}>{step.label}</button> : step.label}</span></li>;
}
function StatusMark({ status }: { status: string }) {
  const live = status === 'running' || status === 'starting';
  return <span className={`agent-tree-status${live ? ' is-running' : status === 'idle' ? ' is-done' : ' is-stopped'}`}>
    {live ? <svg className="agent-tree-spinner" aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" fill="none" pathLength="1" r="9" stroke="currentColor" strokeDasharray="0.022 0.06133333333333333" strokeLinecap="round" strokeWidth="2.2" /></svg>
      : status === 'idle' ? <svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M5 14L8.5 17.5L19 6.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" /></svg>
        : <svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" /><path d="M12 7v6m0 3h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="2" /></svg>}
    <span className="sr-only">{statusLabel(status)}</span>
  </span>;
}
/** The reference's overlapping 280ms/250ms blur crossfade, in a fixed cell. */
function TreeText({ text, className = '' }: { text: string; className?: string }) {
  const last = useRef(text), first = useRef(true), [previous, setPrevious] = useState<{text: string; key: number} | null>(null), serial = useRef(0);
  useLayoutEffect(() => { if (last.current === text) return; setPrevious({text: last.current, key: ++serial.current}); last.current = text; first.current = false; }, [text]);
  useEffect(() => { if (!previous) return; const id = window.setTimeout(() => setPrevious(null), 300); return () => window.clearTimeout(id); }, [previous]);
  return <span className={`agent-tree-swap ${className}`}>
    {previous ? <span key={`out-${previous.key}`} className="agent-tree-swap-out" aria-hidden="true">{previous.text}</span> : null}
    <span key={`in-${serial.current}`} className={first.current ? '' : 'agent-tree-swap-in'}>{text}</span>
  </span>;
}
