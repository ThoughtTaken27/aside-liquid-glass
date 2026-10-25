import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW,
  buildCatalog,
  modelLabel,
  readProviderIds,
} from '../src/catalog.js';

const temps: string[] = [];

function writeCredentials(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-cred-'));
  temps.push(dir);
  const file = path.join(dir, 'credentials.json');
  fs.writeFileSync(file, body);
  return file;
}

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('credential seeding', () => {
  it('reads only the top-level keys', () => {
    const file = writeCredentials(
      JSON.stringify({
        'claude-code': { access_token: 'SECRET-A', refresh: 'SECRET-B' },
        'openai-codex': { api_key: 'SECRET-C' },
      }),
    );
    expect(readProviderIds(file)).toEqual(['claude-code', 'openai-codex']);
  });

  it('treats a missing or malformed file as "no information"', () => {
    expect(readProviderIds('/nope/credentials.json')).toEqual([]);
    expect(readProviderIds(writeCredentials('not json'))).toEqual([]);
    expect(readProviderIds(writeCredentials('[1,2]'))).toEqual([]);
  });
});

describe('buildCatalog', () => {
  it('marks credentialed providers connected and sorts them first', () => {
    const catalog = buildCatalog(['openai-codex']);
    expect(catalog[0].id).toBe('openai-codex');
    expect(catalog[0].connected).toBe(true);
    expect(catalog.find((p) => p.id === 'claude-code')?.connected).toBe(false);
  });

  it('uses Aside display names and model ids', () => {
    const catalog = buildCatalog(['claude-code', 'openai-codex']);
    const claude = catalog.find((p) => p.id === 'claude-code')!;
    const chatgpt = catalog.find((p) => p.id === 'openai-codex')!;

    expect(claude.label).toBe('Claude');
    expect(claude.models.map((m) => m.label)).toContain('Fable 5.1');
    expect(claude.models.find((m) => m.label === 'Fable 5.1')?.id).toBe(
      'claude-fable-5-1',
    );

    expect(chatgpt.label).toBe('ChatGPT');
    expect(chatgpt.models.map((m) => m.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.3-codex-spark',
    ]);
    expect(chatgpt.models.find((m) => m.id === 'gpt-5.6-sol')?.contextWindow).toBe(272_000);
    expect(chatgpt.models.find((m) => m.id === 'gpt-5.3-codex-spark')?.contextWindow).toBe(128_000);
  });

  it('shows every built-in provider when credentials cannot be read', () => {
    const catalog = buildCatalog([]);
    expect(catalog.length).toBeGreaterThanOrEqual(2);
    expect(catalog.every((p) => p.connected)).toBe(true);
  });

  it('gives an unknown credentialed provider its own row', () => {
    const catalog = buildCatalog(['some-new-provider']);
    const row = catalog.find((p) => p.id === 'some-new-provider');
    expect(row).toBeDefined();
    expect(row?.connected).toBe(true);
  });

  it('merges config overrides over the built-in table', () => {
    const catalog = buildCatalog(['claude-code'], {
      'claude-code': { models: [{ id: 'claude-fable-6', label: 'Fable 6' }] },
    });
    const claude = catalog.find((p) => p.id === 'claude-code')!;
    // Merge keeps the built-ins and adds the new one.
    expect(claude.models.map((m) => m.id)).toContain('claude-fable-5-1');
    expect(claude.models.map((m) => m.id)).toContain('claude-fable-6');
  });

  it('replaces a provider list when asked, and can rename it', () => {
    const catalog = buildCatalog(['claude-code'], {
      'claude-code': {
        label: 'Anthropic',
        replace: true,
        models: [{ id: 'only-one', label: 'Only One' }],
      },
    });
    const claude = catalog.find((p) => p.id === 'claude-code')!;
    expect(claude.label).toBe('Anthropic');
    expect(claude.models).toEqual([
      { id: 'only-one', label: 'Only One', contextWindow: DEFAULT_CONTEXT_WINDOW },
    ]);
  });

  it('can add a provider that has no built-in entry', () => {
    const catalog = buildCatalog([], {
      'my-local': {
        label: 'Local',
        connected: true,
        models: [{ id: 'llama', label: 'Llama' }],
      },
    });
    expect(catalog.find((p) => p.id === 'my-local')?.label).toBe('Local');
  });

  it('keeps an explicitly hidden provider out even when desktop-bound', () => {
    const catalog = buildCatalog(
      ['claude-code', 'openai-codex'],
      { 'claude-code': { hidden: true } },
      [],
      [{ provider: 'claude-code', modelId: 'claude-opus-5', thinkingLevel: 'high' }],
    );
    expect(catalog.some((p) => p.id === 'claude-code')).toBe(false);
    expect(catalog.some((p) => p.id === 'openai-codex')).toBe(true);
  });
});

describe('modelLabel', () => {
  const catalog = buildCatalog(['claude-code']);

  it('resolves a display name for the pill', () => {
    expect(modelLabel(catalog, 'claude-code', 'claude-fable-5-1')).toBe('Fable 5.1');
  });

  it('falls back to the raw id rather than hiding an unknown model', () => {
    expect(modelLabel(catalog, 'claude-code', 'claude-future-9')).toBe(
      'claude-future-9',
    );
  });
});
