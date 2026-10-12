import { formatEther } from 'viem';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AnvilProcess } from '../../src/chain/anvil-process';
import { Sandbox, SANDBOX_CHAIN_ID } from '../../src/chain/sandbox';
import { CachedVaultReader, ChainVaultReader } from '../../src/chain/vault';
import type { Db } from '../../src/db/pool';
import { createRepos } from '../../src/db/repos';
import { registerVaults } from '../../src/db/seed';
import { silentLogger } from '../../src/logger';
import { Broadcaster } from '../../src/services/broadcaster';
import { createIngestHandler } from '../../src/services/ingest';
import { SimulationRunner } from '../../src/services/simulation';
import { StreamConsumer, StreamPublisher } from '../../src/streams/redis-stream';
import { ViemGuardian } from '../../src/watcher/guardian';
import { RpcPendingSource } from '../../src/watcher/sources';
import { Watcher } from '../../src/watcher/watcher';
import { RULES_CONFIG } from '../fixtures';
import { ANVIL_PATH, REDIS_URL, describeChain, isolatedDb, uniqueKey } from './helpers';

/**
 * The whole system end to end on a real chain: anvil mempool → watcher → Redis
 * Stream → consumer → Postgres, with the guardian racing a real drain attack.
 */
describeChain('attack simulation on anvil', () => {
  const port = 8_600 + Math.floor(Math.random() * 300);
  const rpcUrl = `http://127.0.0.1:${port}`;
  let anvil: AnvilProcess;
  let db: Db;
  let drop: () => Promise<void>;
  let redis: Redis;
  let watcher: Watcher;
  let consumer: StreamConsumer;
  let runner: SimulationRunner;
  const key = uniqueKey('test:sim');

  beforeAll(async () => {
    anvil = new AnvilProcess({ binary: ANVIL_PATH, rpcUrl, blockTime: 1 }, silentLogger);
    anvil.start();
    const sandbox = new Sandbox(
      { rpcUrl, mnemonic: 'test test test test test test test test test test test junk' },
      silentLogger,
    );
    await sandbox.waitUntilReady();

    ({ db, drop } = await isolatedDb());
    await registerVaults(db, [
      {
        slug: 'sandbox-treasury',
        name: 'Sandbox Treasury',
        network: 'sandbox',
        chainId: SANDBOX_CHAIN_ID,
        address: sandbox.vaultAddress,
        knownCallers: sandbox.knownCallers,
      },
    ]);
    redis = new Redis(REDIS_URL!);
    const repos = createRepos(db);
    const broadcaster = new Broadcaster();
    const reader = new CachedVaultReader(
      new ChainVaultReader(sandbox.client, sandbox.vaultAddress),
      500,
    );

    watcher = new Watcher({
      target: {
        network: 'sandbox',
        chainId: SANDBOX_CHAIN_ID,
        vaultAddress: sandbox.vaultAddress,
        knownCallers: sandbox.knownCallers,
      },
      source: new RpcPendingSource(
        rpcUrl.replace('http', 'ws'),
        () => [sandbox.vaultAddress],
        silentLogger,
      ),
      state: reader,
      publisher: new StreamPublisher(redis, key, 1_000),
      guardian: new ViemGuardian(sandbox.wallet(sandbox.accounts.guardian), sandbox.client),
      rules: RULES_CONFIG,
      log: silentLogger,
    });
    await watcher.start();

    runner = new SimulationRunner({
      sandbox,
      repos,
      broadcaster,
      log: silentLogger,
      onReset: () => {
        watcher.reset();
        reader.invalidate();
      },
    });
    consumer = new StreamConsumer(
      redis.duplicate(),
      { key, group: 'api', blockMs: 500 },
      createIngestHandler({ repos, broadcaster, simulations: runner, log: silentLogger }),
      silentLogger,
    );
    await consumer.start();
  });

  afterAll(async () => {
    await watcher?.stop();
    await consumer?.stop();
    await redis?.del(key);
    await redis?.quit();
    await anvil?.stop();
    await drop?.();
  });

  it('detects the drain in the mempool and pauses the vault before it lands', async () => {
    const started = await runner.start(null);
    expect(started.status).toBe('running');
    await expect(runner.start(null)).rejects.toThrow(/already running/);

    const sim = await runner.waitForCompletion();
    expect(sim?.error).toBeNull();
    expect(sim?.status).toBe('succeeded');
    const result = sim!.result!;

    expect(result.paused).toBe(true);
    expect(result.pauseTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    // Defence in depth: whatever the race outcome, losses never exceed the rate-limit capacity.
    expect(BigInt(result.stolenWei)).toBeLessThanOrEqual(BigInt(result.rateLimitCapWei));
    // The headline claim: the guardian front-ran the whole burst.
    expect(formatEther(BigInt(result.stolenWei))).toBe('0');
    expect(result.transactions.filter((t) => t.label.startsWith('Attack'))).toHaveLength(5);

    // Give the consumer a moment to persist the trailing response events.
    await new Promise((r) => setTimeout(r, 1_000));
    const { rows } = await db.query<{
      severity: string;
      response: string;
      simulation_id: string | null;
    }>('SELECT severity, response, simulation_id FROM alerts ORDER BY detected_at');
    expect(rows.length).toBeGreaterThanOrEqual(7); // deposit, ops withdrawal, 5 attack txs
    expect(rows.every((r) => r.simulation_id === sim!.id)).toBe(true);
    expect(rows.some((r) => r.response === 'pause_confirmed')).toBe(true);
    expect(rows.filter((r) => r.severity === 'high' || r.severity === 'critical')).toHaveLength(5);
  });

  it('can run again from a clean chain', async () => {
    await runner.start(null);
    const sim = await runner.waitForCompletion();
    expect(sim?.status).toBe('succeeded');
    expect(sim?.result?.paused).toBe(true);
  });
});
