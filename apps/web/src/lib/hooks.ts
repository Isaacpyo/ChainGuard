'use client';

import { useSyncExternalStore } from 'react';
import { getServerStatus, subscribeServerStatus, type ServerStatus } from './server-status';
import { getSession, subscribeSession, type Session } from './session';

export function useServerStatus(): ServerStatus {
  return useSyncExternalStore(subscribeServerStatus, getServerStatus, () => 'unknown');
}

/** undefined while hydrating (no access to localStorage on the server render). */
export function useSession(): Session | null | undefined {
  return useSyncExternalStore(subscribeSession, getSession, () => undefined);
}
