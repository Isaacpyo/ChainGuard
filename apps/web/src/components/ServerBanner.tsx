'use client';

import { Loader2, WifiOff } from 'lucide-react';
import { api } from '@/lib/api';
import { useServerStatus } from '@/lib/hooks';
import { Button } from './ui';

/** Explains slow first requests while the free-tier API instance boots. */
export function ServerBanner() {
  const status = useServerStatus();

  if (status === 'waking') {
    return (
      <div
        role="status"
        className="border-b border-amber-400/20 bg-amber-400/10 px-4 py-2.5 text-sm text-amber-100"
      >
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
          <p>
            <strong className="font-semibold">Waking the server…</strong>{' '}
            <span className="text-amber-100/80">
              The API runs on a free tier that sleeps when idle — the first request can take up to a
              minute.
            </span>
          </p>
        </div>
      </div>
    );
  }

  if (status === 'down') {
    return (
      <div
        role="alert"
        className="border-b border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-100"
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
          <WifiOff className="size-4 shrink-0" aria-hidden />
          <p className="flex-1">The ChainGuard API is not responding right now.</p>
          <Button size="sm" onClick={() => void api.health().catch(() => undefined)}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
