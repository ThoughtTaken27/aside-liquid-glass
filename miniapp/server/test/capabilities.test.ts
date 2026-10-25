import { describe, expect, it } from 'vitest';
import { AUTOMATIC, capabilities, prettyModel } from '../src/capabilities.js';

describe('prettyModel', () => {
  it('names the models he actually uses', () => {
    expect(prettyModel('bedrock-claude/global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('Claude Haiku 4.5 (AWS Bedrock)');
    expect(prettyModel('claude-code/claude-haiku-4-5')).toBe('Claude Haiku 4.5 (your Claude plan)');
    expect(prettyModel('9router/oc/space-bunny-free')).toBe('Space Bunny (retention not verified)');
    expect(prettyModel(null)).toBe('Not set');
    expect(prettyModel('  ')).toBe('Not set');
  });

  it('is honest about free models that train on inputs', () => {
    expect(prettyModel('9router/oc/muse-spark-1.3-contributor-free')).toBe('Muse Spark 1.3 (free; Meta may train on what it reads)');
    expect(prettyModel('9router/oc/mimo-v2.6-flash-free')).toMatch(/may be used to improve/);
  });

  it('handles other Claude ids and unknown models', () => {
    expect(prettyModel('claude-code/claude-fable-5')).toBe('Claude Fable 5 (your Claude plan)');
    expect(prettyModel('bedrock-claude/global.anthropic.claude-opus-4-6-v1')).toBe('Claude Opus 4.6 (AWS Bedrock)');
    expect(prettyModel('openai/gpt-5.6-sol')).toBe('gpt-5.6-sol (openai)');
  });
});

describe('capabilities', () => {
  const caps = capabilities({
    mailModel: 'bedrock-claude/global.anthropic.claude-haiku-4-5-20251001-v1:0',
    agentModel: 'claude-code/claude-haiku-4-5',
  });
  const by = (id: string) => caps.find((c) => c.id === id)!;

  it('covers every part of Next with its model', () => {
    expect(caps.map((c) => c.id)).toEqual(['sorter', 'drafter', 'planner', 'inspector', 'web', 'reader', 'helper']);
    expect(caps.map((c) => c.name)).toEqual(['Email sorter', 'Reply writer', 'Planner', 'Progress checker', 'Web researcher', 'Page reader', 'Task helper']);
    expect(by('sorter').model).toBe('Claude Haiku 4.5 (AWS Bedrock)');
    expect(by('drafter').model).toBe('Claude Haiku 4.5 (AWS Bedrock)');
    expect(by('planner').model).toBe('No model: plain arithmetic');
    for (const id of ['inspector', 'web', 'reader']) expect(by(id).model).toBe('Claude Haiku 4.5 (your Claude plan)');
    expect(by('helper').model).toBe('Disabled');
  });

  it('every helper starts only from a tap, and instruction-only rules say so', () => {
    for (const id of ['inspector', 'web', 'reader']) {
      expect(by(id).enforcedBy.some((r) => r.how === 'code' && /^Starts only when you tap/.test(r.rule))).toBe(true);
      expect(by(id).enforcedBy.some((r) => r.how === 'aside')).toBe(true);
    }
    for (const id of ['inspector', 'web', 'reader']) expect(by(id).never.join(' ')).toMatch(/Click, type, sign in, or submit/);
    const helper = by('helper').enforcedBy;
    expect(helper.every(r => r.how === 'code')).toBe(true);
    expect(helper.some(r => /refuses helper starts/.test(r.rule))).toBe(true);
    expect(by('helper').reads).toEqual([]);
  });

  it('says plainly what runs without a tap', () => {
    expect(AUTOMATIC.join(' ')).toMatch(/Nothing else starts until you tap/);
  });

  it('uses plain words', () => {
    for (const c of caps) {
      for (const line of [c.name, ...c.reads, ...c.can, ...c.never, ...c.enforcedBy.map((r) => r.rule)]) {
        expect(line).not.toMatch(/standby|hard limit|hand-off|inspector|proposal|session/i);
      }
    }
  });

  it('tool-less parts are code-enforced only', () => {
    for (const id of ['sorter', 'drafter', 'planner']) {
      expect(by(id).enforcedBy.every((r) => r.how === 'code')).toBe(true);
    }
  });

  it('keeps every line short and jargon-free', () => {
    for (const c of caps) {
      for (const line of [...c.reads, ...c.can, ...c.never, ...c.enforcedBy.map((r) => r.rule)]) {
        expect(line.length).toBeLessThanOrEqual(90);
        expect(line).not.toMatch(/dual-LLM|quarantin|capabilit|\u2014/i);
      }
    }
  });

  it('shows Not set when models are missing', () => {
    const none = capabilities({ mailModel: null, agentModel: null });
    expect(none.find((c) => c.id === 'web')!.model).toBe('Not set');
  });
});
