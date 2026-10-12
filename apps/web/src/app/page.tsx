'use client';

import { Activity, Lock, Timer, Zap } from 'lucide-react';
import { useEffect } from 'react';
import { AuthPanel } from '@/components/AuthPanel';
import { Logo } from '@/components/Logo';
import { api } from '@/lib/api';

const features = [
  {
    icon: Activity,
    title: 'Mempool watcher',
    body: 'Decodes every pending call to the vault with viem and scores it against detection rules.',
  },
  {
    icon: Zap,
    title: 'Auto-pause guardian',
    body: 'Above the threshold, the guardian outbids the attacker so pause() lands first in the block.',
  },
  {
    icon: Timer,
    title: 'Rate-limited vault',
    body: 'A token-bucket withdrawal limit caps losses even if every off-chain defence fails.',
  },
  {
    icon: Lock,
    title: 'Timelocked admin',
    body: 'Role grants, limit changes and unpausing wait out a delay that guardians can veto.',
  },
];

export default function Home() {
  // Start waking the free-tier API while the visitor reads the page.
  useEffect(() => {
    void api.health().catch(() => undefined);
  }, []);

  return (
    <main
      id="main"
      className="mx-auto flex min-h-[calc(100dvh-1px)] max-w-6xl flex-col px-4 py-10 sm:px-6 lg:py-16"
    >
      {/* DOM order intro → sign-in → features keeps the demo button above the fold on phones. */}
      <div className="grid flex-1 items-start gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:gap-x-16">
        <section className="flex flex-col gap-8 lg:col-start-1">
          <Logo size="lg" />
          <div className="flex flex-col gap-4">
            <h1 className="text-balance text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-5xl">
              Stop the drain <span className="text-emerald-300">before</span> it lands.
            </h1>
            <p className="max-w-xl text-pretty text-base leading-relaxed text-muted sm:text-lg">
              ChainGuard watches pending transactions to a smart-contract vault, scores them in
              milliseconds and pauses the contract from a guardian key when an attack shows up in
              the mempool. Try it: the demo fires a real drain attack at a vault on a local chain.
            </p>
          </div>
        </section>
        <div className="lg:sticky lg:top-10 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <AuthPanel />
        </div>
        <ul className="grid gap-3 sm:grid-cols-2 lg:col-start-1" aria-label="How it works">
          {features.map(({ icon: Icon, title, body }) => (
            <li key={title} className="rounded-xl border border-line bg-panel/60 p-4">
              <div className="mb-2 flex items-center gap-2 font-medium text-ink">
                <Icon className="size-4 text-emerald-300" aria-hidden /> {title}
              </div>
              <p className="text-sm leading-relaxed text-muted">{body}</p>
            </li>
          ))}
        </ul>
      </div>
      <footer className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-xs text-muted">
        <span>Solidity · Foundry · viem · Redis Streams · PostgreSQL · Next.js</span>
        <a
          href="https://github.com/temitopeagbola/ChainGuard"
          className="underline decoration-line-strong underline-offset-4 hover:text-ink"
        >
          Source on GitHub
        </a>
      </footer>
    </main>
  );
}
