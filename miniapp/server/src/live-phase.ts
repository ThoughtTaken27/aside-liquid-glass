/**
 * The phone's live status line, as a category word.
 *
 * Step labels carry search queries, file paths and commands; a lock screen
 * must never show those. This maps the step's icon/tool to a fixed phrase,
 * so the only thing that can reach the phone is one of the strings below.
 */
import type { ThreadItem, WorkStep } from './thread.js';

export const LIVE_PHASES = [
  'Thinking', 'Searching the web', 'Browsing the web', 'Reading pages', 'Running a command',
  'Editing files', 'Reading files', 'Checking memory', 'Using a skill', 'Working with a helper',
  'Planning', 'Waiting', 'Writing the reply',
] as const;
export type LivePhase = (typeof LIVE_PHASES)[number];

export function phaseForStep(step: Pick<WorkStep, 'icon' | 'tool'>): LivePhase {
  const tool = step.tool.toLowerCase();
  if (/websearch|web_search|google/.test(tool)) return 'Searching the web';
  if (/webfetch|fetch/.test(tool)) return 'Reading pages';
  if (/repl|browser|opentab|playwright|snapshot/.test(tool)) return 'Browsing the web';
  if (/memory/.test(tool)) return 'Checking memory';
  if (/skill/.test(tool)) return 'Using a skill';
  if (/subagent|agent/.test(tool) || step.icon === 'agent') return 'Working with a helper';
  if (/todo|plan/.test(tool) || step.icon === 'list') return 'Planning';
  if (/write|edit/.test(tool)) return 'Editing files';
  if (/read|grep|glob|list|search_files/.test(tool)) return 'Reading files';
  if (/sleep|wait/.test(tool) || step.icon === 'clock') return 'Waiting';
  if (/bash|shell|exec|command/.test(tool) || step.icon === 'terminal') return 'Running a command';
  if (step.icon === 'globe') return 'Browsing the web';
  if (step.icon === 'search') return 'Searching the web';
  if (step.icon === 'file') return 'Editing files';
  return 'Thinking';
}

/** The phase of a live turn: its newest step, or the reply once text follows the last step. */
export function livePhase(items: ThreadItem[]): LivePhase {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'answer') return 'Writing the reply';
    if (item.kind !== 'work') continue;
    const steps = item.items;
    const last = steps[steps.length - 1];
    if (!last) return 'Thinking';
    if (last.kind === 'step') return phaseForStep(last);
    return 'Thinking';
  }
  return 'Thinking';
}
