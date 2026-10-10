import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { ChainProvider } from '@chainguard/shared';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { TokenService } from './auth/tokens';
import type { VaultStateReader } from './chain/vault';
import type { Config } from './config';
import type { Repos, VaultRow } from './db/repos';
import { HttpError } from './http';
import type { Logger } from './logger';
import { authRoutes } from './routes/auth';
import { monitoringRoutes } from './routes/monitoring';
import type { Broadcaster } from './services/broadcaster';
import type { SimulationRunner } from './services/simulation';

export interface HealthChecks {
  db: () => Promise<boolean>;
  redis: () => Promise<boolean>;
  sandbox?: (() => Promise<boolean>) | undefined;
}

export interface AppDeps {
  config: Config;
  log: Logger;
  repos: Repos;
  tokens: TokenService;
  broadcaster: Broadcaster;
  simulations: SimulationRunner | null;
  vaultReader: (vault: VaultRow) => VaultStateReader | null;
  providerFor: (vault: VaultRow) => ChainProvider;
  health: HealthChecks;
}

const startedAt = Date.now();

const withTimeout = (p: Promise<boolean>, ms = 2_000) =>
  Promise.race([p.catch(() => false), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    loggerInstance: deps.log as FastifyBaseLogger,
    trustProxy: true, // Render terminates TLS in front of us
    bodyLimit: 64 * 1024,
    forceCloseConnections: true, // SSE connections must not block shutdown
    disableRequestLogging: config.NODE_ENV === 'test',
  });

  const allowed = new Set(config.CORS_ORIGINS);
  await app.register(cors, {
    origin: (origin, cb) => {
      const local =
        config.NODE_ENV !== 'production' &&
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin ?? '');
      cb(null, !origin || allowed.has(origin) || local);
    },
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply
        .code(err.statusCode)
        .send({ error: err.code, message: err.message, details: err.details });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'bad_request', message: (err as Error).message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong on our side' });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: 'not_found', message: 'Not found' }),
  );

  app.get('/', async () => ({
    name: 'chainguard-api',
    docs: 'https://github.com/isaacpyo/ChainGuard',
  }));

  app.get('/health', async (_req, reply) => {
    const [db, redis, sandbox] = await Promise.all([
      withTimeout(deps.health.db()),
      withTimeout(deps.health.redis()),
      deps.health.sandbox ? withTimeout(deps.health.sandbox()) : Promise.resolve(null),
    ]);
    const ok = db && redis;
    reply.code(ok ? 200 : 503);
    return {
      status: ok ? 'ok' : 'degraded',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks: { db, redis, sandbox },
    };
  });

  await authRoutes(app, deps);
  await monitoringRoutes(app, deps);
  return app;
}
