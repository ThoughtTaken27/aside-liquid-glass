import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setAuthToken, setUnauthorizedHandler } from '../src/api';

const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

function response(ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Unauthorized',
    blob: async () => new Blob(['protected'], { type: 'image/webp' }),
  } as Response;
}

beforeEach(() => {
  setAuthToken('secret-bearer');
  vi.stubGlobal('fetch', vi.fn(async () => response()));
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:protected-frame'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  setAuthToken('');
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
  if (createDescriptor) Object.defineProperty(URL, 'createObjectURL', createDescriptor);
  else delete (URL as unknown as Record<string, unknown>).createObjectURL;
  if (revokeDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor);
  else delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
});

function expectProtectedFetch(expectedUrl: string) {
  const [url, init] = vi.mocked(fetch).mock.calls[0];
  expect(String(url)).toBe(expectedUrl);
  expect(String(url)).not.toContain('token=');
  expect((init?.headers as Headers).get('authorization')).toBe('Bearer secret-bearer');
}

describe('protected resource transport', () => {
  it('fetches artifact bytes with a header, never a query credential', async () => {
    await api.artifactBlob('session id', 'artifacts', 'private note.md');
    expectProtectedFetch(
      '/api/sessions/session%20id/artifacts/file?group=artifacts&path=private%20note.md',
    );
  });

  it('renders a local file through an ephemeral object URL', async () => {
    await expect(api.localFileObjectUrl('abc', '/Users/owner/shot.png')).resolves.toBe(
      'blob:protected-frame',
    );
    expectProtectedFetch(
      '/api/sessions/abc/file?path=%2FUsers%2Fowner%2Fshot.png',
    );
    expect(vi.mocked(fetch).mock.calls[0][1]?.credentials).toBe('same-origin');
  });

  it('renders a tab capture through an ephemeral object URL', async () => {
    await expect(api.captureObjectUrl('target/one', 60)).resolves.toBe(
      'blob:protected-frame',
    );
    expectProtectedFetch('/api/tabs/target%2Fone/capture.webp?q=60');
    expect(vi.mocked(fetch).mock.calls[0][1]?.credentials).toBe('same-origin');
  });

  it('does not mint an object URL and invokes recovery after a 401', async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.mocked(fetch).mockResolvedValueOnce(response(false, 401));
    await expect(api.captureObjectUrl('target')).rejects.toBeInstanceOf(ApiError);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(unauthorized).toHaveBeenCalledTimes(1);

    vi.mocked(fetch).mockResolvedValueOnce(response());
    await api.captureObjectUrl('next');
    expect((vi.mocked(fetch).mock.calls[1][1]?.headers as Headers).get('authorization')).toBeNull();
  });
});
