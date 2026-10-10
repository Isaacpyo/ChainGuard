import { hostname } from 'node:os';
import type { Redis } from 'ioredis';
import type { Logger } from '../logger';
import type { EventPublisher } from '../watcher/watcher';
import { decodeEvent, encodeEvent, type ChainGuardEvent } from './events';

/** XADD with approximate trimming so the stream stays inside free-tier memory. */
export class StreamPublisher implements EventPublisher {
  constructor(
    private readonly redis: Redis,
    private readonly key: string,
    private readonly maxLen: number,
  ) {}

  async publish(event: ChainGuardEvent): Promise<string> {
    const id = await this.redis.xadd(
      this.key,
      'MAXLEN',
      '~',
      this.maxLen,
      '*',
      ...encodeEvent(event),
    );
    if (!id) throw new Error('XADD returned no id');
    return id;
  }
}

export type EventHandler = (event: ChainGuardEvent, streamId: string) => Promise<void>;

type StreamEntries = [id: string, fields: string[]][];

export interface ConsumerOptions {
  key: string;
  group: string;
  consumer?: string;
  blockMs: number;
  /** Messages pending longer than this on a dead consumer are claimed. */
  claimIdleMs?: number;
  batch?: number;
}

/**
 * Consumer-group reader with at-least-once delivery: a message is acked only after
 * the handler succeeds, crashed consumers' messages are reclaimed with XAUTOCLAIM,
 * and invalid messages go to a dead-letter stream instead of blocking the group.
 * Uses its own connection because XREADGROUP BLOCK monopolises it.
 */
export class StreamConsumer {
  readonly #o: Required<ConsumerOptions>;
  #running = false;
  #loop: Promise<void> | null = null;

  constructor(
    private readonly redis: Redis,
    options: ConsumerOptions,
    private readonly handler: EventHandler,
    private readonly log: Logger,
  ) {
    this.#o = {
      consumer: `${hostname()}-${process.pid}`,
      claimIdleMs: 60_000,
      batch: 50,
      ...options,
    };
  }

  get deadLetterKey(): string {
    return `${this.#o.key}:dead`;
  }

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.#o.key, this.#o.group, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('BUSYGROUP'))) throw err;
    }
  }

  async start(): Promise<void> {
    await this.ensureGroup();
    this.#running = true;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#running = false;
    // Unblock a pending XREADGROUP so the loop can exit.
    this.redis.disconnect();
    await this.#loop?.catch(() => undefined);
  }

  async #run(): Promise<void> {
    // Our own un-acked messages from a previous run first, then reclaimed ones.
    await this.#drain('0');
    let lastClaim = 0;
    while (this.#running) {
      try {
        if (Date.now() - lastClaim > this.#o.claimIdleMs) {
          await this.#claimStale();
          lastClaim = Date.now();
        }
        await this.pollOnce(this.#o.blockMs);
      } catch (err) {
        if (!this.#running) break;
        this.log.error({ err }, 'stream consumer error; retrying');
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }

  /** One XREADGROUP for new messages. Exposed for tests. */
  async pollOnce(blockMs: number): Promise<number> {
    const res = (await this.redis.xreadgroup(
      'GROUP',
      this.#o.group,
      this.#o.consumer,
      'COUNT',
      this.#o.batch,
      'BLOCK',
      blockMs,
      'STREAMS',
      this.#o.key,
      '>',
    )) as [string, StreamEntries][] | null;
    const entries = res?.[0]?.[1] ?? [];
    await this.#process(entries);
    return entries.length;
  }

  async #drain(fromId: string): Promise<void> {
    const res = (await this.redis.xreadgroup(
      'GROUP',
      this.#o.group,
      this.#o.consumer,
      'COUNT',
      this.#o.batch,
      'STREAMS',
      this.#o.key,
      fromId,
    )) as [string, StreamEntries][] | null;
    await this.#process(res?.[0]?.[1] ?? []);
  }

  async #claimStale(): Promise<void> {
    const res = (await this.redis.xautoclaim(
      this.#o.key,
      this.#o.group,
      this.#o.consumer,
      this.#o.claimIdleMs,
      '0-0',
      'COUNT',
      this.#o.batch,
    )) as [string, StreamEntries, string[]?];
    const entries = (res[1] ?? []).filter((e): e is [string, string[]] => Array.isArray(e?.[1]));
    if (entries.length) this.log.warn({ count: entries.length }, 'reclaimed stale stream messages');
    await this.#process(entries);
  }

  async #process(entries: StreamEntries): Promise<void> {
    for (const [id, fields] of entries) {
      let event: ChainGuardEvent;
      try {
        event = decodeEvent(fields);
      } catch (err) {
        this.log.error({ err, id }, 'invalid stream message; dead-lettering');
        await this.redis.xadd(
          this.deadLetterKey,
          'MAXLEN',
          '~',
          1_000,
          '*',
          'sourceId',
          id,
          ...fields,
        );
        await this.redis.xack(this.#o.key, this.#o.group, id);
        continue;
      }
      // Throws on failure → not acked → redelivered via XAUTOCLAIM.
      await this.handler(event, id);
      await this.redis.xack(this.#o.key, this.#o.group, id);
    }
  }
}
