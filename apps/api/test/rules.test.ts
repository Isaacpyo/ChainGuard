import { guardedVaultAbi } from '@chainguard/shared/abi';
import { encodeFunctionData, keccak256, parseEther, toHex, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { decodeVaultCall } from '../src/watcher/decoder';
import {
  describeRules,
  scoreTransaction,
  type RuleContext,
  type VaultSnapshot,
} from '../src/watcher/rules';
import { ADMIN, ATTACKER, OPS, RULES_CONFIG } from './fixtures';

const known = new Set([OPS, ADMIN].map((a) => a.toLowerCase()));
const vault: VaultSnapshot = {
  balance: parseEther('100'),
  available: parseEther('20'),
  paused: false,
};

const withdraw = (amountEth: string) =>
  decodeVaultCall(
    encodeFunctionData({
      abi: guardedVaultAbi,
      functionName: 'withdraw',
      args: [OPS, parseEther(amountEth)],
    }),
    0n,
  );

const ctx = (overrides: Partial<RuleContext> & { from?: Address } = {}): RuleContext => ({
  from: OPS,
  decoded: withdraw('1'),
  vault,
  knownCallers: known,
  recentCallsFromSender: 1,
  config: RULES_CONFIG,
  ...overrides,
});

const ids = (c: RuleContext) => scoreTransaction(c).rules.map((r) => r.id);

describe('scoreTransaction', () => {
  it('scores routine operator activity as info', () => {
    const r = scoreTransaction(ctx());
    expect(r).toMatchObject({ score: 0, severity: 'info', rules: [], shouldPause: false });
  });

  it('flags withdrawals at or above the large-withdrawal share', () => {
    expect(ids(ctx({ decoded: withdraw('9.99') }))).not.toContain('large-withdrawal');
    const r = scoreTransaction(ctx({ decoded: withdraw('10') }));
    expect(r.rules.map((x) => x.id)).toContain('large-withdrawal');
    expect(r.rules[0]!.reason).toContain('10%');
  });

  it('flags unknown callers but not deposits from strangers', () => {
    expect(ids(ctx({ from: ATTACKER }))).toEqual(['unknown-caller']);
    const deposit = decodeVaultCall(
      encodeFunctionData({ abi: guardedVaultAbi, functionName: 'deposit' }),
      1n,
    );
    expect(ids(ctx({ from: ATTACKER, decoded: deposit }))).toEqual([]);
  });

  it('matches known callers case-insensitively', () => {
    expect(ids(ctx({ from: OPS.toUpperCase().replace('0X', '0x') as Address }))).toEqual([]);
  });

  it('flags rapid repeats once the count reaches the threshold', () => {
    expect(ids(ctx({ recentCallsFromSender: 2 }))).toEqual([]);
    expect(ids(ctx({ recentCallsFromSender: 3 }))).toEqual(['rapid-repeats']);
  });

  it('flags withdrawals that drain most of the remaining capacity', () => {
    expect(ids(ctx({ decoded: withdraw('15.9') }))).toEqual(['large-withdrawal']);
    expect(ids(ctx({ decoded: withdraw('16') }))).toEqual(['large-withdrawal', 'capacity-drain']);
  });

  it('flags timelock schedules and names the queued call', () => {
    const inner = encodeFunctionData({ abi: guardedVaultAbi, functionName: 'unpause' });
    const decoded = decodeVaultCall(
      encodeFunctionData({
        abi: guardedVaultAbi,
        functionName: 'schedule',
        args: [inner, keccak256(toHex('s'))],
      }),
      0n,
    );
    const r = scoreTransaction(ctx({ from: ADMIN, decoded }));
    expect(r.rules).toEqual([
      expect.objectContaining({ id: 'timelock-schedule', reason: 'queued unpause()' }),
    ]);
    expect(r.shouldPause).toBe(false);
  });

  it('pauses on the drain pattern: large withdrawal from an unknown caller', () => {
    const r = scoreTransaction(ctx({ from: ATTACKER, decoded: withdraw('10') }));
    expect(r.score).toBe(75);
    expect(r.severity).toBe('high');
    expect(r.shouldPause).toBe(true);
  });

  it('caps the score at 100', () => {
    const r = scoreTransaction(
      ctx({ from: ATTACKER, decoded: withdraw('19'), recentCallsFromSender: 5 }),
    );
    expect(r.score).toBe(100);
    expect(r.severity).toBe('critical');
  });

  it('never pauses for non-withdrawals, whatever the score', () => {
    const decoded = decodeVaultCall(
      encodeFunctionData({ abi: guardedVaultAbi, functionName: 'pause' }),
      0n,
    );
    const r = scoreTransaction(ctx({ from: ATTACKER, decoded, recentCallsFromSender: 10 }));
    expect(r.score).toBe(65);
    expect(r.shouldPause).toBe(false);
  });

  it('still scores when vault state is unavailable', () => {
    const r = scoreTransaction(ctx({ from: ATTACKER, decoded: withdraw('50'), vault: null }));
    expect(r.rules.map((x) => x.id)).toEqual(['unknown-caller']);
  });

  it('respects a custom threshold', () => {
    const r = scoreTransaction(
      ctx({ from: ATTACKER, config: { ...RULES_CONFIG, pauseThreshold: 30 } }),
    );
    expect(r.shouldPause).toBe(true);
  });
});

describe('describeRules', () => {
  it('documents every rule with its weight', () => {
    const rules = describeRules(RULES_CONFIG);
    expect(rules.map((r) => r.id)).toEqual([
      'large-withdrawal',
      'unknown-caller',
      'rapid-repeats',
      'capacity-drain',
      'timelock-schedule',
    ]);
    expect(rules[0]!.description).toContain('10%');
    expect(rules.every((r) => r.weight > 0)).toBe(true);
  });
});
