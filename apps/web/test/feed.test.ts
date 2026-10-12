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
  it('keeps alerts that streamed in while the page was being read', () => {
    const onScreen = [alert('d', 40), alert('c', 30), alert('b', 20)];
    const page = [alert('b', 20), alert('a', 10)];
    expect(ids(mergeLatestPage(onScreen, page, new Set(['d', 'c'])))).toEqual(['d', 'c', 'b', 'a']);
  });

  it('dedupes by id, preferring the fetched copy', () => {
    const onScreen = [alert('c', 30), alert('b', 20, { status: 'open' })];
    const page = [alert('c', 30, { status: 'resolved' }), alert('b', 20)];
    const merged = mergeLatestPage(onScreen, page, new Set(['c']));
    expect(ids(merged)).toEqual(['c', 'b']);
    expect(merged[0]!.status).toBe('resolved');
  });

  it('drops on-screen alerts the page no longer contains, however new', () => {
    // "Open" view: 'a' was acknowledged while the stream was down, so the refetch omits it.
    const onScreen = [alert('a', 30), alert('b', 20)];
    expect(ids(mergeLatestPage(onScreen, [alert('b', 20)], new Set()))).toEqual(['b']);
    expect(mergeLatestPage(onScreen, [], new Set())).toEqual([]);
  });

  it('keeps streamed alerts when the page is empty', () => {
    expect(ids(mergeLatestPage([alert('a', 10)], [], new Set(['a'])))).toEqual(['a']);
    expect(mergeLatestPage([], [], new Set())).toEqual([]);
  });
});
