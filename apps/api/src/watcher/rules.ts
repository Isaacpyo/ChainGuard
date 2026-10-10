import {
  severityForScore,
  type RuleInfo,
  type Severity,
  type TriggeredRule,
} from '@chainguard/shared';
import { formatEther, type Address } from 'viem';
import type { DecodedCall } from './decoder';

export interface RulesConfig {
  /** A withdrawal of at least this share of the vault balance (basis points) is "large". */
  largeWithdrawalBps: number;
  rapidRepeatCount: number;
  rapidRepeatWindowSec: number;
  pauseThreshold: number;
}

export interface VaultSnapshot {
  balance: bigint;
  available: bigint;
  paused: boolean;
}

export interface RuleContext {
  from: Address;
  decoded: DecodedCall;
  /** null when the vault state could not be read (not deployed, RPC error). */
  vault: VaultSnapshot | null;
  /** Lower-cased allowlist of addresses expected to call the vault. */
  knownCallers: ReadonlySet<string>;
  /** State-changing calls from `from` inside the rapid-repeat window, including this one. */
  recentCallsFromSender: number;
  config: RulesConfig;
}

interface Rule {
  id: string;
  label: string;
  weight: number;
  describe(config: RulesConfig): string;
  /** Returns a human-readable reason when the rule fires, otherwise null. */
  evaluate(ctx: RuleContext): string | null;
}

const CAPACITY_DRAIN_PCT = 80n;

const eth = (wei: bigint) => `${formatEther(wei)} ETH`;

export const RULES: readonly Rule[] = [
  {
    id: 'large-withdrawal',
    label: 'Large withdrawal',
    weight: 40,
    describe: (c) => `Withdrawal of at least ${c.largeWithdrawalBps / 100}% of the vault balance.`,
    evaluate({ decoded, vault, config }) {
      if (decoded.call.kind !== 'withdraw' || !vault || vault.balance === 0n) return null;
      const { amount } = decoded.call;
      if (amount * 10_000n < vault.balance * BigInt(config.largeWithdrawalBps)) return null;
      const pct = Number((amount * 10_000n) / vault.balance) / 100;
      return `${eth(amount)} is ${pct}% of the ${eth(vault.balance)} balance`;
    },
  },
  {
    id: 'unknown-caller',
    label: 'Unknown caller',
    weight: 35,
    describe: () => 'State-changing call from an address that is not on the vault allowlist.',
    evaluate({ from, decoded, knownCallers }) {
      if (decoded.call.kind === 'deposit') return null;
      if (knownCallers.has(from.toLowerCase())) return null;
      return `${from} has never been seen operating this vault`;
    },
  },
  {
    id: 'rapid-repeats',
    label: 'Rapid repeats',
    weight: 30,
    describe: (c) =>
      `${c.rapidRepeatCount}+ calls from one sender within ${c.rapidRepeatWindowSec}s.`,
    evaluate({ decoded, recentCallsFromSender, config }) {
      if (decoded.call.kind === 'deposit') return null;
      if (recentCallsFromSender < config.rapidRepeatCount) return null;
      return `${recentCallsFromSender} calls from this sender in the last ${config.rapidRepeatWindowSec}s`;
    },
  },
  {
    id: 'capacity-drain',
    label: 'Rate-limit drain',
    weight: 15,
    describe: () =>
      `Withdrawal uses at least ${CAPACITY_DRAIN_PCT}% of the remaining rate-limit capacity.`,
    evaluate({ decoded, vault }) {
      if (decoded.call.kind !== 'withdraw' || !vault || vault.available === 0n) return null;
      const { amount } = decoded.call;
      if (amount * 100n < vault.available * CAPACITY_DRAIN_PCT) return null;
      return `${eth(amount)} of ${eth(vault.available)} remaining capacity`;
    },
  },
  {
    id: 'timelock-schedule',
    label: 'Admin change queued',
    weight: 30,
    describe: () =>
      'An admin operation was scheduled in the timelock; guardians can still cancel it.',
    evaluate({ decoded }) {
      if (decoded.call.kind !== 'schedule') return null;
      return decoded.call.inner
        ? `queued ${decoded.call.inner.functionName}(${Object.values(decoded.call.inner.args).join(', ')})`
        : 'queued an operation the decoder does not recognise';
    },
  },
];

export interface ScoreResult {
  score: number;
  severity: Severity;
  rules: TriggeredRule[];
  /** Pausing only helps against outflows, so only withdrawals trigger the guardian. */
  shouldPause: boolean;
}

export function scoreTransaction(ctx: RuleContext): ScoreResult {
  const rules: TriggeredRule[] = [];
  for (const rule of RULES) {
    const reason = rule.evaluate(ctx);
    if (reason) rules.push({ id: rule.id, label: rule.label, weight: rule.weight, reason });
  }
  const score = Math.min(
    100,
    rules.reduce((sum, r) => sum + r.weight, 0),
  );
  return {
    score,
    severity: severityForScore(score),
    rules,
    shouldPause: ctx.decoded.call.kind === 'withdraw' && score >= ctx.config.pauseThreshold,
  };
}

export function describeRules(config: RulesConfig): RuleInfo[] {
  return RULES.map((r) => ({
    id: r.id,
    label: r.label,
    weight: r.weight,
    description: r.describe(config),
  }));
}
