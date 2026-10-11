/**
 * Tracks whether the API is reachable. Render's free tier sleeps idle services,
 * so the first request after a while can take 30–60 s; the UI shows a friendly
 * "waking" banner instead of a frozen spinner.
 */
export type ServerStatus = 'unknown' | 'ready' | 'waking' | 'down';

type Listener = () => void;

let status: ServerStatus = 'unknown';
const listeners = new Set<Listener>();

export function getServerStatus(): ServerStatus {
  return status;
}

export function setServerStatus(next: ServerStatus): void {
  if (next === status) return;
  status = next;
  for (const l of listeners) l();
}

export function subscribeServerStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
