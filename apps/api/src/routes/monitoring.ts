import {
  ALERT_STATUSES,
  SEVERITIES,
  SEVERITY_BANDS,
  type ConfigDto,
  type StreamEvent,
  type VaultDto,
} from '@chainguard/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { toVaultStateDto } from '../chain/vault';
import { decodeCursor, type VaultRow } from '../db/repos';
import { HttpError, parse, requireAuth, uuidParam } from '../http';
import { SimulationBusyError } from '../services/simulation';
import { describeRules } from '../watcher/rules';
import type { AppDeps } from '../app';

const AlertsQuery = z.object({
  vaultId: z.uuid().optional(),
  severity: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',') : undefined))
    .pipe(z.array(z.enum(SEVERITIES)).optional()),
  status: z.enum(ALERT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

const AlertPatch = z.object({ status: z.enum(ALERT_STATUSES) });

const EXPLORERS: Record<string, string> = { sepolia: 'https://sepolia.etherscan.io/address/' };

export async function monitoringRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { repos, tokens, config, broadcaster, simulations } = deps;
  const auth = { preHandler: requireAuth(tokens) };

  const toVaultDto = (v: VaultRow): VaultDto => ({
    id: v.id,
    slug: v.slug,
    name: v.name,
    network: v.network,
    chainId: v.chain_id,
    address: v.address,
    provider: deps.providerFor(v),
    explorerUrl: EXPLORERS[v.network] ? `${EXPLORERS[v.network]}${v.address}` : null,
    simulatable: v.network === 'sandbox' && simulations !== null,
  });

  app.get('/config', async (): Promise<ConfigDto> => {
    const rules = {
      largeWithdrawalBps: config.LARGE_WITHDRAWAL_BPS,
      rapidRepeatCount: config.RAPID_REPEAT_COUNT,
      rapidRepeatWindowSec: config.RAPID_REPEAT_WINDOW_SEC,
      pauseThreshold: config.PAUSE_THRESHOLD,
    };
    return {
      pauseThreshold: config.PAUSE_THRESHOLD,
      rules: describeRules(rules),
      severityBands: SEVERITY_BANDS,
      sandbox: {
        enabled: config.SANDBOX_ENABLED,
        forked: Boolean(config.SANDBOX_FORK_URL),
        blockTimeSeconds: config.SANDBOX_BLOCK_TIME,
      },
      live: { provider: config.LIVE_PROVIDER === 'off' ? 'off' : config.LIVE_PROVIDER },
    };
  });

  app.get('/vaults', auth, async () => (await repos.vaults.list()).map(toVaultDto));

  app.get('/vaults/:id/state', auth, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const vault = await repos.vaults.get(id);
    if (!vault) throw new HttpError(404, 'not_found', 'Vault not found');
    const reader = deps.vaultReader(vault);
    if (!reader) throw new HttpError(503, 'unavailable', 'No chain connection for this vault');
    try {
      return toVaultStateDto(await reader.read());
    } catch (err) {
      req.log.warn({ err }, 'vault state read failed');
      throw new HttpError(502, 'chain_unavailable', 'Could not reach the chain for this vault');
    }
  });

  app.get('/alerts', auth, async (req) => {
    const q = parse(AlertsQuery, req.query);
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !cursor) throw new HttpError(400, 'invalid_request', 'Invalid cursor');
    return repos.alerts.list({
      vaultId: q.vaultId,
      severities: q.severity,
      status: q.status,
      limit: q.limit,
      cursor,
    });
  });

  app.get('/alerts/summary', auth, async (req) => {
    const { vaultId } = parse(z.object({ vaultId: z.uuid().optional() }), req.query);
    return repos.alerts.summary(vaultId);
  });

  app.patch('/alerts/:id', auth, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const { status } = parse(AlertPatch, req.body);
    const alert = await repos.alerts.setStatus(id, status, req.userId);
    if (!alert) throw new HttpError(404, 'not_found', 'Alert not found');
    broadcaster.publish({ type: 'alert.updated', alert });
    return alert;
  });

  app.post(
    '/simulations',
    {
      ...auth,
      config: {
        // Runs before auth, so key on the bearer token (one bucket per session) or IP.
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.headers.authorization ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      if (!simulations)
        throw new HttpError(503, 'sandbox_disabled', 'The sandbox chain is not enabled');
      try {
        const sim = await simulations.start(req.userId);
        reply.code(202);
        return sim;
      } catch (err) {
        if (err instanceof SimulationBusyError) {
          throw new HttpError(
            409,
            'simulation_running',
            'A simulation is already running — watch the feed',
          );
        }
        throw err;
      }
    },
  );

  app.get('/simulations', auth, async (req) => {
    const { limit } = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }),
      req.query,
    );
    return repos.simulations.list(limit);
  });

  app.get('/simulations/:id', auth, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const sim = await repos.simulations.get(id);
    if (!sim) throw new HttpError(404, 'not_found', 'Simulation not found');
    return sim;
  });

  /**
   * Server-sent events. Clients read it with fetch() streaming so the bearer token
   * travels in a header rather than the URL (EventSource cannot set headers).
   */
  app.get('/stream', auth, (req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    const corsHeaders = Object.fromEntries(
      Object.entries(reply.getHeaders()).filter(
        (e): e is [string, string | number | string[]] => e[1] !== undefined,
      ),
    );
    raw.writeHead(200, {
      ...corsHeaders, // set by the CORS plugin before the handler ran
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write('retry: 3000\n\n');
    const send = (event: StreamEvent) =>
      raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const off = broadcaster.subscribe(send);
    const ping = setInterval(() => raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      off();
      clearInterval(ping);
    });
  });
}
