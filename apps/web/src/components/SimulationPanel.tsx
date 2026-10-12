'use client';

import {
  SIMULATION_STEPS,
  formatEth,
  shortAddress,
  type SimulationDto,
  type SimulationStep,
} from '@chainguard/shared';
import clsx from 'clsx';
import {
  CheckCircle2,
  Circle,
  Crosshair,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { timeAgo, useNow, useResync, useStreamEvent } from '@/lib/bus';
import { Button, Card, Mono } from './ui';

const STEP_LABELS: Record<SimulationStep, string> = {
  reset: 'Reset chain',
  deploy: 'Deploy vault',
  fund: 'Fund vault',
  benign: 'Normal activity',
  attack: 'Attack',
  response: 'Guardian response',
  settle: 'Outcome',
};

interface Progress {
  id: string;
  steps: Partial<Record<SimulationStep, string>>;
}

export function SimulationPanel() {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [last, setLast] = useState<SimulationDto | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();
  // Bumped whenever newer simulation state arrives, so a slower sync() cannot overwrite it.
  const version = useRef(0);

  /**
   * Reads the latest run: on mount, and after a stream reconnect, since a
   * `simulation.finished` sent during the gap would otherwise leave the panel stuck
   * on "running".
   */
  const sync = useCallback(() => {
    const v = ++version.current;
    api
      .simulations(1)
      .then(([latest]) => {
        if (!latest || v !== version.current) return;
        if (latest.status === 'running') {
          setProgress((p) => (p?.id === latest.id ? p : { id: latest.id, steps: {} }));
        } else {
          setProgress(null);
          setLast(latest);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(sync, [sync]);
  useResync(sync);

  useStreamEvent((e) => {
    if (e.type === 'simulation.step' || e.type === 'simulation.finished') version.current++;
    if (e.type === 'simulation.step') {
      setProgress((p) => ({
        id: e.simulationId,
        steps: { ...(p?.id === e.simulationId ? p.steps : {}), [e.step]: e.message },
      }));
    }
    if (e.type === 'simulation.finished') {
      setProgress(null);
      setLast(e.simulation);
    }
  });

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const sim = await api.simulate();
      version.current++;
      setProgress((p) => (p?.id === sim.id ? p : { id: sim.id, steps: {} }));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? 'A simulation is already running — follow it in the feed.'
          : (err as Error).message,
      );
    } finally {
      setStarting(false);
    }
  };

  const running = progress !== null;
  const currentIndex = running
    ? SIMULATION_STEPS.reduce((acc, s, i) => (progress.steps[s] ? i : acc), -1)
    : -1;

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Crosshair className="size-4 text-rose-300" aria-hidden /> Attack simulation
        </span>
      }
    >
      <p className="text-sm leading-relaxed text-muted">
        A leaked withdrawer key fires 5 × 10 ETH withdrawals at the vault on a local anvil chain.
        The watcher has one block (~2 s) to spot them in the mempool and land <Mono>pause()</Mono>{' '}
        first.
      </p>
      <Button
        variant="danger"
        size="lg"
        className="mt-4 w-full"
        busy={starting || running}
        onClick={() => void start()}
      >
        {running ? 'Simulation running…' : 'Simulate attack'}
      </Button>
      <div aria-live="polite" className="mt-2 min-h-5 text-sm text-rose-300">
        {error}
      </div>

      {running && (
        <ol className="mt-2 flex flex-col gap-2" aria-label="Simulation progress">
          {SIMULATION_STEPS.map((step, i) => {
            const message = progress.steps[step];
            const state =
              i < currentIndex || (message && step === 'settle')
                ? 'done'
                : i === currentIndex
                  ? 'active'
                  : 'todo';
            return (
              <li key={step} className="flex gap-2.5 text-sm">
                {state === 'done' && (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-300" aria-hidden />
                )}
                {state === 'active' && (
                  <Loader2
                    className="mt-0.5 size-4 shrink-0 animate-spin text-amber-200"
                    aria-hidden
                  />
                )}
                {state === 'todo' && (
                  <Circle className="mt-0.5 size-4 shrink-0 text-line-strong" aria-hidden />
                )}
                <div className="min-w-0">
                  <span
                    className={clsx('font-medium', state === 'todo' ? 'text-muted' : 'text-ink')}
                  >
                    {STEP_LABELS[step]}
                  </span>
                  <span className="sr-only">
                    {state === 'done' ? ' (done)' : state === 'active' ? ' (in progress)' : ''}
                  </span>
                  {message && <p className="break-words text-xs text-muted">{message}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {!running && last && (
        <SimulationResultView sim={last} ago={timeAgo(last.finishedAt ?? last.startedAt, now)} />
      )}
    </Card>
  );
}

function SimulationResultView({ sim, ago }: { sim: SimulationDto; ago: string }) {
  if (sim.status === 'failed' || !sim.result) {
    return (
      <div
        className="mt-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200"
        role="status"
      >
        Last run failed ({ago}): {sim.error ?? 'unknown error'}
      </div>
    );
  }
  const r = sim.result;
  const lost = BigInt(r.stolenWei);
  const safe = lost === 0n;
  return (
    <div className="mt-2 flex flex-col gap-3" data-testid="simulation-result">
      <div
        className={clsx(
          'rounded-xl p-4 ring-1 ring-inset',
          safe ? 'bg-emerald-400/10 ring-emerald-400/30' : 'bg-amber-400/10 ring-amber-400/30',
        )}
      >
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted">
          {safe ? (
            <ShieldCheck className="size-4 text-emerald-300" aria-hidden />
          ) : (
            <ShieldAlert className="size-4 text-amber-200" aria-hidden />
          )}
          Last run · {ago}
        </div>
        <p
          className={clsx(
            'mt-1 text-2xl font-semibold',
            safe ? 'text-emerald-200' : 'text-amber-100',
          )}
        >
          {formatEth(r.stolenWei)} ETH lost
        </p>
        <p className="text-sm text-muted">
          of {formatEth(r.attemptedWei)} ETH attempted
          {r.paused && r.detectionMs !== null && (
            <> · paused {r.detectionMs} ms after the attack hit the mempool</>
          )}
        </p>
        <p className="mt-2 text-xs text-muted">
          Rate limit alone would have capped the loss at {formatEth(r.rateLimitCapWei, 2)} ETH.
        </p>
      </div>
      {r.transactions.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line text-xs">
          {r.transactions.map((tx) => (
            <li key={tx.hash} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="flex min-w-0 items-center gap-2">
                {tx.status === 'success' ? (
                  <CheckCircle2
                    className={clsx(
                      'size-3.5 shrink-0',
                      tx.label.startsWith('Attack') ? 'text-rose-300' : 'text-emerald-300',
                    )}
                    aria-hidden
                  />
                ) : (
                  <XCircle className="size-3.5 shrink-0 text-muted" aria-hidden />
                )}
                <span className="truncate text-ink">{tx.label}</span>
                <Mono className="hidden text-muted sm:inline">{shortAddress(tx.hash, 4)}</Mono>
              </span>
              <span
                className={clsx('shrink-0', tx.status === 'reverted' ? 'text-muted' : 'text-ink')}
              >
                {tx.status === 'reverted' ? 'reverted' : tx.status}
                {tx.blockNumber && <span className="text-muted"> · #{tx.blockNumber}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
