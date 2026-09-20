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
import { useState } from 'react';
import { ChevronDown, ChevronUp, TodoCircle } from './Icons';
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

function TodoRow({ todo }: { todo: Todo }) {
  return (
    <li className={`todo-row is-${todo.status}`}>
      <TodoCircle status={todo.status} />
      <span className="todo-content">{todo.content}</span>
    </li>
  );
}

export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="todo-list">
      {todos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} />
      ))}
    </ul>
  );
}

export function TodoSection({ todos, paused = false }: { todos: Todo[]; paused?: boolean }) {
  const [open, setOpen] = useState(false);
  const summary = todoSummary(todos);
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
        {open ? (
          <span className="todo-toggle-title">Tasks</span>
        ) : (
          <>
            <TodoCircle
              status={
                summary.done === summary.total ? 'completed' : paused ? 'pending' : 'in_progress'
              }
              size={14}
            />
            <span className="todo-toggle-label">{summary.label}</span>
          </>
        )}
        <TodoRing done={summary.done} total={summary.total} />
        <span className="todo-count">
          {summary.done}/{summary.total}
        </span>
        <span className="todo-chevron">
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </span>
      </button>
      {open ? <TodoList todos={todos} /> : null}
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
  return (
    <section
      className="panel-section utility-card"
      data-card-group="utility"
      data-card-kind="tasks"
      data-card-state="expanded"
    >
      <h3 className="panel-heading">Task progress</h3>
      <TodoList todos={todos} />
    </section>
  );
}
