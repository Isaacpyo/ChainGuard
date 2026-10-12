import type { StreamEvent } from '@chainguard/shared';
import { describe, expect, it, vi } from 'vitest';
import { SseParser, openEventStream, type ConnectionState } from '@/lib/sse';

describe('SseParser', () => {
  it('parses complete frames and buffers partial ones across chunks', () => {
    const p = new SseParser();
    expect(p.push('event: alert\ndata: {"a"')).toEqual([]);
    expect(p.push(':1}\n\nevent: ping')).toEqual([{ event: 'alert', data: '{"a":1}' }]);
    expect(p.push('\ndata: x\n\n')).toEqual([{ event: 'ping', data: 'x' }]);
  });

  it('ignores comments/heartbeats and joins multi-line data', () => {
    const p = new SseParser();
    expect(p.push(': ping\n\nretry: 3000\n\ndata: line1\ndata: line2\n\n')).toEqual([
      { event: 'message', data: 'line1\nline2' },
    ]);
  });

  it('normalises CRLF line endings', () => {
    expect(new SseParser().push('event: a\r\ndata: b\r\n\r\n')).toEqual([
      { event: 'a', data: 'b' },
    ]);
  });
});

function streamResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('openEventStream', () => {
  const event: StreamEvent = {
    type: 'simulation.step',
    simulationId: 's1',
    step: 'attack',
    message: 'go',
    at: new Date(0).toISOString(),
  };

  it('sends the token as a header and delivers parsed events', async () => {
    const received: StreamEvent[] = [];
    const states: ConnectionState[] = [];
    const fetchImpl = vi.fn(async () =>
      streamResponse([`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`]),
    );
    const close = openEventStream({
      url: 'http://api/stream',
      token: 'tkn',
      onEvent: (e) => received.push(e),
      onState: (s) => states.push(s),
      onUnauthorized: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await vi.waitFor(() => expect(received).toEqual([event]));
    close();
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tkn');
    expect(states.slice(0, 2)).toEqual(['connecting', 'live']);
  });

  it('stops and reports a rejected token', async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    openEventStream({
      url: 'http://api/stream',
      token: 'expired',
      onEvent: () => undefined,
      onState: () => undefined,
      onUnauthorized,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reconnects after the stream drops', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => streamResponse([]));
      const states: ConnectionState[] = [];
      const close = openEventStream({
        url: 'http://api/stream',
        token: 't',
        onEvent: () => undefined,
        onState: (s) => states.push(s),
        onUnauthorized: () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await vi.advanceTimersByTimeAsync(2_500);
      close();
      expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(states).toContain('reconnecting');
    } finally {
      vi.useRealTimers();
    }
  });

  /** A stream that stays open until the test ends. */
  const openStream = () =>
    new Response(new ReadableStream<Uint8Array>(), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

  it('asks for a resync when the stream comes back after a drop, not on the first connect', async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      // The first connection drops straight away; the second one stays up.
      const responses = [() => streamResponse([]), openStream];
      const fetchImpl = vi.fn(async () => responses.shift()!());
      const close = openEventStream({
        url: 'http://api/stream',
        token: 't',
        onEvent: () => undefined,
        onState: (s) => log.push(s),
        onUnauthorized: () => undefined,
        onReconnect: () => log.push('resync'),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(log).toEqual(['connecting', 'live', 'reconnecting']);
      await vi.advanceTimersByTimeAsync(2_500);
      close();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(log).toEqual(['connecting', 'live', 'reconnecting', 'reconnecting', 'live', 'resync']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks for a resync when the first attempt failed, since state was loaded without the stream', async () => {
    vi.useFakeTimers();
    try {
      const responses = [
        () => Promise.reject(new TypeError('fetch failed')),
        async () => openStream(),
      ];
      const fetchImpl = vi.fn(() => responses.shift()!());
      const onReconnect = vi.fn();
      const close = openEventStream({
        url: 'http://api/stream',
        token: 't',
        onEvent: () => undefined,
        onState: () => undefined,
        onUnauthorized: () => undefined,
        onReconnect,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(onReconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_500);
      close();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(onReconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
