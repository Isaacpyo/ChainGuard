'use client';

import {
  formatEth,
  shortAddress,
  type AlertDto,
  type AlertStatus,
  type ResponseAction,
} from '@chainguard/shared';
import clsx from 'clsx';
import { Inbox, Radio, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { timeAgo, useNow, useStreamEvent } from '@/lib/bus';
import { Badge, Button, Card, EmptyState, ErrorState, Mono, SeverityBadge, Skeleton } from './ui';

type Filter = 'all' | 'threats' | 'open';

const FILTERS: { id: Filter; label: string; query: { severity?: string; status?: AlertStatus } }[] =
  [
    { id: 'all', label: 'All activity', query: {} },
    { id: 'threats', label: 'High & critical', query: { severity: 'high,critical' } },
    { id: 'open', label: 'Open', query: { status: 'open' } },
  ];

const matches = (alert: AlertDto, filter: Filter) =>
  filter === 'all' ||
  (filter === 'threats' && (alert.severity === 'high' || alert.severity === 'critical')) ||
  (filter === 'open' && alert.status === 'open');

const RESPONSE_LABEL: Record<
  ResponseAction,
  { text: string; tone: 'good' | 'bad' | 'warn' | 'neutral' } | null
> = {
  none: null,
  pause_submitted: { text: 'Pause sent', tone: 'warn' },
  pause_confirmed: { text: 'Guardian paused vault', tone: 'good' },
  already_paused: { text: 'Vault already paused', tone: 'neutral' },
  pause_failed: { text: 'Pause failed', tone: 'bad' },
};

export function AlertFeed({ vaultId }: { vaultId: string }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<AlertDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'more'>('loading');
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState('');
  const requestId = useRef(0);
  const now = useNow(10_000);

  const load = useCallback(
    async (more = false) => {
      const id = ++requestId.current;
      setStatus(more ? 'more' : 'loading');
      try {
        const query = FILTERS.find((f) => f.id === filter)!.query;
        const page = await api.alerts({
          vaultId,
          limit: 20,
          ...query,
          ...(more && cursor ? { cursor } : {}),
        });
        if (id !== requestId.current) return;
        setItems((prev) =>
          more
            ? [...prev, ...page.items.filter((a) => !prev.some((p) => p.id === a.id))]
            : page.items,
        );
        setCursor(page.nextCursor);
        setStatus('ready');
      } catch (err) {
        if (id !== requestId.current) return;
        setError((err as Error).message);
        setStatus('error');
      }
    },
    [vaultId, filter, cursor],
  );

  useEffect(() => {
    setCursor(null);
    void load(false);
    // Reload only when the vault or filter changes, not when the cursor moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId, filter]);

  useStreamEvent((e) => {
    if (e.type === 'alert' && e.alert.vaultId === vaultId && matches(e.alert, filter)) {
      setItems((prev) => (prev.some((a) => a.id === e.alert.id) ? prev : [e.alert, ...prev]));
      setFresh((prev) => new Set(prev).add(e.alert.id));
      if (e.alert.severity === 'critical' || e.alert.severity === 'high') {
        setAnnouncement(
          `${e.alert.severity} alert: ${e.alert.functionName} from ${shortAddress(e.alert.from)}`,
        );
      }
    }
    if (e.type === 'alert.updated' && e.alert.vaultId === vaultId) {
      setItems((prev) =>
        prev
          .map((a) => (a.id === e.alert.id ? e.alert : a))
          .filter((a) => a.id !== e.alert.id || matches(a, filter)),
      );
    }
  });

  const updateStatus = async (alert: AlertDto, next: AlertStatus) => {
    const updated = await api.setAlertStatus(alert.id, next);
    setItems((prev) =>
      prev.map((a) => (a.id === updated.id ? updated : a)).filter((a) => matches(a, filter)),
    );
  };

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Radio className="size-4 text-emerald-300" aria-hidden /> Live alert feed
        </span>
      }
      action={
        <div role="group" aria-label="Filter alerts" className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className="h-7 rounded-md px-2 text-xs font-medium text-muted hover:text-ink aria-pressed:bg-white/10 aria-pressed:text-ink"
            >
              {f.label}
            </button>
          ))}
        </div>
      }
      className="min-w-0"
    >
      <div className="sr-only" aria-live="assertive">
        {announcement}
      </div>
      {status === 'loading' && (
        <div className="flex flex-col gap-3" aria-label="Loading alerts">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      )}
      {status === 'error' && <ErrorState message={error} onRetry={() => void load(false)} />}
      {(status === 'ready' || status === 'more') && items.length === 0 && (
        <EmptyState icon={<Inbox className="size-7" />} title="No alerts yet">
          {filter === 'all'
            ? 'Transactions to this vault will appear here the moment they reach the mempool.'
            : 'Nothing matches this filter.'}
        </EmptyState>
      )}
      {items.length > 0 && status !== 'loading' && (
        <ul className="-mx-4 flex flex-col divide-y divide-line sm:-mx-5" data-testid="alert-feed">
          {items.map((alert) => (
            <AlertRow
              key={alert.id}
              alert={alert}
              fresh={fresh.has(alert.id)}
              ago={timeAgo(alert.detectedAt, now)}
              onStatus={updateStatus}
            />
          ))}
        </ul>
      )}
      {cursor && status !== 'loading' && (
        <div className="mt-4 flex justify-center">
          <Button size="sm" busy={status === 'more'} onClick={() => void load(true)}>
            Load older alerts
          </Button>
        </div>
      )}
    </Card>
  );
}

function amountOf(alert: AlertDto): string | null {
  if (alert.functionName === 'withdraw' && alert.args.amount)
    return `${formatEth(alert.args.amount)} ETH`;
  if (alert.valueWei !== '0') return `${formatEth(alert.valueWei)} ETH`;
  return null;
}

function AlertRow({
  alert,
  fresh,
  ago,
  onStatus,
}: {
  alert: AlertDto;
  fresh: boolean;
  ago: string;
  onStatus: (alert: AlertDto, status: AlertStatus) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const response = RESPONSE_LABEL[alert.response];
  const amount = amountOf(alert);
  const unknown = alert.rules.some((r) => r.id === 'unknown-caller');

  const act = async (next: AlertStatus) => {
    setBusy(true);
    setError(null);
    try {
      await onStatus(alert, next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className={clsx(
        // Phones: severity | details, actions under the details. sm+: actions get their own column.
        'grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[5rem_minmax(0,1fr)_auto] sm:px-5',
        fresh && 'animate-flash',
      )}
      data-severity={alert.severity}
    >
      <div className="row-span-2 flex flex-col items-start gap-1 sm:row-span-1">
        <SeverityBadge severity={alert.severity} />
        <span className="text-xs text-muted">
          score <span className="font-semibold text-ink">{alert.score}</span>
        </span>
      </div>
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <Mono className="font-semibold text-ink">{alert.functionName}</Mono>
          {amount && <span className="font-medium text-ink">{amount}</span>}
          <span className="text-xs text-muted" title={new Date(alert.detectedAt).toLocaleString()}>
            {ago} · {alert.stage === 'pending' ? 'mempool' : 'mined'}
          </span>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
          from{' '}
          <Mono className={unknown ? 'text-rose-200' : 'text-ink'}>{shortAddress(alert.from)}</Mono>
          <span aria-hidden>·</span> tx <Mono>{shortAddress(alert.txHash)}</Mono>
        </p>
        {(alert.rules.length > 0 || response) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {response && (
              <Badge tone={response.tone}>
                {alert.response === 'pause_confirmed' && (
                  <ShieldCheck className="size-3" aria-hidden />
                )}
                {response.text}
              </Badge>
            )}
            {alert.rules.map((r) => (
              <span
                key={r.id}
                title={r.reason}
                className="rounded-md bg-white/5 px-1.5 py-0.5 text-[11px] text-muted ring-1 ring-inset ring-line-strong"
              >
                {r.label} <span className="text-ink">+{r.weight}</span>
              </span>
            ))}
          </div>
        )}
        {alert.rules.length > 0 && (
          <details className="mt-1.5 text-xs text-muted">
            <summary className="w-fit cursor-pointer select-none hover:text-ink">
              Why this score
            </summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {alert.rules.map((r) => (
                <li key={r.id} className="break-words">
                  <span className="text-ink">{r.label}:</span> {r.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
        {error && <p className="mt-1 text-xs text-rose-300">{error}</p>}
      </div>
      {(alert.status !== 'open' || alert.severity !== 'info') && (
        <div className="col-start-2 flex flex-wrap items-center gap-1.5 sm:col-start-3 sm:row-start-1 sm:flex-col sm:items-end">
          {alert.status !== 'open' && (
            <Badge tone={alert.status === 'resolved' ? 'good' : 'neutral'}>{alert.status}</Badge>
          )}
          {alert.severity !== 'info' && (
            <div className="flex gap-1">
              {alert.status === 'open' && (
                <Button
                  size="sm"
                  variant="ghost"
                  busy={busy}
                  onClick={() => void act('acknowledged')}
                >
                  Acknowledge
                </Button>
              )}
              {alert.status !== 'resolved' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void act('resolved')}
                >
                  Resolve
                </Button>
              ) : (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('open')}>
                  Reopen
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
