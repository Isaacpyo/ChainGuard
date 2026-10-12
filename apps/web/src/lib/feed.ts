import type { AlertDto } from '@chainguard/shared';

/**
 * Merges a freshly fetched first page of alerts (newest first) into the list on
 * screen. Alerts that streamed in while the request was in flight can be newer
 * than anything in the page, so they stay on top; everything else is replaced by
 * the page.
 */
export function mergeLatestPage(current: AlertDto[], page: AlertDto[]): AlertDto[] {
  const ids = new Set(page.map((a) => a.id));
  const newest = page[0] ? Date.parse(page[0].detectedAt) : -Infinity;
  const newer = current.filter((a) => !ids.has(a.id) && Date.parse(a.detectedAt) > newest);
  return [...newer, ...page];
}
