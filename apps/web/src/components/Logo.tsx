import { ShieldCheck } from 'lucide-react';

export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight text-ink">
      <span
        className={
          size === 'lg'
            ? 'grid size-12 place-items-center rounded-xl bg-emerald-400/10 ring-1 ring-emerald-400/30'
            : 'grid size-8 place-items-center rounded-lg bg-emerald-400/10 ring-1 ring-emerald-400/30'
        }
      >
        <ShieldCheck
          className={size === 'lg' ? 'size-6 text-emerald-300' : 'size-4.5 text-emerald-300'}
          aria-hidden
        />
      </span>
      <span className={size === 'lg' ? 'text-3xl sm:text-4xl' : 'text-base'}>ChainGuard</span>
    </span>
  );
}
