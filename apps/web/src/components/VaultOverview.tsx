'use client';

import { formatDuration, formatEth, type VaultDto, type VaultStateDto } from '@chainguard/shared';
import clsx from 'clsx';
import { ExternalLink, Lock, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useStreamEvent, type Loadable } from '@/lib/bus';
import { Badge, CopyButton, ErrorState, Mono, Skeleton } from './ui';

const POLL_MS = { sandbox: 4_000, sepolia: 15_000 } as const;

export function VaultOverview({ vault }: { vault: VaultDto }) {
  const [state, setState] = useState<Loadable<VaultStateDto>>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      const data = await api.vaultState(vault.id);
      setState({ status: 'ready', data });
    } catch (err) {
      setState((prev) =>
        // Keep showing the last good reading during transient failures.
        prev.status === 'ready' ? prev : { status: 'error', message: (err as Error).message },
      );
    }
  }, [vault.id]);

  useEffect(() => {
    setState({ status: 'loading' });
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS[vault.network]);
    return () => clearInterval(id);
  }, [load, vault.network]);

  useStreamEvent((e) => {
    if (e.type === 'simulation.step' || e.type === 'simulation.finished') void load();
    if (e.type === 'alert.updated' && e.alert.vaultId === vault.id && e.alert.response !== 'none')
      void load();
  });

  const s = state.status === 'ready' ? state.data : null;
  const capacityPct =
    s && BigInt(s.limitWei) > 0n
      ? Number((BigInt(s.availableWei) * 1000n) / BigInt(s.limitWei)) / 10
      : 0;

  return (
    <section
      aria-labelledby="vault-heading"
      className="rounded-2xl border border-line bg-panel/90 p-4 shadow-lg shadow-black/20 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 id="vault-heading" className="text-lg font-semibold text-ink sm:text-xl">
              {vault.name}
            </h1>
            <Badge>{vault.network === 'sandbox' ? 'anvil sandbox' : 'Sepolia'}</Badge>
            {vault.provider === 'mock' && <Badge tone="warn">mock provider</Badge>}
          </div>
          <div className="mt-1 flex items-center gap-1 text-sm text-muted">
            <Mono className="truncate">{vault.address}</Mono>
            <CopyButton value={vault.address} label="Copy vault address" />
            {vault.explorerUrl && (
              <a
                href={vault.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex size-7 items-center justify-center rounded-md hover:bg-white/5 hover:text-ink"
                aria-label="Open in block explorer"
              >
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            )}
          </div>
        </div>
        {state.status === 'loading' ? (
          <Skeleton className="h-10 w-32" />
        ) : s ? (
          <div
            role="status"
            aria-live="polite"
            className={clsx(
              'inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold ring-1 ring-inset',
              !s.deployed && 'bg-white/5 text-muted ring-line-strong',
              s.deployed && s.paused && 'bg-rose-500/15 text-rose-200 ring-rose-500/40',
              s.deployed && !s.paused && 'bg-emerald-400/10 text-emerald-200 ring-emerald-400/30',
            )}
          >
            {s.paused ? (
              <Lock className="size-4" aria-hidden />
            ) : (
              <ShieldCheck className="size-4" aria-hidden />
            )}
            {!s.deployed ? 'Not deployed' : s.paused ? 'Paused — withdrawals blocked' : 'Active'}
          </div>
        ) : null}
      </div>

      {state.status === 'error' && (
        <ErrorState message={state.message} onRetry={() => void load()} />
      )}

      {state.status !== 'error' && (
        <dl className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="Balance" loading={!s}>
            {s && `${formatEth(s.balanceWei, 2)} ETH`}
          </Metric>
          <Metric label="Withdrawable now" loading={!s}>
            {s && (
              <div className="flex flex-col gap-1.5">
                <span>
                  {formatEth(s.availableWei, 2)}{' '}
                  <span className="text-muted">/ {formatEth(s.limitWei, 2)} ETH</span>
                </span>
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-white/10"
                  role="meter"
                  aria-label="Rate-limit capacity remaining"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={capacityPct}
                >
                  <div
                    className="h-full rounded-full bg-emerald-400"
                    style={{ width: `${capacityPct}%` }}
                  />
                </div>
              </div>
            )}
          </Metric>
          <Metric label="Refill window" loading={!s}>
            {s && (s.deployed ? formatDuration(s.windowSeconds) : '—')}
          </Metric>
          <Metric label="Admin timelock" loading={!s}>
            {s && (s.deployed ? formatDuration(s.timelockDelaySeconds) : '—')}
          </Metric>
        </dl>
      )}
      {s && !s.deployed && (
        <p className="mt-4 text-sm text-muted">
          No contract at this address yet. Run a simulation to deploy and fund the sandbox vault.
        </p>
      )}
    </section>
  );
}

function Metric({
  label,
  loading,
  children,
}: {
  label: string;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-canvas/60 px-3 py-2.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-ink sm:text-base">
        {loading ? <Skeleton className="h-5 w-20" /> : children}
      </dd>
    </div>
  );
}
