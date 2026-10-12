'use client';

import type { ConfigDto, VaultDto } from '@chainguard/shared';
import clsx from 'clsx';
import { LogOut, Vault } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertFeed } from '@/components/AlertFeed';
import { Logo } from '@/components/Logo';
import { RulesCard, SummaryTiles } from '@/components/SidePanels';
import { SimulationPanel } from '@/components/SimulationPanel';
import { Button, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { VaultOverview } from '@/components/VaultOverview';
import { API_URL, api } from '@/lib/api';
import { BusContext, EventBus, type Loadable } from '@/lib/bus';
import { useSession } from '@/lib/hooks';
import { clearSession } from '@/lib/session';
import { openEventStream, type ConnectionState } from '@/lib/sse';

export default function DashboardPage() {
  const router = useRouter();
  const session = useSession();
  const bus = useMemo(() => new EventBus(), []);
  const [vaults, setVaults] = useState<Loadable<VaultDto[]>>({ status: 'loading' });
  const [config, setConfig] = useState<ConfigDto | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stream, setStream] = useState<ConnectionState>('connecting');

  useEffect(() => {
    if (session === null) router.replace('/');
  }, [session, router]);

  const load = useCallback(async () => {
    setVaults({ status: 'loading' });
    try {
      const [list, cfg] = await Promise.all([api.vaults(), api.config()]);
      setVaults({ status: 'ready', data: list });
      setConfig(cfg);
      setSelectedId((id) => id ?? (list.find((v) => v.simulatable) ?? list[0])?.id ?? null);
    } catch (err) {
      setVaults({ status: 'error', message: (err as Error).message });
    }
  }, []);

  const token = session?.token;
  useEffect(() => {
    if (!token) return;
    void load();
    return openEventStream({
      url: `${API_URL}/stream`,
      token,
      onEvent: (e) => bus.emit(e),
      onState: setStream,
      onUnauthorized: clearSession,
      onReconnect: () => bus.resync(),
    });
  }, [token, bus, load]);

  if (!session) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10" aria-busy>
        <Skeleton className="h-10 w-48" />
      </div>
    );
  }

  const vault =
    vaults.status === 'ready' ? (vaults.data.find((v) => v.id === selectedId) ?? null) : null;

  return (
    <BusContext.Provider value={bus}>
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link href="/" aria-label="ChainGuard home">
            <Logo />
          </Link>
          <div className="flex items-center gap-2 sm:gap-3">
            <span
              role="status"
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
                stream === 'live'
                  ? 'bg-emerald-400/10 text-emerald-200 ring-emerald-400/30'
                  : 'bg-amber-400/10 text-amber-100 ring-amber-400/30',
              )}
            >
              <span
                className={clsx(
                  'size-1.5 rounded-full',
                  stream === 'live' ? 'animate-pulse bg-emerald-300' : 'bg-amber-200',
                )}
                aria-hidden
              />
              {stream === 'live'
                ? 'Live'
                : stream === 'connecting'
                  ? 'Connecting…'
                  : 'Reconnecting…'}
            </span>
            <span
              className="hidden max-w-48 truncate text-sm text-muted md:inline"
              title={session.user.email}
            >
              {session.user.name ?? session.user.email}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                clearSession();
                router.replace('/');
              }}
            >
              <LogOut className="size-3.5" aria-hidden />{' '}
              <span className="hidden sm:inline">Sign out</span>
              <span className="sr-only sm:hidden">Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6">
        {vaults.status === 'loading' && (
          <div className="flex flex-col gap-4" aria-label="Loading dashboard">
            <Skeleton className="h-36" />
            <div className="grid gap-4 lg:grid-cols-3">
              <Skeleton className="h-96 lg:col-span-2" />
              <Skeleton className="h-96" />
            </div>
          </div>
        )}
        {vaults.status === 'error' && (
          <ErrorState message={vaults.message} onRetry={() => void load()} />
        )}
        {vaults.status === 'ready' && vaults.data.length === 0 && (
          <EmptyState icon={<Vault className="size-8" />} title="No vaults monitored">
            Enable the sandbox (SANDBOX_ENABLED) or configure LIVE_VAULT_ADDRESS on the API.
          </EmptyState>
        )}

        {vaults.status === 'ready' && vaults.data.length > 1 && (
          <nav aria-label="Monitored vaults" className="flex gap-2 overflow-x-auto">
            {vaults.data.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-current={v.id === selectedId ? 'page' : undefined}
                onClick={() => setSelectedId(v.id)}
                className="h-9 shrink-0 rounded-lg border border-line px-3 text-sm text-muted hover:text-ink aria-[current=page]:border-emerald-400/40 aria-[current=page]:bg-emerald-400/10 aria-[current=page]:text-ink"
              >
                {v.name}
              </button>
            ))}
          </nav>
        )}

        {vault && (
          <>
            <VaultOverview key={`overview-${vault.id}`} vault={vault} />
            {/* One instance of each panel; CSS order puts the simulator above the feed on phones. */}
            <div className="grid items-start gap-5 lg:grid-cols-3">
              <div className="order-2 min-w-0 lg:order-none lg:col-span-2">
                <AlertFeed vaultId={vault.id} />
              </div>
              <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-5">
                {vault.simulatable && (
                  <div className="order-1 min-w-0 lg:order-none">
                    <SimulationPanel />
                  </div>
                )}
                <div className="order-3 min-w-0 lg:order-none">
                  <SummaryTiles vaultId={vault.id} />
                </div>
                <div className="order-4 min-w-0 lg:order-none">
                  <RulesCard config={config} />
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </BusContext.Provider>
  );
}
