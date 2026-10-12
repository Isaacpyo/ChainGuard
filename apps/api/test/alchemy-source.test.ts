import { guardedVaultAbi } from '@chainguard/shared/abi';
import { encodeFunctionData, parseEther, toHex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { silentLogger } from '../src/logger';
import { AlchemyPendingSource, type PendingTx } from '../src/watcher/sources';
import { ATTACKER, VAULT, txHash } from './fixtures';

/**
 * A local stand-in for Alchemy's WebSocket endpoint, speaking the
 * alchemy_pendingTransactions protocol, so the real client code runs without a key.
 */
function fakeAlchemy() {
  const server = new WebSocketServer({ port: 0 });
  const subscriptions: unknown[][] = [];
  let client: WebSocket | null = null;
  server.on('connection', (socket) => {
    client = socket;
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string; params: unknown[] };
      if (msg.method === 'eth_subscribe') {
        subscriptions.push(msg.params);
        socket.send(
          JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: `0xsub${subscriptions.length}` }),
        );
      } else if (msg.method === 'eth_unsubscribe') {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: true }));
      }
      // Everything else (block polling) is left unanswered.
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    subscriptions,
    push(result: unknown) {
      client?.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_subscription',
          params: { subscription: '0xsub1', result },
        }),
      );
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('AlchemyPendingSource', () => {
  let cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanup) await fn();
    cleanup = [];
  });

  it('subscribes with a server-side address filter and decodes full transactions', async () => {
    const alchemy = fakeAlchemy();
    const source = new AlchemyPendingSource(alchemy.url, [VAULT], silentLogger);
    cleanup.push(() => source.stop(), alchemy.close);

    const received: PendingTx[] = [];
    await source.start((tx, stage) => stage === 'pending' && received.push(tx));

    expect(alchemy.subscriptions[0]).toEqual([
      'alchemy_pendingTransactions',
      { toAddress: [VAULT], hashesOnly: false },
    ]);

    const hash = txHash();
    const input = encodeFunctionData({
      abi: guardedVaultAbi,
      functionName: 'withdraw',
      args: [ATTACKER, parseEther('10')],
    });
    alchemy.push({
      hash,
      from: ATTACKER.toLowerCase(),
      to: VAULT.toLowerCase(),
      input,
      value: '0x0',
      gas: toHex(150_000),
      maxFeePerGas: toHex(30_000_000_000n),
      maxPriorityFeePerGas: toHex(1_000_000_000n),
      nonce: '0x1',
      type: '0x2',
    });

    await expect.poll(() => received.length).toBe(1);
    expect(received[0]).toEqual({
      hash,
      from: ATTACKER,
      to: VAULT,
      input,
      value: 0n,
      gasPrice: undefined,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
  });
});
