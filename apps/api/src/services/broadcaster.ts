import type { StreamEvent } from '@chainguard/shared';
import { EventEmitter } from 'node:events';
import type { ResponseEvent } from '../streams/events';

type Listener = (event: StreamEvent) => void;
type GuardianListener = (event: ResponseEvent & { network: string }) => void;

/**
 * In-process fan-out to SSE connections (and the simulator). One API instance
 * per deployment on the free tier; scaling out would put a per-instance XREAD
 * tail or Redis pub/sub here.
 */
export class Broadcaster {
  readonly #emitter = new EventEmitter();

  constructor() {
    this.#emitter.setMaxListeners(0);
  }

  publish(event: StreamEvent): void {
    this.#emitter.emit('event', event);
  }

  subscribe(listener: Listener): () => void {
    this.#emitter.on('event', listener);
    return () => this.#emitter.off('event', listener);
  }

  publishGuardian(event: ResponseEvent & { network: string }): void {
    this.#emitter.emit('guardian', event);
  }

  onGuardian(listener: GuardianListener): () => void {
    this.#emitter.on('guardian', listener);
    return () => this.#emitter.off('guardian', listener);
  }

  get listenerCount(): number {
    return this.#emitter.listenerCount('event');
  }
}
