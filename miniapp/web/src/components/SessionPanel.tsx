import { useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import { Creature } from './Creature';
import { FileIcon, Spinner } from './Icons';
import { FileViewer } from './FileViewer';
import { TodoProgress } from './TodoSection';
import { api } from '../api';
import { formatBytes } from '../utils/format';
import { relativeTime } from '../utils/time';
import { haptic } from '../telegram';
import type { ArtifactFile, ArtifactGroup, ChildSession, Todo } from '../types';

const GROUP_LABELS: Record<ArtifactGroup, string> = {
  artifacts: 'Files',
  attachments: 'Attachments',
};

/**
 * The session sidebar: who worked on this, and what came out of it.
 *
 * Mirrors what the desktop app keeps beside a session -- its subagents and
 * its artifacts -- as a right-edge sheet, since a phone has no room for a
 * permanent column. Subagents come from the thread payload, which already
 * has them; files are fetched when the panel opens, because nothing else in
 * the app needs them.
 */
export function SessionPanel({
  sessionId,
  subagents,
  todos,
  muted,
  onToggleMute,
  onInspectSubagent,
  onClose,
}: {
  sessionId: string;
  subagents: ChildSession[];
  /** The agent's task list, drawn as "Task progress" at the bottom. */
  todos: Todo[];
  /** Current mute state, from the thread payload. */
  muted: boolean;
  /** Toggle mute on/off; the panel does the API call and calls this to reflect. */
  onToggleMute: (next: boolean) => void;
  onInspectSubagent: (childId: string, title: string) => void;
  onClose: () => void;
}) {
  const [groups, setGroups] = useState<
    Array<{ id: ArtifactGroup; files: ArtifactFile[] }> | null
  >(null);
  const [open, setOpen] = useState<{ group: ArtifactGroup; file: ArtifactFile } | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    api.artifacts(sessionId).then(
      (res) => alive && setGroups(res.groups),
      () => alive && setGroups([]),
    );
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const populated = (groups ?? []).filter((group) => group.files.length);

  const [muting, setMuting] = useState(false);

  // Single toggle: 24h mute on, unmute off. Keeping it at one button rather
  // than a duration picker -- muting is low-stakes and easily reversible.
  const toggleMute = async () => {
    haptic('light');
    setMuting(true);
    try {
      if (muted) {
        onToggleMute(false);
        await api.unmute(sessionId);
      } else {
        onToggleMute(true);
        await api.mute(sessionId);
      }
    } catch {
      // Revert the optimistic update.
      onToggleMute(muted);
    } finally {
      setMuting(false);
    }
  };



  return (
    <>
      <Sheet side="right" title="Session" onClose={onClose}>
        <section
          className="panel-section surface-section"
          data-surface-section="subagents"
        >
          <h3 className="panel-heading" data-surface-heading>
            Subagents
          </h3>
          {subagents.length ? (
            <ul
              className="panel-list surface-group"
              data-surface-group="subagents"
              data-separator="inset"
            >
              {subagents.map((child) => (
                <li key={child.id}>
                  <button
                    type="button"
                    className="panel-row surface-row"
                    data-surface-row="subagent"
                    onClick={() => onInspectSubagent(child.id, child.title)}
                  >
                    <Creature slot={child.hue} />
                    <span className="panel-row-name">{child.title}</span>
                    <span
                      className={`badge surface-meta ${child.running ? '' : 'is-muted'}`}
                      data-surface-meta="status"
                    >
                      {child.running ? 'Running' : 'Done'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="panel-empty is-blank">No subagents in this session.</p>
          )}
        </section>

        <section
          className="panel-section surface-section"
          data-surface-section="notifications"
        >
          <h3 className="panel-heading" data-surface-heading>
            Notifications
          </h3>
          {/*
            The switch tracks the LABEL, not the mute flag.

            It used to be on when `muted` was true, so the one state a
            reader can actually see -- notifications working normally --
            drew a switch in its off position directly beside the words
            "Notifications on". A control that contradicts its own label is
            not a subtle finish problem; it makes the reader distrust the
            setting and tap it to find out, which is the opposite of what
            a toggle is for. Muting is still what the tap does; it is now
            drawn as turning notifications off, which is what it means.

            `role="switch"` with `aria-checked` moves the same state into
            the accessibility tree, where previously the switch was
            `aria-hidden` and the button announced no state at all.
          */}
          <button
            type="button"
            className="panel-row surface-row mute-row"
            data-surface-row="notifications"
            onClick={toggleMute}
            disabled={muting}
            role="switch"
            aria-checked={!muted}
          >
            <span className={muted ? 'switch' : 'switch is-on'} aria-hidden="true">
              <span className="switch-knob" />
            </span>
            <span className="panel-row-name">
              {muted ? 'Muted (24h)' : 'Notifications on'}
            </span>
            {muting ? <Spinner size={13} /> : null}
          </button>
        </section>

        <section
          className="panel-section surface-section"
          data-surface-section="files"
        >
          {groups === null ? (
            <p className="panel-empty">
              <Spinner size={13} /> Loading files…
            </p>
          ) : populated.length ? (
            populated.map((group) => (
              <div
                className="panel-subsection surface-section"
                data-surface-section={group.id}
                key={group.id}
              >
                <h3 className="panel-heading" data-surface-heading>
                  {GROUP_LABELS[group.id]}
                </h3>
                <ul
                  className="panel-list surface-group"
                  data-surface-group="files"
                  data-separator="inset"
                >
                  {group.files.map((file) => (
                    <li key={file.path}>
                      <button
                        type="button"
                        className="panel-row surface-row"
                        data-surface-row="file"
                        onClick={() => setOpen({ group: group.id, file })}
                      >
                        <FileIcon size={14} strokeWidth={1.75} />
                        <span className="panel-row-name">{file.name}</span>
                        <span
                          className="panel-row-meta surface-meta"
                          data-surface-meta="file"
                        >
                          {formatBytes(file.size)} · {relativeTime(file.mtime)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <>
              <h3 className="panel-heading" data-surface-heading>
                Files
              </h3>
              <p className="panel-empty is-blank">This session has no files yet.</p>
            </>
          )}
        </section>

        {/* Last, as in the desktop panel. */}
        <TodoProgress todos={todos} />
      </Sheet>

      {open ? (
        <FileViewer
          sessionId={sessionId}
          group={open.group}
          file={open.file}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}
