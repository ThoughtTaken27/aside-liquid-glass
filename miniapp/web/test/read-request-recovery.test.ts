import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setAuthToken } from '../src/api';
vi.mock('../src/relays', () => ({ considerFailover: vi.fn() }));
const response = (status = 200, retry = '1') => new Response(JSON.stringify(status === 200 ? { ok: true } : { error: 'Too Many Requests' }), { status, headers: { 'retry-after': retry } });
let mockFetch: ReturnType<typeof vi.fn>;
beforeEach(() => { vi.useFakeTimers(); setAuthToken('synthetic-read-device'); mockFetch = vi.fn(); vi.stubGlobal('fetch', mockFetch); });
afterEach(() => { setAuthToken(''); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('safe read recovery', () => {
 it('dedupes overlapping GETs without retaining their data afterwards', async () => {
  let release!: (r: Response) => void; mockFetch.mockReturnValueOnce(new Promise(r => { release = r; })).mockResolvedValue(response());
  const a = api.status(), b = api.status(); expect(mockFetch).toHaveBeenCalledTimes(1); release(response()); await Promise.all([a,b]);
  await api.status(); expect(mockFetch).toHaveBeenCalledTimes(2);
 });
 it('honors Retry-After and retries a GET only once', async () => {
  mockFetch.mockResolvedValueOnce(response(429, '2')).mockResolvedValueOnce(response());
  const read = api.status(); await vi.advanceTimersByTimeAsync(1999); expect(mockFetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); await read; expect(mockFetch).toHaveBeenCalledTimes(2);
 });
 it('a second 429 remains a real error rather than an endless retry loop', async () => {
  mockFetch.mockImplementation(() => Promise.resolve(response(429)));
  const read = api.status().catch(e => e); await vi.advanceTimersByTimeAsync(1000);
  expect((await read).status).toBe(429); expect(mockFetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000); expect(mockFetch).toHaveBeenCalledTimes(2);
 });
 it('never automatically replays POSTs', async () => {
  mockFetch.mockResolvedValue(response(429)); await expect(api.auth('synthetic')).rejects.toMatchObject({ status: 429 });
  await vi.advanceTimersByTimeAsync(60_000); expect(mockFetch).toHaveBeenCalledTimes(1);
 });
 it('cancelled reads do not wait out a cooldown or probe another relay', async () => {
  mockFetch.mockResolvedValue(response(429, '5')); const controller = new AbortController();
  const read = api.omnibox('synthetic', controller.signal).catch(e => e); await vi.advanceTimersByTimeAsync(1); controller.abort();
  expect((await read).name).toBe('AbortError'); await vi.advanceTimersByTimeAsync(5000); expect(mockFetch).toHaveBeenCalledTimes(1);
 });
});
