import type { SimulationDto } from '@chainguard/shared';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type { Sandbox } from '../src/chain/sandbox';
import type { Repos } from '../src/db/repos';
import type { Logger } from '../src/logger';
import { Broadcaster } from '../src/services/broadcaster';
import { SimulationRunner } from '../src/services/simulation';
import { encodeEvent, type ChainGuardEvent } from '../src/streams/events';
import { StreamConsumer } from '../src/streams/redis-stream';
import { VAULT } from './fixtures';

/**
 * Work that runs in the background with nobody awaiting it: an error must be logged and
 * survived, never left as an unhandled rejection (which ends a Node 22 process).
 */

const spyLogger = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() });

describe('SimulationRunner', () => {
  it('logs a run whose failure cannot even be recorded', async () => {
    const log = spyLogger();
    const sim: SimulationDto = {
      id: randomUUID(),
      status: 'running',
      result: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    const runner = new SimulationRunner({
      sandbox: {
        accounts: {},
        vaultAddress: VAULT,
        reset: async () => {
          throw new Error('sandbox RPC not reachable');
        },
      } as unknown as Sandbox,
      repos: {
        simulations: {
          create: async () => sim,
          finish: async () => {
            throw new Error('Connection terminated unexpectedly');
          },
        },
      } as unknown as Repos,
      broadcaster: new Broadcaster(),
      log: log as unknown as Logger,
    });

    await runner.start(null); // like POST /simulations: the run itself is not awaited
    await vi.waitFor(() => expect(runner.running).toBe(false));
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ id: sim.id }),
      'could not record the simulation outcome',
    );
    await expect(runner.waitForCompletion()).resolves.toBeNull();
  });
});

/** Just enough of ioredis for StreamConsumer; XREADGROUP '>' blocks until a push. */
class FakeRedis {
  failReads = 0;
  acked: string[] = [];
  #queue: [string, string[]][] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  push(id: string, event: ChainGuardEvent): void {
    this.#queue.push([id, encodeEvent(event)]);
    this.#wake?.();
  }

  async xgroup() {
    return 'OK';
  }
  async xreadgroup(...args: unknown[]) {
    if (this.failReads > 0) {
      this.failReads -= 1;
      throw new Error('read ECONNRESET');
    }
    if (args.at(-1) !== '>') return null; // replay of our own pending messages: none
    while (!this.#queue.length && !this.#closed) {
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
    const entries = this.#queue.splice(0);
    return entries.length ? [['events', entries]] : null;
  }
  async xautoclaim() {
    return ['0-0', []];
  }
  async xack(_key: string, _group: string, id: string) {
    this.acked.push(id);
    return 1;
  }
  disconnect(): void {
    this.#closed = true;
    this.#wake?.();
  }
}

describe('StreamConsumer', () => {
  it('keeps consuming when replaying pending messages fails at startup', async () => {
    const redis = new FakeRedis();
    redis.failReads = 1; // the startup replay of our own pending messages
    const log = spyLogger();
    const handled: ChainGuardEvent[] = [];
    const consumer = new StreamConsumer(
      redis as unknown as Redis,
      { key: 'events', group: 'api', consumer: 'test', blockMs: 100 },
      async (event) => {
        handled.push(event);
      },
      log as unknown as Logger,
    );
    await consumer.start();

    const event: ChainGuardEvent = {
      type: 'alert.response',
      alertId: randomUUID(),
      action: 'pause_confirmed',
      txHash: null,
      error: null,
      at: new Date().toISOString(),
    };
    redis.push('1-0', event);
    await vi.waitFor(() => expect(handled).toEqual([event]));
    expect(redis.acked).toEqual(['1-0']);
    expect(log.error).toHaveBeenCalledTimes(1);
    await consumer.stop();
  });
});
