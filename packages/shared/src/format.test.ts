import { describe, expect, it } from 'vitest';
import { formatDuration, formatEth, severityForScore, shortAddress } from './format';

describe('formatEth', () => {
  it('formats whole and fractional ether', () => {
    expect(formatEth('0')).toBe('0');
    expect(formatEth(10n ** 18n)).toBe('1');
    expect(formatEth('1500000000000000000')).toBe('1.5');
    expect(formatEth('123456789000000000000')).toBe('123.4567');
  });

  it('respects maxDecimals and trims zeros', () => {
    expect(formatEth('1234500000000000000', 2)).toBe('1.23');
    expect(formatEth('1000000000000000000', 6)).toBe('1');
  });

  it('handles values beyond Number precision and negatives', () => {
    expect(formatEth((10n ** 30n).toString(), 0)).toBe('1,000,000,000,000');
    expect(formatEth(-(10n ** 18n) / 2n)).toBe('-0.5');
  });
});

describe('shortAddress', () => {
  it('abbreviates long hex strings', () => {
    expect(shortAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
    expect(shortAddress('0x1234')).toBe('0x1234');
  });
});

describe('formatDuration', () => {
  it('picks the largest exact unit', () => {
    expect(formatDuration(60)).toBe('1 minute');
    expect(formatDuration(3_600)).toBe('1 hour');
    expect(formatDuration(7_200)).toBe('2 hours');
    expect(formatDuration(86_400)).toBe('1 day');
    expect(formatDuration(90)).toBe('90 seconds');
  });
});

describe('severityForScore', () => {
  it.each([
    [0, 'info'],
    [19, 'info'],
    [20, 'low'],
    [40, 'medium'],
    [60, 'high'],
    [79, 'high'],
    [80, 'critical'],
    [100, 'critical'],
  ] as const)('score %i → %s', (score, severity) => {
    expect(severityForScore(score)).toBe(severity);
  });
});
