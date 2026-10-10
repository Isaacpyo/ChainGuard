import type { Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { MockVaultReader, type VaultChainState, type VaultStateReader } from '../src/chain/vault';
import { silentLogger } from '../src/logger';
import type { ChainGuardEvent } from '../src/streams/events';
import { MockGuardian, type Guardian } from '../src/watcher/guardian';
import { MockPendingSource } from '../src/watcher/sources';
import { Watcher, type EventPublisher } from '../src/watcher/watcher';
import {
  ADMIN,
  ATTACKER,
  OPS,
  RULES_CONFIG,
  VAULT,
  depositTx,
  vaultState,
  withdrawTx,
} from './fixtures';

class MemoryPublisher implements EventPublisher {
  events: ChainGuardEvent[] = [];
  async publish(event: ChainGuardEvent): Promise<string> {
    this.events.push(event);
    return `${this.events.length}-0`;
  }
  alerts() {
    return this.events.flatMap((e) => (e.type === 'alert' ? [e.alert] : []));
  }
  responses() {
    return this.events.flatMap((e) => (e.type === 'alert.response' ? [e] : []));
  }
}

class StubState implements VaultStateReader {
  constructor(public state: VaultChainState | null = vaultState()) {}
  async read() {
    return this.state;
  }
}

function setup(opts: { guardian?: Guardian; state?: VaultStateReader } = {}) {
  const source = new MockPendingSource();
  const publisher = new MemoryPublisher();
  const guardian = opts.guardian ?? new MockGuardian();
  let now = 1_000_000;
  const watcher = new Watcher({
    target: { network: 'sandbox', chainId: 31337, vaultAddress: VAULT, knownCallers: [OPS, ADMIN] },
    source,
    state: opts.state ?? new StubState(),
    publisher,
    guardian,
    rules: RULES_CONFIG,
    log: silentLogger,
    now: () => (now += 10),
  });
  return { source, publisher, guardian, watcher };
}

describe('Watcher', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(async () => {
    ctx = setup();
    await ctx.watcher.start();
  });

  it('publishes an info alert for routine activity and does not pause', async () => {
    ctx.source.push(withdrawTx(OPS, '1'));
    ctx.source.push(depositTx(ATTACKER, '5'));
    await ctx.watcher.idle();

    const alerts = ctx.publisher.alerts();
    expect(alerts.map((a) => [a.functionName, a.severity])).toEqual([
      ['withdraw', 'info'],
      ['deposit', 'info'],
    ]);
    expect(alerts[0]).toMatchObject({
      network: 'sandbox',
      vaultAddress: VAULT,
      stage: 'pending',
      score: 0,
    });
    expect((ctx.guardian as MockGuardian).calls).toHaveLength(0);
  });

  it('ignores transactions to other contracts', async () => {
    ctx.source.push({ ...withdrawTx(ATTACKER, '50'), to: OPS });
    await ctx.watcher.idle();
    expect(ctx.publisher.events).toHaveLength(0);
  });

  it('pauses once for a burst of drain transactions and reports the response', async () => {
    const burst = Array.from({ length: 5 }, () => withdrawTx(ATTACKER, '10'));
    for (const tx of burst) ctx.source.push(tx);
    await ctx.watcher.idle();

    const guardian = ctx.guardian as MockGuardian;
    expect(guardian.calls).toHaveLength(1);
    expect(guardian.calls[0]!.vault).toBe(VAULT);
    expect(guardian.calls[0]!.target.maxPriorityFeePerGas).toBe(1_000_000_000n);

    const alerts = ctx.publisher.alerts();
    expect(alerts).toHaveLength(5);
    expect(alerts[0]).toMatchObject({ score: 75, severity: 'high' });
    // Later transactions in the burst also trip the rapid-repeat rule.
    expect(alerts[4]!.rules.map((r) => r.id)).toContain('rapid-repeats');
    expect(alerts[4]!.severity).toBe('critical');

    const responses = ctx.publisher.responses();
    const first = responses.filter((r) => r.alertId === alerts[0]!.id);
    expect(first.map((r) => r.action)).toEqual(['pause_submitted', 'pause_confirmed']);
    expect(responses.filter((r) => r.action === 'already_paused')).toHaveLength(4);

    // Every response follows the alert it refers to.
    const order = ctx.publisher.events.map((e) =>
      e.type === 'alert' ? e.alert.id : `r:${e.alertId}`,
    );
    for (const r of responses)
      expect(order.indexOf(`r:${r.alertId}`)).toBeGreaterThan(order.indexOf(r.alertId));
  });

  it('does not send pause() when the vault is already paused', async () => {
    const paused = setup({ state: new StubState(vaultState({ paused: true })) });
    await paused.watcher.start();
    paused.source.push(withdrawTx(ATTACKER, '10'));
    await paused.watcher.idle();
    expect((paused.guardian as MockGuardian).calls).toHaveLength(0);
    expect(paused.publisher.responses().map((r) => r.action)).toEqual(['already_paused']);
  });

  it('deduplicates a transaction seen pending and again when mined', async () => {
    const tx = withdrawTx(OPS, '1');
    ctx.source.push(tx, 'pending');
    await ctx.watcher.idle();
    ctx.source.push(tx, 'mined');
    await ctx.watcher.idle();
    expect(ctx.publisher.alerts()).toHaveLength(1);
  });

  it('scores transactions first seen in a block (private orderflow)', async () => {
    ctx.source.push(withdrawTx(ATTACKER, '10'), 'mined');
    await ctx.watcher.idle();
    expect(ctx.publisher.alerts()[0]).toMatchObject({ stage: 'mined', score: 75 });
    expect((ctx.guardian as MockGuardian).calls).toHaveLength(1);
  });

  it('reports a failed pause and allows a retry on the next suspicious tx', async () => {
    let attempts = 0;
    const flaky: Guardian = {
      address: ADMIN,
      async pause(): Promise<Hex> {
        attempts += 1;
        if (attempts === 1) throw new Error('nonce too low');
        return `0x${'1'.repeat(64)}`;
      },
      async waitForReceipt() {
        return 'success';
      },
    };
    const f = setup({ guardian: flaky });
    await f.watcher.start();
    f.source.push(withdrawTx(ATTACKER, '10'));
    await f.watcher.idle();
    f.source.push(withdrawTx(ATTACKER, '10'));
    await f.watcher.idle();
    expect(f.publisher.responses().map((r) => [r.action, r.error])).toEqual([
      ['pause_failed', 'nonce too low'],
      ['pause_submitted', null],
      ['pause_confirmed', null],
    ]);
  });

  it('keeps alerting without vault state', async () => {
    const blind = setup({
      state: {
        read: async () => {
          throw new Error('rpc down');
        },
      },
    });
    await blind.watcher.start();
    blind.source.push(withdrawTx(ATTACKER, '10'));
    await blind.watcher.idle();
    expect(blind.publisher.alerts()[0]!.rules.map((r) => r.id)).toEqual(['unknown-caller']);
  });

  it('forgets sender history after reset()', async () => {
    for (let i = 0; i < 3; i++) ctx.source.push(withdrawTx(ATTACKER, '1'));
    await ctx.watcher.idle();
    expect(ctx.publisher.alerts()[2]!.rules.map((r) => r.id)).toContain('rapid-repeats');
    ctx.watcher.reset();
    ctx.source.push(withdrawTx(ATTACKER, '1'));
    await ctx.watcher.idle();
    expect(ctx.publisher.alerts()[3]!.rules.map((r) => r.id)).not.toContain('rapid-repeats');
  });

  it('drives the mock vault into a paused state (LIVE_PROVIDER=mock wiring)', async () => {
    const reader = new MockVaultReader();
    const m = setup({ state: reader, guardian: new MockGuardian(reader) });
    await m.watcher.start();
    m.source.push(withdrawTx(ATTACKER, '30'));
    await m.watcher.idle();
    expect((await reader.read()).paused).toBe(true);
  });
});
