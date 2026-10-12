import type { AuthResponse, UserDto } from '@chainguard/shared';

/**
 * Bearer token in localStorage. The API lives on a different site (Render vs
 * Netlify), where third-party cookies are increasingly blocked, so a header
 * token is the reliable option. Tokens expire after 12 hours.
 */
const KEY = 'chainguard.session';

export interface Session {
  token: string;
  user: UserDto;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: Session | null | undefined;

function read(): Session | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    return parsed.token && parsed.user ? (parsed as Session) : null;
  } catch {
    return null;
  }
}

export function getSession(): Session | null {
  if (typeof window === 'undefined') return null;
  if (cached === undefined) cached = read();
  return cached;
}

export function saveSession(auth: AuthResponse): void {
  cached = { token: auth.token, user: auth.user };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cached));
  } catch {
    // Private mode / storage disabled: the session lives for this tab only.
  }
  for (const l of listeners) l();
}

export function clearSession(): void {
  cached = null;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  for (const l of listeners) l();
}

export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
