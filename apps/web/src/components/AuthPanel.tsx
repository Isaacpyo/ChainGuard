'use client';

import { ArrowRight, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { ApiError, api } from '@/lib/api';
import { useSession } from '@/lib/hooks';
import { saveSession } from '@/lib/session';
import { Button } from './ui';

type Mode = 'signin' | 'register';

function Field({
  label,
  error,
  ...input
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | undefined }) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        {...input}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="h-10 rounded-lg border border-line-strong bg-canvas px-3 text-sm text-ink placeholder:text-muted/60 aria-[invalid=true]:border-rose-400"
      />
      {error && (
        <p id={errorId} className="text-xs text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}

export function AuthPanel() {
  const router = useRouter();
  const session = useSession();
  const [mode, setMode] = useState<Mode>('signin');
  const [busy, setBusy] = useState<'demo' | 'form' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const enter = async (action: () => ReturnType<typeof api.demo>, kind: 'demo' | 'form') => {
    setBusy(kind);
    setError(null);
    setFieldErrors({});
    try {
      saveSession(await action());
      router.push('/dashboard/');
    } catch (err) {
      if (err instanceof ApiError && err.details) {
        setFieldErrors(Object.fromEntries(err.details.map((d) => [d.path, d.message])));
      }
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setBusy(null);
    }
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    const name = String(form.get('name') ?? '').trim();
    void enter(
      () =>
        mode === 'signin'
          ? api.login(email, password)
          : api.register(email, password, name || undefined),
      'form',
    );
  };

  if (session) {
    return (
      <div className="flex flex-col gap-4 rounded-2xl border border-line bg-panel/90 p-6">
        <p className="text-sm text-muted">
          Signed in as <span className="font-medium text-ink">{session.user.email}</span>
        </p>
        <Button variant="primary" size="lg" onClick={() => router.push('/dashboard/')}>
          Open dashboard <ArrowRight className="size-4" aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 rounded-2xl border border-line bg-panel/90 p-5 shadow-xl shadow-black/30 sm:p-6">
      <div className="flex flex-col gap-2">
        <Button
          variant="primary"
          size="lg"
          busy={busy === 'demo'}
          disabled={busy !== null}
          onClick={() => void enter(api.demo, 'demo')}
        >
          <Sparkles className="size-4" aria-hidden /> Try the demo
        </Button>
        <p className="text-center text-xs text-muted">
          One click, no sign-up. You get a shared demo analyst account.
        </p>
      </div>

      <div
        className="flex items-center gap-3 text-xs uppercase tracking-wider text-muted"
        aria-hidden
      >
        <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
      </div>

      <div
        role="tablist"
        aria-label="Account"
        className="grid grid-cols-2 gap-1 rounded-lg bg-canvas p-1"
      >
        {(['signin', 'register'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => {
              setMode(m);
              setError(null);
              setFieldErrors({});
            }}
            className="h-8 rounded-md text-sm font-medium text-muted aria-selected:bg-panel-raised aria-selected:text-ink"
          >
            {m === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        ))}
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {mode === 'register' && (
          <Field label="Name (optional)" name="name" autoComplete="name" maxLength={80} />
        )}
        <Field
          label="Email"
          name="email"
          type="email"
          required
          autoComplete="email"
          error={fieldErrors.email}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          required
          minLength={mode === 'register' ? 10 : undefined}
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          error={fieldErrors.password}
        />
        <div aria-live="polite" className="min-h-5 text-sm text-rose-300">
          {error && !Object.keys(fieldErrors).length ? error : null}
        </div>
        <Button type="submit" busy={busy === 'form'} disabled={busy !== null}>
          {mode === 'signin' ? 'Sign in' : 'Create account'}
        </Button>
      </form>
    </div>
  );
}
