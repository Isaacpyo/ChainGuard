import { parseGwei } from 'viem';

export interface TargetFees {
  gasPrice?: bigint | undefined;
  maxFeePerGas?: bigint | undefined;
  maxPriorityFeePerGas?: bigint | undefined;
}

export interface BidFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export const MIN_TIP = parseGwei('2');
export const MAX_TIP = parseGwei('1000');

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * EIP-1559 fees that out-bid `target` so the guardian's pause() is ordered first
 * in the block: double the attacker's effective tip (bounded), with headroom for
 * the base fee to double before inclusion.
 */
export function outbidFees(target: TargetFees, baseFee: bigint): BidFees {
  const targetMaxFee = target.maxFeePerGas ?? target.gasPrice ?? baseFee;
  const targetTip =
    target.maxPriorityFeePerGas !== undefined
      ? min(target.maxPriorityFeePerGas, max(targetMaxFee - baseFee, 0n))
      : max(targetMaxFee - baseFee, 0n);

  const tip = min(MAX_TIP, max(MIN_TIP, targetTip * 2n));
  const maxFeePerGas = max(baseFee * 2n + tip, targetMaxFee + tip);
  return { maxFeePerGas, maxPriorityFeePerGas: tip };
}
