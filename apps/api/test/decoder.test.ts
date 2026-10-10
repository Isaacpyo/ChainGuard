import { guardedVaultAbi } from '@chainguard/shared/abi';
import { encodeFunctionData, keccak256, parseEther, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { decodeVaultCall } from '../src/watcher/decoder';
import { ATTACKER, OPS } from './fixtures';

describe('decodeVaultCall', () => {
  it('decodes withdraw with named, stringified args', () => {
    const input = encodeFunctionData({
      abi: guardedVaultAbi,
      functionName: 'withdraw',
      args: [ATTACKER, parseEther('10')],
    });
    const decoded = decodeVaultCall(input, 0n);
    expect(decoded.functionName).toBe('withdraw');
    expect(decoded.args).toEqual({ to: ATTACKER, amount: parseEther('10').toString() });
    expect(decoded.call).toEqual({ kind: 'withdraw', to: ATTACKER, amount: parseEther('10') });
  });

  it('treats deposit() and plain transfers as deposits', () => {
    const viaFn = decodeVaultCall(
      encodeFunctionData({ abi: guardedVaultAbi, functionName: 'deposit' }),
      5n,
    );
    expect(viaFn.call).toEqual({ kind: 'deposit', amount: 5n });
    const plain = decodeVaultCall('0x', 7n);
    expect(plain).toMatchObject({ functionName: 'receive', call: { kind: 'deposit', amount: 7n } });
  });

  it('decodes the inner call of a timelock schedule()', () => {
    const role = keccak256(toHex('WITHDRAWER_ROLE'));
    const inner = encodeFunctionData({
      abi: guardedVaultAbi,
      functionName: 'grantRole',
      args: [role, OPS],
    });
    const input = encodeFunctionData({
      abi: guardedVaultAbi,
      functionName: 'schedule',
      args: [inner, keccak256(toHex('salt'))],
    });
    const decoded = decodeVaultCall(input, 0n);
    expect(decoded.call.kind).toBe('schedule');
    if (decoded.call.kind !== 'schedule') throw new Error('unreachable');
    expect(decoded.call.inner).toEqual({ functionName: 'grantRole', args: { role, account: OPS } });
    expect(decoded.args.data).toBe(`grantRole(${role}, ${OPS})`);
  });

  it('labels unknown selectors instead of throwing', () => {
    const decoded = decodeVaultCall('0xdeadbeef00', 0n);
    expect(decoded.functionName).toBe('unknown(0xdeadbeef)');
    expect(decoded.call.kind).toBe('unknown');
  });

  it('classifies other ABI functions', () => {
    const input = encodeFunctionData({ abi: guardedVaultAbi, functionName: 'pause' });
    expect(decodeVaultCall(input, 0n).call.kind).toBe('pause');
    const renounce = encodeFunctionData({
      abi: guardedVaultAbi,
      functionName: 'renounceRole',
      args: [keccak256(toHex('X')), OPS],
    });
    expect(decodeVaultCall(renounce, 0n).call.kind).toBe('other');
  });
});
