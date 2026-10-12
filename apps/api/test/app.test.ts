import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { TokenService } from '../src/auth/tokens';
import { loadConfig } from '../src/config';
import type { Repos } from '../src/db/repos';
import { silentLogger } from '../src/logger';
import { Broadcaster } from '../src/services/broadcaster';

/** The HTTP layer without a database: enough for routing, proxies and rate limits. */
async function app(env: Record<string, string> = {}): Promise<FastifyInstance> {
  const config = loadConfig({
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'x'.repeat(32),
    ...env,
  });
  const instance = await buildApp({
    config,
    log: silentLogger,
    repos: {} as Repos,
    tokens: new TokenService(config.JWT_SECRET),
    broadcaster: new Broadcaster(),
    simulations: null,
    vaultReader: () => null,
    providerFor: () => 'anvil',
    health: { db: async () => true, redis: async () => true },
  });
  instance.get('/test/ip', async (req) => ({ ip: req.ip }));
  return instance;
}

describe('client IP behind proxies', () => {
  let instance: FastifyInstance;
  afterEach(() => instance?.close());

  const CLIENT = '203.0.113.7';
  const ipOf = async (remoteAddress: string, forwardedFor?: string) => {
    const res = await instance.inject({
      method: 'GET',
      url: '/test/ip',
      remoteAddress,
      headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    });
    return (res.json() as { ip: string }).ip;
  };

  it('ignores X-Forwarded-For by default', async () => {
    instance = await app();
    expect(await ipOf(CLIENT, '198.51.100.1')).toBe(CLIENT);
  });

  it("takes the client Render's proxies saw, whatever the client prepends", async () => {
    instance = await app({ TRUST_PROXY: '3' });
    // Cloudflare appends the client, then Render's proxies their upstream: Cloudflare, internal.
    const render = `${CLIENT}, 172.71.1.1, 10.1.2.3`;
    expect(await ipOf('10.9.8.7', render)).toBe(CLIENT);
    expect(await ipOf('10.9.8.7', `198.51.100.1, ${render}`)).toBe(CLIENT);
    expect(await ipOf('10.9.8.7', `1.1.1.1, 8.8.8.8, ${render}`)).toBe(CLIENT);
  });

  it('rate-limits sign-in per client even when X-Forwarded-For is spoofed', async () => {
    instance = await app({ TRUST_PROXY: '3' });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await instance.inject({
        method: 'POST',
        url: '/auth/login',
        remoteAddress: '10.9.8.7',
        headers: { 'x-forwarded-for': `198.51.100.${i}, ${CLIENT}, 172.71.1.1, 10.1.2.3` },
        payload: {},
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true); // invalid body
    expect(statuses[10]).toBe(429);
  });
});
