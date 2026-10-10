import type { Network } from '@chainguard/shared';
import { randomUUID } from 'node:crypto';
import { isAddressEqual, type Address, type Hex } from 'viem';
import type { VaultStateReader, VaultChainState } from '../chain/vault';
import type { Logger } from '../logger';
import type { AlertPayload, ChainGuardEvent, ResponseEvent } from '../streams/events';
import { decodeVaultCall } from './decoder';
import type { Guardian } from './guardian';
import { BoundedSet, SenderHistory } from './history';
import { scoreTransaction, type RulesConfig } from './rules';
import type { PendingTx, PendingTxSource } from './sources';

export interface WatchTarget {
  network: Network;
  chainId: number;
  vaultAddress: Address;
  knownCallers: readonly Address[];
}

export interface EventPublisher {
  publish(event: ChainGuardEvent): Promise<string>;
}

export interface WatcherDeps {
  target: WatchTarget;
  source: PendingTxSource;
  state: VaultStateReader;
  publisher: EventPublisher;
  /** Without a guardian the watcher only alerts. */
  guardian?: Guardian | undefined;
  rules: RulesConfig;
  log: Logger;
  now?: () => number;
}

type PauseOutcome =
  | { kind: 'submitted'; hash: Hex }
  | { kind: 'already_paused'; hash: Hex | null }
  | { kind: 'failed'; error: string };

/**
 * Mempool watcher for one vault: decode → score → publish an alert → if the score
 * crosses the threshold, front-run the transaction with the guardian's pause().
 */
export class Watcher {
  readonly #d: WatcherDeps;
  readonly #now: () => number;
  readonly #history: SenderHistory;
  readonly #seen = new BoundedSet(10_000);
  readonly #known: Set<string>;
  #pauseInFlight: { hash: Hex | null } | null = null;
  #pending = new Set<Promise<void>>();

  constructor(deps: WatcherDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
    this.#history = new SenderHistory(deps.rules.rapidRepeatWindowSec);
    this.#known = new Set(deps.target.knownCallers.map((a) => a.toLowerCase()));
  }

  get target(): WatchTarget {
    return this.#d.target;
  }

  async start(): Promise<void> {
    await this.#d.source.start((tx, stage) => {
      const p: Promise<void> = this.handle(tx, stage)
        .then(
          () => undefined,
          (err: unknown) => this.#d.log.error({ err, hash: tx.hash }, 'failed to process tx'),
        )
        .finally(() => this.#pending.delete(p));
      this.#pending.add(p);
    });
    this.#d.log.info(
      {
        network: this.#d.target.network,
        vault: this.#d.target.vaultAddress,
        source: this.#d.source.name,
      },
      'watcher started',
    );
  }

  async stop(): Promise<void> {
    await this.#d.source.stop();
    await Promise.allSettled([...this.#pending]);
  }

  /** Forget per-sender history and seen hashes (the sandbox chain was reset). */
  reset(): void {
    this.#history.reset();
    this.#seen.clear();
    this.#pauseInFlight = null;
  }

  /** Resolves when every in-flight transaction has been processed. For tests. */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  async handle(tx: PendingTx, stage: 'pending' | 'mined'): Promise<AlertPayload | null> {
    const { target, rules, publisher } = this.#d;
    if (!tx.to || !isAddressEqual(tx.to, target.vaultAddress)) return null;
    // A transaction we already scored while pending shows up again when mined.
    if (!this.#seen.add(tx.hash)) return null;

    const decoded = decodeVaultCall(tx.input, tx.value);
    const now = this.#now();
    const stateChanging = decoded.call.kind !== 'deposit';
    const recent = stateChanging ? this.#history.record(tx.from, now) : 0;
    const vault = await this.#readState();

    const result = scoreTransaction({
      from: tx.from,
      decoded,
      vault,
      knownCallers: this.#known,
      recentCallsFromSender: recent,
      config: rules,
    });

    // Fire the pause before publishing: the Redis round-trip should not delay it.
    const pause = result.shouldPause && this.#d.guardian ? this.#submitPause(tx, vault) : null;

    const alert: AlertPayload = {
      id: randomUUID(),
      network: target.network,
      chainId: target.chainId,
      vaultAddress: target.vaultAddress,
      txHash: tx.hash,
      stage,
      from: tx.from,
      functionName: decoded.functionName,
      args: decoded.args,
      valueWei: tx.value.toString(),
      score: result.score,
      severity: result.severity,
      rules: result.rules,
      detectedAt: new Date(now).toISOString(),
    };
    await publisher.publish({ type: 'alert', alert });
    this.#d.log.info(
      { hash: tx.hash, fn: decoded.functionName, score: result.score, stage },
      result.score > 0 ? 'suspicious transaction' : 'vault transaction',
    );

    if (pause) await this.#reportPause(alert.id, pause);
    return alert;
  }

  async #readState(): Promise<VaultChainState | null> {
    try {
      return await this.#d.state.read();
    } catch (err) {
      this.#d.log.warn({ err }, 'could not read vault state; scoring without it');
      return null;
    }
  }

  /** Synchronously claims the in-flight slot so concurrent alerts send one pause(). */
  #submitPause(tx: PendingTx, vault: VaultChainState | null): Promise<PauseOutcome> {
    if (vault?.paused) return Promise.resolve({ kind: 'already_paused', hash: null });
    if (this.#pauseInFlight) {
      return Promise.resolve({ kind: 'already_paused', hash: this.#pauseInFlight.hash });
    }
    const guardian = this.#d.guardian!;
    const slot: { hash: Hex | null } = { hash: null };
    this.#pauseInFlight = slot;

    return guardian
      .pause(this.#d.target.vaultAddress, tx)
      .then((hash): PauseOutcome => {
        slot.hash = hash;
        this.#d.log.warn({ hash, trigger: tx.hash }, 'guardian pause submitted');
        return { kind: 'submitted', hash };
      })
      .catch((err: unknown): PauseOutcome => {
        this.#pauseInFlight = null;
        return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
      });
  }

  async #reportPause(alertId: string, pending: Promise<PauseOutcome>): Promise<void> {
    const outcome = await pending;
    const emit = (
      action: ResponseEvent['action'],
      txHash: Hex | null,
      error: string | null = null,
    ) =>
      this.#d.publisher.publish({
        type: 'alert.response',
        alertId,
        action,
        txHash,
        error: error?.slice(0, 500) ?? null,
        at: new Date(this.#now()).toISOString(),
      });

    if (outcome.kind === 'already_paused') {
      await emit('already_paused', outcome.hash);
      return;
    }
    if (outcome.kind === 'failed') {
      this.#d.log.error({ error: outcome.error }, 'guardian pause failed');
      await emit('pause_failed', null, outcome.error);
      return;
    }

    await emit('pause_submitted', outcome.hash);
    try {
      const status = await this.#d.guardian!.waitForReceipt(outcome.hash);
      this.#d.state.invalidate?.();
      await emit(status === 'success' ? 'pause_confirmed' : 'pause_failed', outcome.hash);
    } catch (err) {
      await emit('pause_failed', outcome.hash, err instanceof Error ? err.message : String(err));
    } finally {
      this.#pauseInFlight = null;
    }
  }
}
