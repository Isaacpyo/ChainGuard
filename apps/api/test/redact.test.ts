import { HttpRequestError, WebSocketRequestError } from 'viem';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { TokenService } from '../src/auth/tokens';
import { loadConfig } from '../src/config';
import type { Repos, VaultRow } from '../src/db/repos';
import { createLogger, redactUrls } from '../src/logger';
import { Broadcaster } from '../src/services/broadcaster';
import { VAULT } from './fixtures';

const KEY = 'aBcD1234SeCrEtKeY';
const ALCHEMY = `https://eth-sepolia.g.alchemy.com/v2/${KEY}`;
const rpcError = () =>
  new HttpRequestError({
    url: ALCHEMY,
    status: 429,
    body: { method: 'eth_blockNumber', params: [] },
    details: 'Too Many Requests',
  });

/** A logger whose JSON lines land in `lines`. */
const capture = () => {
  const lines: string[] = [];
  return { lines, log: createLogger('info', false, { write: (s: string) => lines.push(s) }) };
};

describe('redactUrls', () => {
  it('keeps the host and drops the path holding the API key', () => {
    const message = rpcError().message;
    expect(message).toContain(KEY); // viem puts the whole URL in the message
    expect(redactUrls(message)).not.toContain(KEY);
    expect(redactUrls(message)).toContain('URL: https://eth-sepolia.g.alchemy.com/[redacted]');
    expect(redactUrls(`wss://eth-sepolia.g.alchemy.com/v2/${KEY}`)).toBe(
      'wss://eth-sepolia.g.alchemy.com/[redacted]',
    );
  });

  it('drops credentials and query strings, leaves bare URLs alone', () => {
    expect(redactUrls('rediss://default:hunter2@eu1.upstash.io:6379')).toBe(
      'rediss://eu1.upstash.io:6379',
    );
    expect(redactUrls(`https://rpc.example.com?apikey=${KEY}`)).toBe(
      'https://rpc.example.com/[redacted]',
    );
    expect(redactUrls('sandbox RPC not reachable at http://127.0.0.1:8545')).toBe(
      'sandbox RPC not reachable at http://127.0.0.1:8545',
    );
  });
});

describe('logged errors', () => {
  it('never carry the RPC key, in any field or cause', () => {
    const { lines, log } = capture();
    log.warn({ err: rpcError() }, 'could not read vault state');
    log.error({ err: new Error('pause failed', { cause: rpcError() }) }, 'guardian');
    log.warn({ err: new WebSocketRequestError({ url: `wss://x.alchemy.com/v2/${KEY}` }) }, 'ws');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).not.toContain(KEY);
    const first = JSON.parse(lines[0]!) as { err: { type: string; url: string; status: number } };
    expect(first.err).toMatchObject({
      type: 'HttpRequestError',
      url: 'https://eth-sepolia.g.alchemy.com/[redacted]',
      status: 429,
    });
  });

  it('are redacted in request logs too (vault state route)', async () => {
    const { lines, log } = capture();
    const config = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'x'.repeat(32),
    });
    const tokens = new TokenService(config.JWT_SECRET);
    const vault = { id: '7b7c5f6a-63b3-4f4b-9d43-2f9a2b1c0d11', address: VAULT } as VaultRow;
    const app = await buildApp({
      config,
      log,
      repos: { vaults: { get: async () => vault } } as unknown as Repos,
      tokens,
      broadcaster: new Broadcaster(),
      simulations: null,
      vaultReader: () => ({
        read: async () => {
          throw rpcError();
        },
      }),
      providerFor: () => 'alchemy',
      health: { db: async () => true, redis: async () => true },
    });
    const token = await tokens.sign({ sub: 'user-1', email: 'a@b.co' });
    const res = await app.inject({
      method: 'GET',
      url: `/vaults/${vault.id}/state`,
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();
    expect(res.statusCode).toBe(502);
    const logged = lines.filter((l) => l.includes('vault state read failed'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('eth-sepolia.g.alchemy.com/[redacted]');
    expect(logged[0]).not.toContain(KEY);
  });
});
