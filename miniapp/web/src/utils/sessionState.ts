import type {
  CatalogProvider,
  ThreadItem,
  ThreadModel,
  ThreadResponse,
} from '../types';

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
  catalog?: CatalogProvider[],
): ModelPills {
  if (!model) return fallback;
  // A session whose model the Mac has since dropped (or whose provider
  // lost its credentials) falls back to the phone pills -- which are
  // themselves catalog-validated -- instead of showing and sending a
  // model id nothing will honor.
  if (catalog) {
    const entry = catalog.find((p) => p.id === model.provider);
    const usable =
      entry?.connected !== false &&
      entry?.models.some((m) => m.id === model.modelId) === true;
    if (!usable) return fallback;
  }
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
