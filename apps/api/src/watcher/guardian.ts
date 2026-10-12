import { guardedVaultAbi } from '@chainguard/shared/abi';
import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from 'viem';
import { outbidFees, type TargetFees } from './fees';
import type { MockVaultReader } from '../chain/vault';

/** Sends pause() on behalf of the watcher. */
export interface Guardian {
  readonly address: Address;
  /** Submits pause() priced to land before `target`; resolves once it is in the mempool. */
  pause(vault: Address, target: TargetFees): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<'success' | 'reverted'>;
}

const PAUSE_GAS = 80_000n;

export class ViemGuardian implements Guardian {
  constructor(
    private readonly wallet: WalletClient<Transport, Chain, Account>,
    private readonly client: PublicClient,
  ) {}

  get address(): Address {
    return this.wallet.account.address;
  }

  async pause(vault: Address, target: TargetFees): Promise<Hex> {
    const block = await this.client.getBlock({ blockTag: 'latest' });
    const fees = outbidFees(target, block.baseFeePerGas ?? 0n);
    return this.wallet.writeContract({
      address: vault,
      abi: guardedVaultAbi,
      functionName: 'pause',
      gas: PAUSE_GAS, // skip estimation: every millisecond counts
      ...fees,
    });
  }

  async waitForReceipt(hash: Hex): Promise<'success' | 'reverted'> {
    const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    return receipt.status;
  }
}

/** Records pause requests instead of sending them (tests, LIVE_PROVIDER=mock). */
export class MockGuardian implements Guardian {
  readonly address: Address = '0x000000000000000000000000000000000000dEaD';
  readonly calls: { vault: Address; target: TargetFees }[] = [];
  #n = 0;

  constructor(private readonly vaultReader?: MockVaultReader) {}

  async pause(vault: Address, target: TargetFees): Promise<Hex> {
    this.calls.push({ vault, target });
    if (this.vaultReader) this.vaultReader.paused = true;
    this.#n += 1;
    return `0x${this.#n.toString(16).padStart(64, '0')}`;
  }

  async waitForReceipt(): Promise<'success'> {
    return 'success';
  }
}
