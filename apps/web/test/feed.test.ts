import type { AlertDto } from '@chainguard/shared';
import { describe, expect, it } from 'vitest';
import { mergeLatestPage } from '@/lib/feed';

const alert = (id: string, second: number, extra: Partial<AlertDto> = {}): AlertDto => ({
  id,
  vaultId: 'v1',
  network: 'sandbox',
  vaultAddress: '0xvault',
  txHash: `0x${id}`,
  stage: 'pending',
  from: '0xfrom',
  functionName: 'withdraw',
  args: {},
  valueWei: '0',
  score: 0,
  severity: 'info',
  rules: [],
  response: 'none',
  responseTxHash: null,
  status: 'open',
  acknowledgedBy: null,
  simulationId: null,
  detectedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
  ...extra,
});

const ids = (list: AlertDto[]) => list.map((a) => a.id);

describe('mergeLatestPage', () => {
  it('keeps alerts that streamed in after the page was read', () => {
    const streamed = [alert('d', 40), alert('c', 30)];
    const page = [alert('b', 20), alert('a', 10)];
    expect(ids(mergeLatestPage(streamed, page))).toEqual(['d', 'c', 'b', 'a']);
  });

  it('dedupes by id, preferring the fetched copy', () => {
    const onScreen = [alert('c', 30), alert('b', 20, { status: 'open' })];
    const page = [alert('c', 30, { status: 'resolved' }), alert('b', 20)];
    const merged = mergeLatestPage(onScreen, page);
    expect(ids(merged)).toEqual(['c', 'b']);
    expect(merged[0]!.status).toBe('resolved');
  });

  it('drops on-screen alerts that are not newer than the page', () => {
    const onScreen = [alert('b', 20), alert('x', 15), alert('older', 5)];
    const page = [alert('b', 20), alert('a', 10)];
    expect(ids(mergeLatestPage(onScreen, page))).toEqual(['b', 'a']);
  });

  it('keeps streamed alerts when the page is empty', () => {
    expect(ids(mergeLatestPage([alert('a', 10)], []))).toEqual(['a']);
    expect(mergeLatestPage([], [])).toEqual([]);
  });
});
