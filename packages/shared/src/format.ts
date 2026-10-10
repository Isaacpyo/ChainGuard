import type { Severity } from './types';

const WEI_PER_ETH = 10n ** 18n;

/**
 * Formats a wei amount as ETH with at most `maxDecimals` decimals, trimming trailing zeros.
 * Works on decimal strings so it is safe for values beyond Number.MAX_SAFE_INTEGER.
 */
export function formatEth(wei: string | bigint, maxDecimals = 4): string {
  const value = typeof wei === 'bigint' ? wei : BigInt(wei);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / WEI_PER_ETH;
  const fraction = (abs % WEI_PER_ETH).toString().padStart(18, '0').slice(0, maxDecimals);
  const trimmed = fraction.replace(/0+$/, '');
  const body = trimmed
    ? `${whole.toLocaleString('en-US')}.${trimmed}`
    : whole.toLocaleString('en-US');
  return `${negative ? '-' : ''}${body}`;
}

/** 0x1234…abcd */
export function shortAddress(address: string, chars = 4): string {
  if (address.length <= 2 + chars * 2) return address;
  return `${address.slice(0, 2 + chars)}…${address.slice(-chars)}`;
}

export function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0 && seconds >= 86_400) return plural(seconds / 86_400, 'day');
  if (seconds % 3_600 === 0 && seconds >= 3_600) return plural(seconds / 3_600, 'hour');
  if (seconds % 60 === 0 && seconds >= 60) return plural(seconds / 60, 'minute');
  return plural(seconds, 'second');
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

export const SEVERITY_BANDS: { severity: Severity; minScore: number }[] = [
  { severity: 'critical', minScore: 80 },
  { severity: 'high', minScore: 60 },
  { severity: 'medium', minScore: 40 },
  { severity: 'low', minScore: 20 },
  { severity: 'info', minScore: 0 },
];

export function severityForScore(score: number): Severity {
  for (const band of SEVERITY_BANDS) {
    if (score >= band.minScore) return band.severity;
  }
  return 'info';
}
