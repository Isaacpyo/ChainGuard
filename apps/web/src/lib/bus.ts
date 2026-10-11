'use client';

import type { StreamEvent } from '@chainguard/shared';
import { createContext, useContext, useEffect, useRef, useState } from 'react';

/** Fan-out of the single SSE connection to every panel that cares. */
export class EventBus {
  readonly #listeners = new Set<(event: StreamEvent) => void>();

  emit(event: StreamEvent): void {
    for (const l of this.#listeners) l(event);
  }

  on(listener: (event: StreamEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

export const BusContext = createContext<EventBus | null>(null);

export function useStreamEvent(handler: (event: StreamEvent) => void): void {
  const bus = useContext(BusContext);
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => bus?.on((e) => ref.current(e)), [bus]);
}

/** Re-renders every `intervalMs` so relative timestamps stay fresh. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function timeAgo(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export type Loadable<T> =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };
