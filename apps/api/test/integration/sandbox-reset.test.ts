import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { silentLogger } from '../../src/logger';
import type { ChainGuardEvent } from '../../src/streams/events';
import { announceSandboxReset, onSandboxReset } from '../../src/streams/sandbox-reset';
import { MockGuardian } from '../../src/watcher/guardian';
import { MockPendingSource } from '../../src/watcher/sources';
import { Watcher } from '../../src/watcher/watcher';
import { ADMIN, ATTACKER, OPS, RULES_CONFIG, VAULT, vaultState, withdrawTx } from '../fixtures';
import { REDIS_URL, describeInfra, uniqueKey } from './helpers';

/** ROLE=api resets the sandbox chain; a ROLE=watcher process has to hear about it. */
describeInfra('sandbox reset across processes', () => {
  let apiRedis: Redis;
  let watcherRedis: Redis;
  let close: () => Promise<void>;
  const channel = uniqueKey('test:sandbox-reset');
  const source = new MockPendingSource();
  const events: ChainGuardEvent[] = [];
  const watcher = new Watcher({
    target: { network: 'sandbox', chainId: 31337, vaultAddress: VAULT, knownCallers: [OPS, ADMIN] },
    source,
    state: { read: async () => vaultState() },
    publisher: {
      publish: async (e) => {
        events.push(e);
        return `${events.length}-0`;
      },
    },
    guardian: new MockGuardian(),
    rules: RULES_CONFIG,
    log: silentLogger,
  });
  const alerts = () => events.filter((e) => e.type === 'alert');

  beforeAll(async () => {
    apiRedis = new Redis(REDIS_URL!);
    watcherRedis = new Redis(REDIS_URL!);
    close = await onSandboxReset(watcherRedis, channel, () => watcher.reset(), silentLogger);
    await watcher.start();
  });

  afterAll(async () => {
    await watcher.stop();
    await close?.();
    await apiRedis?.quit();
    await watcherRedis?.quit();
  });

  it('lets the rerun attack, with the same tx hash, be scored again', async () => {
    // anvil_reset + the same keys and nonces = the same signed transaction as last run.
    const attack = withdrawTx(ATTACKER, '10');
    source.push(attack);
    await watcher.idle();
    source.push(attack);
    await watcher.idle();
    expect(alerts()).toHaveLength(1); // a duplicate on the same chain

    await announceSandboxReset(apiRedis, channel);
    await vi.waitFor(async () => {
      source.push(attack);
      await watcher.idle();
      expect(alerts()).toHaveLength(2);
    });
    expect(
      events.filter((e) => e.type === 'alert.response' && e.action === 'pause_submitted'),
    ).toHaveLength(2);
  });
});
