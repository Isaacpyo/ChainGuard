import { guardedVaultAbi } from '@chainguard/shared/abi';
import { decodeFunctionData, slice, type Address, type Hex } from 'viem';

export type VaultCall =
  | { kind: 'deposit'; amount: bigint }
  | { kind: 'withdraw'; to: Address; amount: bigint }
  | { kind: 'pause' }
  | { kind: 'schedule'; inner: DecodedInner | null }
  | { kind: 'execute'; inner: DecodedInner | null }
  | { kind: 'cancel' }
  | { kind: 'other' }
  | { kind: 'unknown' };

export interface DecodedInner {
  functionName: string;
  args: Record<string, string>;
}

export interface DecodedCall {
  functionName: string;
  /** Display/storage form: argument name → stringified value. */
  args: Record<string, string>;
  call: VaultCall;
}

type AbiFunction = Extract<(typeof guardedVaultAbi)[number], { type: 'function' }>;

const functionsByName = new Map<string, AbiFunction>(
  guardedVaultAbi
    .filter((item): item is AbiFunction => item.type === 'function')
    .map((item) => [item.name, item]),
);

function stringify(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

function namedArgs(
  functionName: string,
  args: readonly unknown[] | undefined,
): Record<string, string> {
  const inputs = functionsByName.get(functionName)?.inputs ?? [];
  const out: Record<string, string> = {};
  (args ?? []).forEach((value, i) => {
    out[inputs[i]?.name || `arg${i}`] = stringify(value);
  });
  return out;
}

function decodeInner(data: Hex): DecodedInner | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: guardedVaultAbi, data });
    return { functionName, args: namedArgs(functionName, args) };
  } catch {
    return null;
  }
}

/**
 * Decodes calldata sent to a GuardedVault. Empty calldata is a plain ETH transfer,
 * which the vault's `receive()` treats as a deposit.
 */
export function decodeVaultCall(input: Hex, value: bigint): DecodedCall {
  if (input === '0x' || input === '0x0') {
    return { functionName: 'receive', args: {}, call: { kind: 'deposit', amount: value } };
  }

  let decoded: ReturnType<typeof decodeFunctionData<typeof guardedVaultAbi>>;
  try {
    decoded = decodeFunctionData({ abi: guardedVaultAbi, data: input });
  } catch {
    const selector = input.length >= 10 ? slice(input, 0, 4) : input;
    return { functionName: `unknown(${selector})`, args: {}, call: { kind: 'unknown' } };
  }

  const args = namedArgs(decoded.functionName, decoded.args);
  switch (decoded.functionName) {
    case 'deposit':
      return { functionName: 'deposit', args, call: { kind: 'deposit', amount: value } };
    case 'withdraw': {
      const [to, amount] = decoded.args;
      return { functionName: 'withdraw', args, call: { kind: 'withdraw', to, amount } };
    }
    case 'pause':
      return { functionName: 'pause', args, call: { kind: 'pause' } };
    case 'schedule':
    case 'execute': {
      const [data] = decoded.args;
      const inner = decodeInner(data);
      if (inner) args.data = `${inner.functionName}(${Object.values(inner.args).join(', ')})`;
      return {
        functionName: decoded.functionName,
        args,
        call: { kind: decoded.functionName, inner },
      };
    }
    case 'cancel':
      return { functionName: 'cancel', args, call: { kind: 'cancel' } };
    default:
      return { functionName: decoded.functionName, args, call: { kind: 'other' } };
  }
}
