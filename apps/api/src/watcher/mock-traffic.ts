import { guardedVaultAbi } from '@chainguard/shared/abi';
import { encodeFunctionData, keccak256, parseEther, toHex, type Address } from 'viem';
import type { PendingTx } from './sources';

export const MOCK_OPERATOR: Address = '0x00000000000000000000000000000000000A11CE';
const MOCK_STRANGER: Address = '0x000000000000000000000000000000000000B0B0';

/**
 * Scripted, clearly-labelled mock traffic for LIVE_PROVIDER=mock: a deposit, a routine
 * operator withdrawal and a small withdrawal from an unknown address, on repeat.
 * Amounts are tiny relative to the mock balance, so it never trips the guardian.
 */
export function mockLiveTraffic(vault: Address): () => PendingTx {
  let i = 0;
  return () => {
    const n = i++;
    const hash = keccak256(toHex(`chainguard-mock:${Date.now()}:${n}`));
    const base = {
      hash,
      to: vault,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    };
    switch (n % 3) {
      case 0:
        return {
          ...base,
          from: MOCK_STRANGER,
          value: parseEther('1.5'),
          input: encodeFunctionData({ abi: guardedVaultAbi, functionName: 'deposit' }),
        };
      case 1:
        return {
          ...base,
          from: MOCK_OPERATOR,
          value: 0n,
          input: encodeFunctionData({
            abi: guardedVaultAbi,
            functionName: 'withdraw',
            args: [MOCK_OPERATOR, parseEther('0.5')],
          }),
        };
      default:
        return {
          ...base,
          from: MOCK_STRANGER,
          value: 0n,
          input: encodeFunctionData({
            abi: guardedVaultAbi,
            functionName: 'withdraw',
            args: [MOCK_STRANGER, parseEther('0.2')],
          }),
        };
    }
  };
}
