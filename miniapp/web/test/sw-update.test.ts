/**
 * An installed phone app must not keep painting a build that no longer
 * exists on the server.
 *
 * This is source-level rather than behavioural because `registerServiceWorker`
 * touches `navigator.serviceWorker`, `location.reload` and the real document
 * lifecycle, and a jsdom mock of all three tests the mock more than the code.
 * What is worth pinning is the contract itself.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const standalone = readFileSync(
  path.join(here, '../src/standalone.ts'),
  'utf8',
);
const source = standalone.slice(standalone.indexOf('export function registerServiceWorker'));

describe('picking up a new build on a phone that is never navigated', () => {
  it('asks for an update when the app returns to the foreground', () => {
    expect(source).toMatch(/addEventListener\('visibilitychange'/);
    expect(source).toMatch(/visibilityState !== 'visible'/);
    expect(source).toMatch(/registration\.update\(\)/);
  });

  it('rate limits the check so app-switching does not hammer the Mac', () => {
    expect(standalone).toMatch(/SW_UPDATE_MIN_INTERVAL_MS = 30_000/);
    expect(source).toMatch(/now - last < SW_UPDATE_MIN_INTERVAL_MS/);
  });

  it('reloads once when a new worker claims the page', () => {
    expect(source).toMatch(/addEventListener\('controllerchange'/);
    expect(source).toMatch(/location\.reload\(\)/);
  });

  it('does not reload on a first install, which has no previous controller', () => {
    expect(source).toMatch(/hadController = Boolean\(navigator\.serviceWorker\.controller\)/);
    expect(source).toMatch(/if \(!hadController \|\| reloading\) return;/);
  });
});
