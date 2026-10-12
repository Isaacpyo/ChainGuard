import type { AlertDto } from '@chainguard/shared';

/**
 * Merges a freshly fetched first page of alerts (newest first) into the list on
 * screen. Alerts that streamed in while the request was in flight (`streamedIds`)
 * may be missing from the page, so they stay on top. Everything else on screen is
 * replaced by the page, including alerts that no longer match the filter (e.g.
 * acknowledged while the stream was down).
 */
export function mergeLatestPage(
  current: AlertDto[],
  page: AlertDto[],
  streamedIds: ReadonlySet<string>,
): AlertDto[] {
  const ids = new Set(page.map((a) => a.id));
  const streamed = current.filter((a) => streamedIds.has(a.id) && !ids.has(a.id));
  return [...streamed, ...page];
}
