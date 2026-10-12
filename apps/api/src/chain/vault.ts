import { guardedVaultAbi } from '@chainguard/shared/abi';
import type { VaultStateDto } from '@chainguard/shared';
import { BaseError, ContractFunctionZeroDataError, type Address, type PublicClient } from 'viem';

export interface VaultChainState {
  balance: bigint;
  available: bigint;
  limit: bigint;
  windowSeconds: bigint;
  timelockDelaySeconds: bigint;
  paused: boolean;
  blockNumber: bigint;
}

/** Reads on-chain vault state; null when there is no contract at the address. */
export interface VaultStateReader {
  read(): Promise<VaultChainState | null>;
  /** Drop any cached state (after a known state change). */
  invalidate?(): void;
}

export class ChainVaultReader implements VaultStateReader {
  constructor(
    private readonly client: PublicClient,
    private readonly address: Address,
  ) {}

  async read(): Promise<VaultChainState | null> {
    const blockNumber = await this.client.getBlockNumber({ cacheTime: 0 });
    let s;
    try {
      s = await this.client.readContract({
        address: this.address,
        abi: guardedVaultAbi,
        functionName: 'getState',
        blockNumber,
      });
    } catch (err) {
      // No contract at the address yet (e.g. sandbox chain just reset).
      if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionZeroDataError)) {
        return null;
      }
      throw err;
    }
    return {
      balance: s.balance,
      available: s.availableToWithdraw,
      limit: s.withdrawLimit,
      windowSeconds: s.windowDuration,
      timelockDelaySeconds: s.timelockDelay,
      paused: s.paused,
      blockNumber,
    };
  }
}

/**
 * Short-TTL cache with request coalescing: a burst of pending transactions
 * costs one RPC round-trip, which matters on rate-limited free RPC plans.
 */
export class CachedVaultReader implements VaultStateReader {
  #value: { at: number; state: VaultChainState | null } | null = null;
  #inFlight: Promise<VaultChainState | null> | null = null;

  constructor(
    private readonly inner: VaultStateReader,
    private readonly ttlMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  read(): Promise<VaultChainState | null> {
    if (this.#value && this.now() - this.#value.at < this.ttlMs) {
      return Promise.resolve(this.#value.state);
    }
    this.#inFlight ??= this.inner
      .read()
      .then((state) => {
        this.#value = { at: this.now(), state };
        return state;
      })
      .finally(() => {
        this.#inFlight = null;
      });
    return this.#inFlight;
  }

  invalidate(): void {
    this.#value = null;
  }
}

/** Stand-in vault for LIVE_PROVIDER=mock: static balances, pause state driven by the mock guardian. */
export class MockVaultReader implements VaultStateReader {
  paused = false;

  async read(): Promise<VaultChainState> {
    return {
      balance: 250n * 10n ** 18n,
      available: 25n * 10n ** 18n,
      limit: 25n * 10n ** 18n,
      windowSeconds: 3_600n,
      timelockDelaySeconds: 86_400n,
      paused: this.paused,
      blockNumber: 0n,
    };
  }
}

export function toVaultStateDto(state: VaultChainState | null): VaultStateDto {
  if (!state) {
    return {
      deployed: false,
      paused: false,
      balanceWei: '0',
      availableWei: '0',
      limitWei: '0',
      windowSeconds: 0,
      timelockDelaySeconds: 0,
      blockNumber: '0',
      readAt: new Date().toISOString(),
    };
  }
  return {
    deployed: true,
    paused: state.paused,
    balanceWei: state.balance.toString(),
    availableWei: state.available.toString(),
    limitWei: state.limit.toString(),
    windowSeconds: Number(state.windowSeconds),
    timelockDelaySeconds: Number(state.timelockDelaySeconds),
    blockNumber: state.blockNumber.toString(),
    readAt: new Date().toISOString(),
  };
}
