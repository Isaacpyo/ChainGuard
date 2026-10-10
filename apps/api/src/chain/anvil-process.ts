import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '../logger';

export interface AnvilOptions {
  binary: string;
  rpcUrl: string;
  blockTime: number;
  forkUrl?: string | undefined;
}

/**
 * Runs anvil as a child process (Render: one container, no sidecars on the free
 * tier) and restarts it with backoff if it dies.
 */
export class AnvilProcess {
  #child: ChildProcess | null = null;
  #stopping = false;
  #restarts = 0;

  constructor(
    private readonly opts: AnvilOptions,
    private readonly log: Logger,
  ) {}

  args(): string[] {
    const url = new URL(this.opts.rpcUrl);
    const args = [
      '--host',
      url.hostname,
      '--port',
      url.port || '8545',
      '--block-time',
      String(this.opts.blockTime),
      '--order',
      'fees',
      // Keep the dev-key chain id even on a fork, so signed sandbox txs are never valid upstream.
      '--chain-id',
      '31337',
      '--silent',
    ];
    if (this.opts.forkUrl) args.push('--fork-url', this.opts.forkUrl);
    return args;
  }

  start(): void {
    this.#stopping = false;
    const child = spawn(this.opts.binary, this.args(), { stdio: ['ignore', 'ignore', 'pipe'] });
    this.#child = child;
    child.stderr?.on('data', (chunk: Buffer) =>
      this.log.warn({ anvil: chunk.toString().trim() }, 'anvil'),
    );
    child.on('error', (err) => this.log.error({ err }, 'failed to start anvil'));
    child.on('exit', (code, signal) => {
      this.#child = null;
      if (this.#stopping) return;
      const delay = Math.min(30_000, 1_000 * 2 ** this.#restarts++);
      this.log.error({ code, signal, delay }, 'anvil exited; restarting');
      setTimeout(() => !this.#stopping && this.start(), delay).unref();
    });
    this.log.info({ args: this.args().filter((a) => a !== this.opts.forkUrl) }, 'anvil started');
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3_000).unref();
    });
  }
}
