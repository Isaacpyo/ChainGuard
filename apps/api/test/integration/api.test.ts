import type { AlertDto, AlertPage, AuthResponse, VaultDto } from '@chainguard/shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { TokenService } from '../../src/auth/tokens';
import { loadConfig } from '../../src/config';
import { createRepos } from '../../src/db/repos';
import { registerVaults, seedDemo } from '../../src/db/seed';
import { silentLogger } from '../../src/logger';
import { Broadcaster } from '../../src/services/broadcaster';
import { ADMIN, ATTACKER, OPS, VAULT, vaultState } from '../fixtures';
import { DATABASE_URL, REDIS_URL, describeInfra, isolatedDb } from './helpers';

describeInfra('HTTP API', () => {
  let app: FastifyInstance;
  let drop: () => Promise<void>;
  let redis: Redis;
  const broadcaster = new Broadcaster();
  const ORIGIN = 'https://chainguard.example.com';

  beforeAll(async () => {
    const isolated = await isolatedDb();
    drop = isolated.drop;
    redis = new Redis(REDIS_URL!);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: DATABASE_URL!,
      REDIS_URL: REDIS_URL!,
      JWT_SECRET: 'test-secret-test-secret-test-secret!',
      CORS_ORIGINS: ORIGIN,
    });
    const [sandbox] = await registerVaults(isolated.db, [
      {
        slug: 'sandbox-treasury',
        name: 'Sandbox Treasury',
        network: 'sandbox',
        chainId: 31337,
        address: VAULT,
        knownCallers: [OPS],
      },
    ]);
    await seedDemo(
      isolated.db,
      {
        demoEmail: config.DEMO_EMAIL,
        sandbox: sandbox!,
        attacker: ATTACKER,
        ops: OPS,
        admin: ADMIN,
      },
      silentLogger,
    );
    app = await buildApp({
      config,
      log: silentLogger,
      repos: createRepos(isolated.db),
      tokens: new TokenService(config.JWT_SECRET),
      broadcaster,
      simulations: null,
      vaultReader: () => ({ read: async () => vaultState({ paused: true }) }),
      providerFor: () => 'anvil',
      health: {
        db: async () => (await isolated.db.query('SELECT 1')).rowCount === 1,
        redis: async () => (await redis.ping()) === 'PONG',
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    await drop?.();
  });

  const demoToken = async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/demo' });
    return (res.json() as AuthResponse).token;
  };
  const authed = (token: string) => ({ authorization: `Bearer ${token}` });

  it('reports health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      checks: { db: true, redis: true, sandbox: null },
    });
  });

  describe('auth', () => {
    it('signs into the demo account in one click', async () => {
      const token = await demoToken();
      const me = await app.inject({ method: 'GET', url: '/me', headers: authed(token) });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ email: 'demo@chainguard.dev', isDemo: true });
    });

    it('registers, rejects duplicates and logs in', async () => {
      const body = { email: 'Ada@Example.com', password: 'a-long-enough-password', name: 'Ada' };
      const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: body });
      expect(reg.statusCode).toBe(201);
      expect((reg.json() as AuthResponse).user).toMatchObject({
        email: 'ada@example.com',
        name: 'Ada',
        isDemo: false,
      });

      const dup = await app.inject({ method: 'POST', url: '/auth/register', payload: body });
      expect(dup.statusCode).toBe(409);

      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'ADA@example.com', password: body.password },
      });
      expect(login.statusCode).toBe(200);
      expect((login.json() as AuthResponse).token).toBeTruthy();

      const wrong = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'ada@example.com', password: 'nope-nope-nope' },
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toMatchObject({ error: 'invalid_credentials' });
    });

    it('validates input at the boundary', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'not-an-email', password: 'short' },
      });
      expect(res.statusCode).toBe(400);
      const paths = (res.json() as { details: { path: string }[] }).details.map((d) => d.path);
      expect(paths).toEqual(expect.arrayContaining(['email', 'password']));
    });

    it('does not allow password login to the demo account', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'demo@chainguard.dev', password: 'anything-at-all' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects requests without a valid token', async () => {
      expect((await app.inject({ method: 'GET', url: '/vaults' })).statusCode).toBe(401);
      const bad = await app.inject({ method: 'GET', url: '/vaults', headers: authed('garbage') });
      expect(bad.statusCode).toBe(401);
    });
  });

  describe('monitoring', () => {
    let token: string;
    beforeAll(async () => {
      token = await demoToken();
    });

    it('lists vaults and reads on-chain state', async () => {
      const vaults = (
        await app.inject({ method: 'GET', url: '/vaults', headers: authed(token) })
      ).json() as VaultDto[];
      expect(vaults).toEqual([
        expect.objectContaining({
          slug: 'sandbox-treasury',
          network: 'sandbox',
          simulatable: false,
          provider: 'anvil',
        }),
      ]);
      const state = await app.inject({
        method: 'GET',
        url: `/vaults/${vaults[0]!.id}/state`,
        headers: authed(token),
      });
      expect(state.json()).toMatchObject({
        deployed: true,
        paused: true,
        balanceWei: '100000000000000000000',
      });

      const missing = await app.inject({
        method: 'GET',
        url: '/vaults/00000000-0000-4000-8000-000000000000/state',
        headers: authed(token),
      });
      expect(missing.statusCode).toBe(404);
      const invalid = await app.inject({
        method: 'GET',
        url: '/vaults/not-a-uuid/state',
        headers: authed(token),
      });
      expect(invalid.statusCode).toBe(400);
    });

    it('pages through seeded alerts newest-first with a keyset cursor', async () => {
      const first = (
        await app.inject({ method: 'GET', url: '/alerts?limit=3', headers: authed(token) })
      ).json() as AlertPage;
      expect(first.items).toHaveLength(3);
      expect(first.nextCursor).toBeTruthy();
      const second = (
        await app.inject({
          method: 'GET',
          url: `/alerts?limit=3&cursor=${first.nextCursor}`,
          headers: authed(token),
        })
      ).json() as AlertPage;
      const all = [...first.items, ...second.items];
      expect(new Set(all.map((a) => a.id)).size).toBe(6);
      const times = all.map((a) => Date.parse(a.detectedAt));
      expect(times).toEqual([...times].sort((a, b) => b - a));

      const bad = await app.inject({
        method: 'GET',
        url: '/alerts?cursor=zzz',
        headers: authed(token),
      });
      expect(bad.statusCode).toBe(400);

      // Well-formed enough to reach Postgres before, where the casts failed with a 500.
      for (const forged of [
        `2026-01-01T00:00:00Z|${'-'.repeat(36)}`,
        `2020|${first.items[0]!.id}`,
      ]) {
        const res = await app.inject({
          method: 'GET',
          url: `/alerts?cursor=${Buffer.from(forged).toString('base64url')}`,
          headers: authed(token),
        });
        expect(res.statusCode, forged).toBe(400);
      }
    });

    it('filters by severity', async () => {
      const page = (
        await app.inject({
          method: 'GET',
          url: '/alerts?severity=critical,high',
          headers: authed(token),
        })
      ).json() as AlertPage;
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((a) => a.severity === 'critical' || a.severity === 'high')).toBe(
        true,
      );
      const invalid = await app.inject({
        method: 'GET',
        url: '/alerts?severity=apocalyptic',
        headers: authed(token),
      });
      expect(invalid.statusCode).toBe(400);
    });

    it('acknowledges an alert and pushes the update over SSE', async () => {
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const controller = new AbortController();
      const stream = await fetch(`${address}/stream`, {
        headers: authed(token),
        signal: controller.signal,
      });
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      const reader = stream.body!.getReader();

      const page = (
        await app.inject({
          method: 'GET',
          url: '/alerts?status=open&severity=critical',
          headers: authed(token),
        })
      ).json() as AlertPage;
      const target = page.items[0]!;
      const patched = await app.inject({
        method: 'PATCH',
        url: `/alerts/${target.id}`,
        headers: authed(token),
        payload: { status: 'acknowledged' },
      });
      expect(patched.statusCode).toBe(200);
      const me = (
        await app.inject({ method: 'GET', url: '/me', headers: authed(token) })
      ).json() as { id: string };
      expect(patched.json()).toMatchObject({ status: 'acknowledged', acknowledgedBy: me.id });

      let text = '';
      const decoder = new TextDecoder();
      while (!text.includes('event: alert.updated')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      controller.abort();
      const data = text.split('event: alert.updated\ndata: ')[1]!.split('\n')[0]!;
      expect((JSON.parse(data) as { alert: AlertDto }).alert.id).toBe(target.id);

      const invalid = await app.inject({
        method: 'PATCH',
        url: `/alerts/${target.id}`,
        headers: authed(token),
        payload: { status: 'deleted' },
      });
      expect(invalid.statusCode).toBe(400);
    });

    it('summarises alerts by severity', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/alerts/summary',
        headers: authed(token),
      });
      const summary = res.json() as { total: number; bySeverity: Record<string, number> };
      expect(summary.total).toBe(7);
      expect(summary.bySeverity.info).toBe(2);
    });

    it('serves the public detection config', async () => {
      const res = await app.inject({ method: 'GET', url: '/config' });
      expect(res.json()).toMatchObject({ pauseThreshold: 70, live: { provider: 'off' } });
    });

    it('returns 503 for simulations when the sandbox is disabled', async () => {
      const res = await app.inject({ method: 'POST', url: '/simulations', headers: authed(token) });
      expect(res.statusCode).toBe(503);
    });
  });

  it('applies the CORS allowlist', async () => {
    const preflight = (origin: string) =>
      app.inject({
        method: 'OPTIONS',
        url: '/alerts',
        headers: { origin, 'access-control-request-method': 'GET' },
      });
    expect((await preflight(ORIGIN)).headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(
      (await preflight('https://evil.example')).headers['access-control-allow-origin'],
    ).toBeUndefined();
  });
});
