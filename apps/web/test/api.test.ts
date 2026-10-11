import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, WAKING_AFTER_MS, request } from '@/lib/api';
import { getServerStatus, setServerStatus } from '@/lib/server-status';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.useRealTimers();
  setServerStatus('unknown');
});

describe('request', () => {
  it('returns parsed JSON and marks the server ready', async () => {
    const fetchImpl = vi.fn(async () => json(200, { ok: true }));
    await expect(request('/x', { auth: false, fetchImpl })).resolves.toEqual({ ok: true });
    expect(getServerStatus()).toBe('ready');
  });

  it('maps error bodies to ApiError with field details', async () => {
    const fetchImpl = vi.fn(async () =>
      json(400, {
        error: 'invalid_request',
        message: 'bad',
        details: [{ path: 'email', message: 'Invalid email' }],
      }),
    );
    const err = await request('/x', { auth: false, fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 400,
      code: 'invalid_request',
      details: [{ path: 'email' }],
    });
  });

  it('shows the waking state when the first response is slow', async () => {
    vi.useFakeTimers();
    let resolve!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    const pending = request('/x', { auth: false, fetchImpl });
    await vi.advanceTimersByTimeAsync(WAKING_AFTER_MS - 1);
    expect(getServerStatus()).toBe('unknown');
    await vi.advanceTimersByTimeAsync(1);
    expect(getServerStatus()).toBe('waking');
    resolve(json(200, {}));
    await pending;
    expect(getServerStatus()).toBe('ready');
  });

  it('retries network errors and cold-start 503s for GETs while the server boots', async () => {
    const responses: (() => Promise<Response>)[] = [
      () => Promise.reject(new TypeError('fetch failed')),
      async () => json(503, { error: 'unavailable' }),
      async () => json(200, { ok: 1 }),
    ];
    const fetchImpl = vi.fn(() => responses.shift()!());
    const sleep = vi.fn(async () => undefined);
    await expect(request('/x', { auth: false, fetchImpl, sleep })).resolves.toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry a POST that got a 503', async () => {
    const fetchImpl = vi.fn(async () => json(503, { error: 'sandbox_disabled', message: 'nope' }));
    await expect(request('/x', { method: 'POST', auth: false, fetchImpl })).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
