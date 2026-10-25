import { Collapse } from './Collapse';
/**
 * The agent's task list.
 *
 * Two placements, both mirroring the desktop app:
 *
 *  - `TodoSection`, a compact strip sitting directly ON TOP of the
 *    composer. Collapsed by default: one row naming the current item with
 *    a count and a chevron. Expanded, the full checklist.
 *  - `TodoProgress`, the "Task progress" block at the bottom of the
 *    right-hand session panel.
 *
 * The open state here is purely manual and has no interaction with the work
 * fold's auto-expand rule. That is deliberate -- the fold follows the turn
 * (see `WorkFold.tsx`) and a second thing that opens and closes itself
 * around the composer would fight the reader for the same screen space.
 */
import { useEffect, useRef, useState } from 'react';
import { DoneCheck, NumberTicker, RaySpinner, RollText } from './Affect';
import { ChevronUp, TodoCircle } from './Icons';
import { haptic } from '../telegram';
import type { Todo } from '../types';

/** The row shown when the section is collapsed. */
export function todoSummary(todos: Todo[]): {
  label: string;
  done: number;
  total: number;
} | null {
  const live = todos.filter((todo) => todo.status !== 'cancelled');
  if (!live.length) return null;
  const done = live.filter((todo) => todo.status === 'completed').length;
  const current =
    live.find((todo) => todo.status === 'in_progress') ||
    live.find((todo) => todo.status === 'pending');
  return {
    label: current ? current.content : 'All tasks complete',
    done,
    total: live.length,
  };
}

/*
 * A task's mark moves through Agent Plan's three states: a hairline ring
 * while it waits, eight rays while it runs, a filled check that pops and
 * draws itself once done. The strike drawing across a finished label and
 * the check's pop play only when the change happens on screen; a list
 * opened later shows them settled.
 */
function TodoMark({ status, fresh }: { status: Todo['status']; fresh: boolean }) {
  if (status === 'completed') return <span className="todo-mark"><DoneCheck size={15} animate={fresh} /></span>;
  if (status === 'in_progress') return <span className="todo-mark is-live"><RaySpinner size={15} /></span>;
  return <TodoCircle status={status} />;
}

function TodoRow({ todo, index = 0 }: { todo: Todo; index?: number }) {
  const was = useRef(todo.status);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (was.current !== todo.status) setFresh(true);
    was.current = todo.status;
  }, [todo.status]);
  return (
    <li
      className={`todo-row is-${todo.status}${fresh ? ' is-fresh' : ''}`}
      style={{ ['--i' as string]: index }}
    >
      <TodoMark status={todo.status} fresh={fresh} />
      <span className="todo-content"><span className="todo-text">{todo.content}</span></span>
    </li>
  );
}

export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="todo-list">
      {todos.map((todo, index) => (
        <TodoRow key={todo.id} todo={todo} index={index} />
      ))}
    </ul>
  );
}

export function TodoSection({ todos, paused = false }: { todos: Todo[]; paused?: boolean }) {
  const [open, setOpen] = useState(false);
  const summary = todoSummary(todos);
  const complete = Boolean(summary && summary.done === summary.total);
  const wasComplete = useRef(complete);
  const [freshCompletion, setFreshCompletion] = useState(false);
  useEffect(() => {
    if (wasComplete.current !== complete) setFreshCompletion(complete);
    wasComplete.current = complete;
  }, [complete]);
  // An empty list is no section at all, rather than an empty box: a
  // session that never used the tool should look no different.
  if (!summary) return null;

  return (
    <div
      className={`todo-section utility-card ${open ? 'is-open' : ''}`}
      data-card-group="utility"
      data-card-kind="tasks"
      data-card-state={open ? 'expanded' : 'collapsed'}
    >
      <button
        type="button"
        className="todo-toggle"
        aria-expanded={open}
        onClick={() => {
          haptic('light');
          setOpen((prev) => !prev);
        }}
      >
        <TodoMark
          status={summary.done === summary.total ? 'completed' : paused || !todos.some(todo => todo.status === 'in_progress') ? 'pending' : 'in_progress'}
          fresh={freshCompletion}
        />
        <span className="todo-toggle-label" title={summary.label}><RollText text={open ? 'Tasks' : summary.label} /></span>
        <span className="todo-count">
          <span className="af-sr">{summary.done}/{summary.total}</span>
          <span aria-hidden="true"><NumberTicker value={summary.done} />/{summary.total}</span>
        </span>
        <span className="todo-chevron">
          <ChevronUp size={14} />
        </span>
      </button>
      <Collapse open={open}><TodoList todos={todos} /></Collapse>
    </div>
  );
}

/**
 * The task counter's progress ring.
 *
 * "5/6" is a fact you have to read and then divide. The ring is the same
 * fact as a shape, so the state of the run is legible before the numerals
 * are, and the two sit next to each other rather than one replacing the
 * other -- the exact count still matters when you want it.
 *
 * Drawn from 12 o'clock and filled clockwise via a -90deg rotation,
 * because an arc that starts at 3 o'clock is read as a gauge rather than
 * as progress. The dash offset is the only animated property, so the fill
 * grows along the stroke instead of the element being repainted, and a
 * task completing mid-run is a visible motion rather than a jump.
 */
function TodoRing({ done, total }: { done: number; total: number }) {
  const radius = 6.25;
  const circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return (
    <svg
      className="todo-ring"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        className="todo-ring-track"
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="1.75"
      />
      <circle
        className="todo-ring-arc"
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - ratio)}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

/** The session panel's "Task progress" block. */
export function TodoProgress({ todos }: { todos: Todo[] }) {
  if (!todos.length) return null;
  const summary = todoSummary(todos);
  return (
    <section className="panel-section panel-task-progress" data-card-kind="tasks">
      <div className="panel-section-head">
        <h3 className="panel-heading">Task progress</h3>
        {summary ? <span className="panel-task-count" aria-label={`${summary.done} of ${summary.total} tasks complete`}><TodoRing done={summary.done} total={summary.total} /><span>{summary.done}/{summary.total}</span></span> : <span className="panel-section-count">Cancelled</span>}
      </div>
      <div className="panel-task-card"><TodoList todos={todos} /></div>
    </section>
  );
}
