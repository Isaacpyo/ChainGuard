import type { StreamEvent } from '@chainguard/shared';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Db } from '../../src/db/pool';
import { createRepos } from '../../src/db/repos';
import { registerVaults } from '../../src/db/seed';
import { silentLogger } from '../../src/logger';
import { Broadcaster } from '../../src/services/broadcaster';
import { createIngestHandler } from '../../src/services/ingest';
import type { AlertPayload } from '../../src/streams/events';
import { StreamConsumer, StreamPublisher } from '../../src/streams/redis-stream';
import { ATTACKER, OPS, VAULT, txHash } from '../fixtures';
import { REDIS_URL, describeInfra, isolatedDb, uniqueKey } from './helpers';

describeInfra('Redis Stream → Postgres pipeline', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let redis: Redis;
  let consumer: StreamConsumer;
  let publisher: StreamPublisher;
  const key = uniqueKey('test:events');
  const broadcaster = new Broadcaster();
  const seen: StreamEvent[] = [];
  let simulationId: string | null = null;

  beforeAll(async () => {
    ({ db, drop } = await isolatedDb());
    redis = new Redis(REDIS_URL!);
    await registerVaults(db, [
      {
        slug: 's',
        name: 'S',
        network: 'sandbox',
        chainId: 31337,
        address: VAULT,
        knownCallers: [OPS],
      },
    ]);
    publisher = new StreamPublisher(redis, key, 1_000);
    consumer = new StreamConsumer(
      redis.duplicate(),
      { key, group: 'api', consumer: 'test', blockMs: 100 },
      createIngestHandler({
        repos: createRepos(db),
        broadcaster,
        simulations: { activeFor: (n) => (n === 'sandbox' ? simulationId : null) },
        log: silentLogger,
      }),
      silentLogger,
    );
    await consumer.ensureGroup();
    broadcaster.subscribe((e) => seen.push(e));
  });

  afterAll(async () => {
    await consumer?.stop();
    await redis?.del(key, `${key}:dead`);
    await redis?.quit();
    await drop?.();
  });

  const alert = (overrides: Partial<AlertPayload> = {}): AlertPayload => ({
    id: randomUUID(),
    network: 'sandbox',
    chainId: 31337,
    vaultAddress: VAULT.toUpperCase().replace('0X', '0x'), // casing must not matter
    txHash: txHash(),
    stage: 'pending',
    from: ATTACKER,
    functionName: 'withdraw',
    args: { to: ATTACKER, amount: '10' },
    valueWei: '0',
    score: 75,
    severity: 'high',
    rules: [{ id: 'unknown-caller', label: 'Unknown caller', weight: 35, reason: 'r' }],
    detectedAt: new Date().toISOString(),
    ...overrides,
  });

  const pending = async () => ((await redis.xpending(key, 'api')) as [number])[0];

  it('persists alerts once, links them to the vault and broadcasts them', async () => {
    const a = alert();
    await publisher.publish({ type: 'alert', alert: a });
    await publisher.publish({ type: 'alert', alert: a }); // redelivery / duplicate publish
    expect(await consumer.pollOnce(100)).toBe(2);

    const { rows } = await db.query('SELECT vault_id, score, stream_id FROM alerts WHERE id = $1', [
      a.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].vault_id).toBeTruthy();
    expect(rows[0].stream_id).toMatch(/^\d+-\d+$/);
    expect(seen.filter((e) => e.type === 'alert')).toHaveLength(1);
    expect(await pending()).toBe(0);
  });

  it('applies guardian responses to the stored alert', async () => {
    const a = alert();
    const pauseHash = txHash();
    await publisher.publish({ type: 'alert', alert: a });
    await publisher.publish({
      type: 'alert.response',
      alertId: a.id,
      action: 'pause_confirmed',
      txHash: pauseHash,
      error: null,
      at: new Date().toISOString(),
    });
    await consumer.pollOnce(100);
    const { rows } = await db.query('SELECT response, response_tx_hash FROM alerts WHERE id = $1', [
      a.id,
    ]);
    expect(rows[0]).toEqual({ response: 'pause_confirmed', response_tx_hash: pauseHash });
    expect(seen.at(-1)).toMatchObject({
      type: 'alert.updated',
      alert: { id: a.id, response: 'pause_confirmed' },
    });
  });

  it('tags alerts raised during a simulation', async () => {
    const sim = await createRepos(db).simulations.create(null);
    simulationId = sim.id;
    const a = alert();
    await publisher.publish({ type: 'alert', alert: a });
    await consumer.pollOnce(100);
    simulationId = null;
    const { rows } = await db.query('SELECT simulation_id FROM alerts WHERE id = $1', [a.id]);
    expect(rows[0].simulation_id).toBe(sim.id);
  });

  it('dead-letters invalid messages instead of blocking the group', async () => {
    await redis.xadd(
      key,
      '*',
      'type',
      'alert',
      'payload',
      JSON.stringify({ type: 'alert', alert: { id: 'x' } }),
    );
    await consumer.pollOnce(100);
    expect(await pending()).toBe(0);
    const dead = await redis.xrange(`${key}:dead`, '-', '+');
    expect(dead).toHaveLength(1);
  });

  it('leaves messages pending when persistence fails, for redelivery', async () => {
    const failing = new StreamConsumer(
      redis.duplicate(),
      { key, group: 'api', consumer: 'flaky', blockMs: 100 },
      async () => {
        throw new Error('db down');
      },
      silentLogger,
    );
    await publisher.publish({ type: 'alert', alert: alert() });
    await expect(failing.pollOnce(100)).rejects.toThrow('db down');
    expect(await pending()).toBe(1);
    await failing.stop();
  });
});
