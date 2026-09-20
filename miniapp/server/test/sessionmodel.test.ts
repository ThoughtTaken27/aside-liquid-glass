import { describe, expect, it, vi } from 'vitest';
import { applySessionModel, modelUpdateExpression } from '../src/sessionmodel.js';

describe('session model updates', () => {
  it('builds one safely quoted Aside facade call', () => {
    expect(
      modelUpdateExpression('a"); bad(); //', {
        provider: 'OCX',
        modelId: 'gpt-5.6-luna',
        thinkingLevel: 'high',
        fastMode: true,
      }),
    ).toBe(
      'aside.sessions.update("a\\\"); bad(); //", {"model":{"provider":"OCX","modelId":"gpt-5.6-luna","thinkingLevel":"high","fastMode":true}})',
    );
  });

  it('preserves the session fast-mode flag', async () => {
    const mutate = vi.fn().mockResolvedValue('{}');
    await applySessionModel(
      { mutate } as any,
      'session1',
      { provider: 'OCX', modelId: 'gpt-5.6-luna', thinkingLevel: 'max' },
      { provider: 'MIMO', modelId: 'old', fastMode: true },
    );
    expect(mutate).toHaveBeenCalledWith(
      'aside.sessions.update("session1", {"model":{"provider":"OCX","modelId":"gpt-5.6-luna","thinkingLevel":"max","fastMode":true}})',
    );
  });
});
