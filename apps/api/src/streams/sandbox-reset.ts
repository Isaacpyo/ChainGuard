import type { Redis } from 'ioredis';
import type { Logger } from '../logger';

/**
 * With ROLE=api and ROLE=watcher in separate processes, the API resets the sandbox chain
 * but the watcher holds its per-chain state: seen tx hashes and sender history. The rerun
 * attack has the same tx hashes as the last one, so a watcher that never hears about the
 * reset drops it as duplicates. This pub/sub notice tells it to forget.
 */
export const sandboxResetChannel = (streamKey: string) => `${streamKey}:sandbox-reset`;

export async function announceSandboxReset(redis: Redis, channel: string): Promise<void> {
  await redis.publish(channel, new Date().toISOString());
}

/** Calls `onReset` for every notice; resolves once subscribed. Returns a close function. */
export async function onSandboxReset(
  redis: Redis,
  channel: string,
  onReset: () => void,
  log: Logger,
): Promise<() => Promise<void>> {
  const sub = redis.duplicate(); // a subscribed connection cannot run other commands
  sub.on('error', (err: unknown) => log.warn({ err }, 'sandbox reset subscription error'));
  sub.on('message', (from: string) => {
    if (from !== channel) return;
    log.info('sandbox chain was reset; clearing watcher state');
    onReset();
  });
  await sub.subscribe(channel);
  return async () => {
    await sub.quit();
  };
}
