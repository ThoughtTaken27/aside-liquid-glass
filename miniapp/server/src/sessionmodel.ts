import type { FacadeCache } from './facade.js';
import type { SessionModel } from './statedb.js';

export interface SessionModelUpdate {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export function modelUpdateExpression(
  sessionId: string,
  model: Required<SessionModel>,
): string {
  return `aside.sessions.update(${JSON.stringify(sessionId)}, ${JSON.stringify({ model })})`;
}

export async function applySessionModel(
  facade: FacadeCache,
  sessionId: string,
  update: SessionModelUpdate,
  current: SessionModel | null,
): Promise<Required<SessionModel>> {
  const model = {
    provider: update.provider,
    modelId: update.modelId,
    thinkingLevel: update.thinkingLevel,
    fastMode: current?.fastMode ?? false,
  };
  await facade.mutate(modelUpdateExpression(sessionId, model));
  return model;
}
