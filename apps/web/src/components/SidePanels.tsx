'use client';

import type { AlertSummary, ConfigDto } from '@chainguard/shared';
import { Gauge } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useResync, useStreamEvent } from '@/lib/bus';
import { Card, Skeleton } from './ui';

export function SummaryTiles({ vaultId }: { vaultId: string }) {
  const [summary, setSummary] = useState<AlertSummary | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    api
      .summary(vaultId)
      .then(setSummary)
      .catch(() => undefined);
  }, [vaultId]);

  useEffect(() => {
    setSummary(null);
    load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  // Debounced: a simulation produces a burst of events.
  useStreamEvent((e) => {
    if ((e.type === 'alert' || e.type === 'alert.updated') && e.alert.vaultId === vaultId) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 400);
    }
  });
  useResync(load);

  const tiles = [
    { label: 'Open threats', value: summary?.open, tone: 'text-amber-100' },
    { label: 'Critical', value: summary?.bySeverity.critical, tone: 'text-rose-200' },
    { label: 'High', value: summary?.bySeverity.high, tone: 'text-orange-200' },
    { label: 'Events seen', value: summary?.total, tone: 'text-ink' },
  ];

  return (
    <dl className="grid grid-cols-2 gap-3" aria-label="Alert summary">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-xl border border-line bg-panel/90 px-3 py-3">
          <dt className="text-xs text-muted">{t.label}</dt>
          <dd className={`mt-1 text-2xl font-semibold ${t.tone}`}>
            {summary ? t.value : <Skeleton className="h-7 w-10" />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function RulesCard({ config }: { config: ConfigDto | null }) {
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Gauge className="size-4 text-sky-300" aria-hidden /> Detection rules
        </span>
      }
    >
      {!config ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : (
        <>
          <p className="text-sm text-muted">
            Weights add up to a 0–100 score. Withdrawals scoring{' '}
            <span className="font-semibold text-ink">≥ {config.pauseThreshold}</span> trigger an
            automatic pause.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {config.rules.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 text-sm">
                <div>
                  <p className="font-medium text-ink">{r.label}</p>
                  <p className="text-xs text-muted">{r.description}</p>
                </div>
                <span className="shrink-0 rounded-md bg-white/5 px-2 py-0.5 font-mono text-xs text-ink ring-1 ring-inset ring-line-strong">
                  +{r.weight}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
