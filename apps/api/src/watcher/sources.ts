import {
  createPublicClient,
  getAddress,
  isAddressEqual,
  webSocket,
  type Address,
  type Hex,
  type PublicClient,
  type Transaction,
  type WebSocketTransport,
} from 'viem';
import type { Logger } from '../logger';

/** The subset of a transaction the watcher needs. */
export interface PendingTx {
  hash: Hex;
  from: Address;
  to: Address | null;
  input: Hex;
  value: bigint;
  gasPrice?: bigint | undefined;
  maxFeePerGas?: bigint | undefined;
  maxPriorityFeePerGas?: bigint | undefined;
}

export type TxHandler = (tx: PendingTx, stage: 'pending' | 'mined') => void;

/** A stream of transactions addressed to the watched contract(s). */
export interface PendingTxSource {
  readonly name: string;
  start(onTx: TxHandler): Promise<void>;
  stop(): Promise<void>;
}

export function toPendingTx(tx: Transaction | RawRpcTx): PendingTx {
  const big = (v: unknown) => (v === undefined || v === null ? undefined : BigInt(v as string));
  return {
    hash: tx.hash as Hex,
    from: getAddress(tx.from as string),
    to: tx.to ? getAddress(tx.to as string) : null,
    input: tx.input as Hex,
    value: BigInt(tx.value as string | bigint),
    gasPrice: big(tx.gasPrice),
    maxFeePerGas: big(tx.maxFeePerGas),
    maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas),
  };
}

/** JSON-RPC transaction object (hex quantities), as pushed by alchemy_pendingTransactions. */
interface RawRpcTx {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  gasPrice?: string | null;
  maxFeePerGas?: string | null;
  maxPriorityFeePerGas?: string | null;
}

/**
 * Standard JSON-RPC: `eth_subscribe newPendingTransactions` (hashes) then
 * `eth_getTransactionByHash`, plus mined blocks as a safety net for transactions
 * that never hit the public mempool. Used against anvil; works on any node, but
 * on a busy public chain prefer the Alchemy source, which filters server-side.
 */
export class RpcPendingSource implements PendingTxSource {
  readonly name = 'rpc';
  #client: PublicClient<WebSocketTransport> | null = null;
  #unwatch: (() => void)[] = [];

  constructor(
    private readonly wsUrl: string,
    private readonly watched: () => Address[],
    private readonly log: Logger,
  ) {}

  async start(onTx: TxHandler): Promise<void> {
    const client = createPublicClient({
      transport: webSocket(this.wsUrl, { reconnect: { attempts: Infinity, delay: 1_000 } }),
    });
    this.#client = client;
    const isWatched = (to: Address | null) =>
      to !== null && this.watched().some((a) => isAddressEqual(a, to));

    this.#unwatch.push(
      client.watchPendingTransactions({
        onTransactions: (hashes) => {
          for (const hash of hashes) {
            client
              .getTransaction({ hash })
              .then((tx) => {
                if (isWatched(tx.to)) onTx(toPendingTx(tx), 'pending');
              })
              .catch((err: unknown) => this.log.debug({ err, hash }, 'pending tx lookup failed'));
          }
        },
        onError: (err) => this.log.warn({ err }, 'pending tx subscription error'),
      }),
      client.watchBlocks({
        includeTransactions: true,
        onBlock: (block) => {
          for (const tx of block.transactions) {
            if (isWatched(tx.to)) onTx(toPendingTx(tx), 'mined');
          }
        },
        onError: (err) => this.log.warn({ err }, 'block subscription error'),
      }),
    );
  }

  async stop(): Promise<void> {
    for (const unwatch of this.#unwatch) unwatch();
    this.#unwatch = [];
    // Closing the socket also ends viem's reconnect loop.
    const socket = await this.#client?.transport.getRpcClient().catch(() => null);
    socket?.close();
    this.#client = null;
  }
}

/**
 * Alchemy's `alchemy_pendingTransactions` subscription, filtered to the vault on
 * Alchemy's side and delivering full transaction objects — one message per
 * relevant transaction instead of one per mempool transaction.
 */
export class AlchemyPendingSource implements PendingTxSource {
  readonly name = 'alchemy';
  #client: PublicClient<WebSocketTransport> | null = null;
  #unsubscribe: (() => Promise<unknown>) | null = null;
  #unwatchBlocks: (() => void) | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly addresses: Address[],
    private readonly log: Logger,
  ) {}

  async start(onTx: TxHandler): Promise<void> {
    const client = createPublicClient({
      transport: webSocket(this.wsUrl, { reconnect: { attempts: Infinity, delay: 2_000 } }),
    });
    this.#client = client;

    const { unsubscribe } = await client.transport.subscribe({
      // Not in viem's typed method list; Alchemy-specific.
      params: [
        'alchemy_pendingTransactions',
        { toAddress: this.addresses, hashesOnly: false },
      ] as unknown as ['newPendingTransactions'],
      onData: (data: { result?: RawRpcTx }) => {
        if (data.result) onTx(toPendingTx(data.result), 'pending');
      },
      onError: (err: Error) => this.log.warn({ err }, 'alchemy subscription error'),
    });
    this.#unsubscribe = unsubscribe;

    this.#unwatchBlocks = client.watchBlocks({
      includeTransactions: true,
      onBlock: (block) => {
        for (const tx of block.transactions) {
          if (tx.to && this.addresses.some((a) => isAddressEqual(a, tx.to!))) {
            onTx(toPendingTx(tx), 'mined');
          }
        }
      },
      onError: (err) => this.log.warn({ err }, 'alchemy block subscription error'),
    });
  }

  async stop(): Promise<void> {
    this.#unwatchBlocks?.();
    await this.#unsubscribe?.().catch(() => undefined);
    const socket = await this.#client?.transport.getRpcClient().catch(() => null);
    socket?.close();
    this.#client = null;
  }
}

/**
 * In-memory source for tests and key-less local runs (LIVE_PROVIDER=mock).
 * Transactions are injected with `push`.
 */
export class MockPendingSource implements PendingTxSource {
  readonly name = 'mock';
  #onTx: TxHandler | null = null;
  #timer: NodeJS.Timeout | null = null;

  async start(onTx: TxHandler): Promise<void> {
    this.#onTx = onTx;
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#onTx = null;
  }

  /** Emits `next()` every `intervalMs` — scripted stand-in traffic when there is no RPC key. */
  replay(next: () => PendingTx, intervalMs: number): void {
    this.#timer = setInterval(() => this.push(next()), intervalMs);
    this.#timer.unref();
  }

  push(tx: PendingTx, stage: 'pending' | 'mined' = 'pending'): void {
    this.#onTx?.(tx, stage);
  }
}
