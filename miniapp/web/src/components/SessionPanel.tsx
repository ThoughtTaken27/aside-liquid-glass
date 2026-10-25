import { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { Creature } from './Creature';
import { ChevronRight, FileIcon, Spinner } from './Icons';
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

  const [filesError, setFilesError] = useState(false);
  const readSequence = useRef(0);
  const loadFiles = useCallback(async () => {
    const sequence = ++readSequence.current;
    setFilesError(false);
    setGroups(null);
    try {
      const res = await api.artifacts(sessionId);
      if (sequence === readSequence.current) setGroups(res.groups);
    } catch {
      if (sequence === readSequence.current) { setFilesError(true); setGroups([]); }
    }
  }, [sessionId]);
  useEffect(() => {
    void loadFiles();
    return () => { readSequence.current += 1; };
  }, [loadFiles]);

  const populated = (groups ?? []).filter((group) => group.files.length);
  const fileCount = populated.reduce((n, group) => n + group.files.length, 0);
  const [muting, setMuting] = useState(false);
  const mutingNow = useRef(false);
  const [muteError, setMuteError] = useState(false);
  const toggleMute = async () => {
    if (mutingNow.current) return;
    mutingNow.current = true;
    haptic('light');
    setMuting(true);
    setMuteError(false);
    onToggleMute(!muted);
    try {
      if (muted) await api.unmute(sessionId);
      else await api.mute(sessionId);
    } catch {
      onToggleMute(muted);
      setMuteError(true);
    } finally {
      mutingNow.current = false;
      setMuting(false);
    }
  };

  return (
    <>
      <Sheet side="right" title="Session" className="session-panel" onClose={onClose}>
        <section
          className="panel-section surface-section"
          data-surface-section="subagents"
        >
          <div className="panel-section-head">
            <h3 className="panel-heading" data-surface-heading>Subagents</h3>
            {subagents.length ? <span className="panel-section-count">{subagents.length}</span> : null}
          </div>
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
                    aria-label={`${child.title}, ${child.running ? 'Running' : 'Done'}`}
                    onClick={() => onInspectSubagent(child.id, child.title)}
                  >
                    <Creature slot={child.hue} />
                    <span className="panel-row-name">{child.title}</span>
                    <span
                      className={`panel-agent-status surface-meta ${child.running ? 'is-running' : ''}`}
                      data-surface-meta="status"
                    >
                      {child.running ? 'Running' : 'Done'}
                    </span>
                    <ChevronRight className="panel-row-chevron" size={14} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="panel-empty panel-empty-inline">No subagents in this session.</p>
          )}
        </section>

        <section
          className="panel-section surface-section"
          data-surface-section="notifications"
        >
          <button
            type="button"
            className="panel-row surface-row mute-row"
            data-surface-row="notifications"
            onClick={toggleMute}
            disabled={muting}
            role="switch"
            aria-label="Notifications"
            aria-checked={!muted}
            aria-busy={muting}
          >
            <span className="panel-row-text">
              <span className="panel-row-name">Notifications</span>
              <span className="panel-row-caption">{muting ? 'Updating…' : muted ? 'Muted for 24 hours' : 'On for this chat'}</span>
            </span>
            <span className={muted ? 'switch' : 'switch is-on'} aria-hidden="true">
              <span className="switch-knob" />
            </span>
          </button>
          {muteError ? <p className="panel-inline-error" role="alert">Couldn’t update notifications. Try again.</p> : null}

        </section>

        <section
          className="panel-section surface-section"
          data-surface-section="files"
        >
          <div className="panel-section-head">
            <h3 className="panel-heading" data-surface-heading>Files</h3>
            {groups !== null && !filesError && fileCount > 0 ? <span className="panel-section-count">{fileCount}</span> : null}
          </div>
          {groups === null ? (
            <p className="panel-empty panel-empty-inline" role="status"><Spinner size={14} /> Loading files…</p>
          ) : filesError ? (
            <div className="panel-file-error" role="alert">
              <span>Couldn’t load files.</span>
              <button type="button" className="craft-ghost" onClick={() => void loadFiles()}>Try again</button>
            </div>
          ) : populated.length ? (
            populated.map((group) => (
              <div className="panel-subsection surface-section" data-surface-section={group.id} key={group.id}>
                {populated.length > 1 || group.id === 'attachments' ? <h4 className="panel-file-group">{GROUP_LABELS[group.id]}</h4> : null}
                <ul className="panel-list surface-group" data-surface-group="files" data-separator="inset">
                  {group.files.map((file) => (
                    <li key={file.path}>
                      <button type="button" className="panel-row surface-row" data-surface-row="file" onClick={() => setOpen({ group: group.id, file })}>
                        <span className="panel-file-icon"><FileIcon size={16} strokeWidth={1.75} /></span>
                        <span className="panel-row-text">
                          <span className="panel-row-name">{file.name}</span>
                          <span className="panel-row-caption">{formatBytes(file.size)} · {relativeTime(file.mtime)}</span>
                        </span>
                        <ChevronRight className="panel-row-chevron" size={14} aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <p className="panel-empty panel-empty-inline"><FileIcon size={16} aria-hidden />No files in this session yet.</p>
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
