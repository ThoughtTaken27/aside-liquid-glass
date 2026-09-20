import type { ThreadItem, ThreadModel, ThreadResponse } from '../types';

export interface SessionStateEvent {
  type: 'session_state';
  sessionId: string;
  title: string;
  status: string;
  busy: boolean;
  stoppable: boolean;
  queued: number;
  permission: string | null;
  permissionMode: string | null;
  finalConfirm: boolean | null;
  softConfirm: boolean;
  model: ThreadModel | null;
  contextWindow: number;
  suspended: boolean;
}

export interface ModelPills {
  provider: string;
  modelId: string;
  modelLabel: string;
  effortId: string;
  effortLabel: string;
}

/** Existing sessions belong to the daemon. Phone storage is only a new-chat default. */
export function resolveThreadModel(
  model: ThreadModel | null,
  fallback: ModelPills,
): ModelPills {
  if (!model) return fallback;
  return {
    provider: model.provider,
    modelId: model.modelId,
    modelLabel: model.label,
    effortId: model.effort || '',
    effortLabel: model.effortLabel || model.effort || 'Default',
  };
}

/** Merge only session metadata. Transcript content remains independently authoritative. */
export function applySessionState(
  previous: ThreadResponse,
  event: SessionStateEvent,
): ThreadResponse {
  return {
    ...previous,
    title: event.title,
    status: event.status,
    busy: event.busy,
    stoppable: event.stoppable,
    queued: event.queued,
    permission: event.permission,
    permissionMode: event.permissionMode,
    finalConfirm: event.finalConfirm,
    softConfirm: event.softConfirm,
    model: event.model,
    contextWindow: event.contextWindow,
    suspended: event.suspended,
  };
}

/** Live transcript items, not an opening REST snapshot, own recovery availability. */
export function hasPendingNativeQuestion(items: ThreadItem[]): boolean {
  return items.some(item => item.kind === 'question' && item.source === 'tool' &&
    item.status === 'pending' && !item.answerable);
}
