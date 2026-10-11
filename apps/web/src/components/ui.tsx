'use client';

import type { Severity } from '@chainguard/shared';
import clsx from 'clsx';
import { AlertTriangle, Check, Copy, Loader2, RefreshCw } from 'lucide-react';
import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const variants: Record<Variant, string> = {
  primary: 'bg-emerald-400 text-emerald-950 hover:bg-emerald-300 disabled:bg-emerald-400/50',
  secondary:
    'border border-line-strong bg-panel-raised text-ink hover:border-muted/60 hover:bg-white/5 disabled:opacity-50',
  danger: 'bg-rose-500 text-white hover:bg-rose-400 disabled:bg-rose-500/50',
  ghost: 'text-muted hover:bg-white/5 hover:text-ink disabled:opacity-50',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed',
        size === 'sm' && 'h-8 px-3 text-xs',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'lg' && 'h-12 px-5 text-base',
        variants[variant],
        className,
      )}
    >
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Card({
  title,
  action,
  children,
  className,
  ...rest
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <section
      {...rest}
      className={clsx(
        'rounded-2xl border border-line bg-panel/90 shadow-lg shadow-black/20',
        className,
      )}
    >
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold tracking-wide text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

const severityStyles: Record<Severity, string> = {
  critical: 'bg-rose-500/15 text-rose-300 ring-rose-500/40',
  high: 'bg-orange-500/15 text-orange-300 ring-orange-500/40',
  medium: 'bg-amber-400/10 text-amber-200 ring-amber-400/30',
  low: 'bg-sky-400/10 text-sky-200 ring-sky-400/30',
  info: 'bg-slate-400/10 text-slate-300 ring-slate-400/25',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ring-1 ring-inset',
        severityStyles[severity],
      )}
    >
      {severity}
    </span>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'bad' | 'warn';
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        tone === 'neutral' && 'bg-white/5 text-muted ring-line-strong',
        tone === 'good' && 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/30',
        tone === 'bad' && 'bg-rose-500/10 text-rose-300 ring-rose-500/30',
        tone === 'warn' && 'bg-amber-400/10 text-amber-200 ring-amber-400/30',
      )}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-md bg-white/5', className)} aria-hidden />;
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <div className="text-muted" aria-hidden>
        {icon}
      </div>
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <AlertTriangle className="size-6 text-rose-400" aria-hidden />
      <p className="text-sm text-rose-200">{message}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          <RefreshCw className="size-3.5" aria-hidden /> Try again
        </Button>
      )}
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        });
      }}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-white/5 hover:text-ink"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
    >
      {copied ? (
        <Check className="size-3.5 text-emerald-300" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </button>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('font-mono text-[0.92em]', className)}>{children}</span>;
}
