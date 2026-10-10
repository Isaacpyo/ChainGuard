import { guardedVaultAbi } from '@chainguard/shared/abi';
import { encodeFunctionData, keccak256, parseEther, toHex, type Address, type Hex } from 'viem';
import type { VaultChainState } from '../src/chain/vault';
import type { RulesConfig } from '../src/watcher/rules';
import type { PendingTx } from '../src/watcher/sources';

export const VAULT: Address = '0x1111111111111111111111111111111111111111';
export const OPS: Address = '0x2222222222222222222222222222222222222222';
export const ATTACKER: Address = '0x3333333333333333333333333333333333333333';
export const ADMIN: Address = '0x4444444444444444444444444444444444444444';

export const RULES_CONFIG: RulesConfig = {
  largeWithdrawalBps: 1_000,
  rapidRepeatCount: 3,
  rapidRepeatWindowSec: 60,
  pauseThreshold: 70,
};

export const vaultState = (overrides: Partial<VaultChainState> = {}): VaultChainState => ({
  balance: parseEther('100'),
  available: parseEther('20'),
  limit: parseEther('20'),
  windowSeconds: 3_600n,
  timelockDelaySeconds: 60n,
  paused: false,
  blockNumber: 1n,
  ...overrides,
});

let n = 0;
export const txHash = (): Hex => keccak256(toHex(`tx-${n++}`));

export const withdrawTx = (
  from: Address,
  amountEth: string,
  extra: Partial<PendingTx> = {},
): PendingTx => ({
  hash: txHash(),
  from,
  to: VAULT,
  value: 0n,
  input: encodeFunctionData({
    abi: guardedVaultAbi,
    functionName: 'withdraw',
    args: [from, parseEther(amountEth)],
  }),
  maxFeePerGas: 30_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  ...extra,
});

export const depositTx = (from: Address, amountEth: string): PendingTx => ({
  hash: txHash(),
  from,
  to: VAULT,
  value: parseEther(amountEth),
  input: encodeFunctionData({ abi: guardedVaultAbi, functionName: 'deposit' }),
});
