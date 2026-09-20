import { describe, expect, it } from 'vitest';
import {
  applySessionState,
  resolveThreadModel,
  type SessionStateEvent,
} from '../src/utils/sessionState';

describe('cross-device session state', () => {
  const phoneDefault = {
    provider: 'MIMO',
    modelId: 'mimo-v2',
    modelLabel: 'MiMo V2',
    effortId: 'medium',
    effortLabel: 'Medium',
  };

  it('uses the daemon session model instead of a stale phone default', () => {
    expect(
      resolveThreadModel(
        {
          provider: 'OCX',
          modelId: 'gpt-5.6-luna',
          label: 'GPT-5.6 Luna',
          effort: 'high',
          effortLabel: 'High',
        },
        phoneDefault,
      ),
    ).toEqual({
      provider: 'OCX',
      modelId: 'gpt-5.6-luna',
      modelLabel: 'GPT-5.6 Luna',
      effortId: 'high',
      effortLabel: 'High',
    });
  });

  it('merges a live state frame and keeps unrelated thread content', () => {
    const previous = {
      sessionId: 'fixtureAAAA',
      title: 'Old',
      status: 'idle',
      busy: false,
      queued: 0,
      permission: 'Full access',
      permissionMode: 'full-access',
      finalConfirm: true,
      softConfirm: false,
      model: null,
      contextWindow: 0,
      items: [{ kind: 'answer', id: 'a', text: 'keep me' }],
      muted: false,
    } as any;
    const event: SessionStateEvent = {
      type: 'session_state',
      sessionId: 'fixtureAAAA',
      title: 'From Mac',
      status: 'running',
      busy: true,
      stoppable: false,
      queued: 0,
      permission: 'Guard',
      permissionMode: 'guard',
      finalConfirm: false,
      softConfirm: false,
      model: {
        provider: 'OCX',
        modelId: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        effort: 'max',
        effortLabel: 'Max',
      },
      contextWindow: 400_000,
      suspended: false,
    };

    const next = applySessionState(previous, event);
    expect(next.items).toBe(previous.items);
    expect(next).toMatchObject({
      title: 'From Mac',
      status: 'running',
      busy: true,
      permissionMode: 'guard',
      model: { modelId: 'gpt-5.6-luna', effort: 'max' },
      contextWindow: 400_000,
    });
  });
});

import { hasPendingNativeQuestion } from '../src/utils/sessionState';
import { applyDelta } from '../src/hooks/useThread';
import type { ThreadItem } from '../src/types';
it('updates recovery when a live delta arrives and clears it after the answer', () => {
  const question: ThreadItem = { kind: 'question', id: 'q', source: 'tool', status: 'pending', answerable: false, variant: 'ask', questions: [] };
  expect(hasPendingNativeQuestion([])).toBe(false);
  const arrived = applyDelta([], { fromIndex: 0, items: [question], length: 1 });
  expect(hasPendingNativeQuestion(arrived)).toBe(true);
  const answered = applyDelta(arrived, { fromIndex: 0, items: [{ ...question, status: 'answered' }], length: 1 });
  expect(hasPendingNativeQuestion(answered)).toBe(false);
});

it('does not substitute a phone effort override for an unset laptop effort', () => {
  expect(resolveThreadModel({provider:'test',modelId:'current',label:'Current',effort:null,effortLabel:null}, {provider:'old',modelId:'old',modelLabel:'Old',effortId:'max',effortLabel:'Max'}).effortId).toBe('');
});
