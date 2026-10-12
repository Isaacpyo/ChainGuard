import type { StreamEvent } from '@chainguard/shared';

/**
 * Incremental parser for the text/event-stream format. Feed it chunks as they
 * arrive; it returns complete events and buffers partial ones.
 */
export class SseParser {
  #buffer = '';

  push(chunk: string): { event: string; data: string }[] {
    this.#buffer += chunk.replace(/\r\n?/g, '\n');
    const out: { event: string; data: string }[] = [];
    let boundary = this.#buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (!line || line.startsWith(':')) continue; // comment / heartbeat
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) out.push({ event, data: data.join('\n') });
      boundary = this.#buffer.indexOf('\n\n');
    }
    return out;
  }
}

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

export interface StreamOptions {
  url: string;
  token: string;
  onEvent: (event: StreamEvent) => void;
  onState: (state: ConnectionState) => void;
  /** Called on 401 so the app can sign the user out. */
  onUnauthorized: () => void;
  /**
   * Called when the stream is live again after a drop or a failed attempt (not on
   * the first connect). The server does not replay events sent while the client
   * was away, so anything shown from the stream should be re-fetched.
   */
  onReconnect?: () => void;
  fetchImpl?: typeof fetch;
}

/**
 * Server-sent events over fetch() so the bearer token goes in a header, not the
 * URL (EventSource cannot set headers). Reconnects with capped backoff.
 * Returns a function that closes the stream.
 */
export function openEventStream(opts: StreamOptions): () => void {
  const controller = new AbortController();
  const fetchImpl = opts.fetchImpl ?? fetch;
  let attempt = 0;

  const run = async () => {
    while (!controller.signal.aborted) {
      opts.onState(attempt === 0 ? 'connecting' : 'reconnecting');
      try {
        const res = await fetchImpl(opts.url, {
          headers: { Authorization: `Bearer ${opts.token}`, Accept: 'text/event-stream' },
          signal: controller.signal,
          cache: 'no-store',
        });
        if (res.status === 401) {
          opts.onUnauthorized();
          return;
        }
        if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
        opts.onState('live');
        if (attempt > 0) opts.onReconnect?.();
        attempt = 0;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        const parser = new SseParser();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const frame of parser.push(value)) {
            try {
              opts.onEvent(JSON.parse(frame.data) as StreamEvent);
            } catch {
              // ignore malformed frames
            }
          }
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      attempt += 1;
      opts.onState('reconnecting');
      await new Promise((r) => setTimeout(r, Math.min(15_000, 1_000 * 2 ** attempt)));
    }
  };
  void run();
  return () => controller.abort();
}
