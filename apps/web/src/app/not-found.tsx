import Link from 'next/link';
import { Logo } from '@/components/Logo';

export default function NotFound() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 px-4 text-center"
    >
      <Logo size="lg" />
      <p className="text-muted">That page does not exist.</p>
      <Link
        href="/"
        className="rounded-lg bg-emerald-400 px-4 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-300"
      >
        Back to the start
      </Link>
    </main>
  );
}
