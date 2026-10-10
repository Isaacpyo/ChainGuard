import { Redis } from 'ioredis';
import { createPublicClient, createWalletClient, getAddress, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { buildApp } from './app';
import { TokenService } from './auth/tokens';
import { AnvilProcess } from './chain/anvil-process';
import { Sandbox, SANDBOX_CHAIN_ID } from './chain/sandbox';
import {
  CachedVaultReader,
  ChainVaultReader,
  MockVaultReader,
  type VaultStateReader,
} from './chain/vault';
import { loadConfig, runsApi, runsWatcher, type Config } from './config';
import { createPool, migrate } from './db/pool';
import { createRepos, type VaultRow } from './db/repos';
import { registerVaults, seedDemo, type VaultRegistration } from './db/seed';
import { createLogger, type Logger } from './logger';
import { Broadcaster } from './services/broadcaster';
import { createIngestHandler } from './services/ingest';
import { SimulationRunner } from './services/simulation';
import { StreamConsumer, StreamPublisher } from './streams/redis-stream';
import { MockGuardian, ViemGuardian, type Guardian } from './watcher/guardian';
import {
  AlchemyPendingSource,
  MockPendingSource,
  RpcPendingSource,
  type PendingTxSource,
} from './watcher/sources';
import { MOCK_OPERATOR, mockLiveTraffic } from './watcher/mock-traffic';
import { Watcher } from './watcher/watcher';

const MOCK_LIVE_VAULT: Address = '0x00000000000000000000000000000000C0FFEE01';
const SEPOLIA_CHAIN_ID = 11_155_111;

interface LiveSetup {
  registration: VaultRegistration;
  reader: VaultStateReader;
  source: PendingTxSource;
  guardian: Guardian | undefined;
}

function liveSetup(config: Config, log: Logger): LiveSetup | null {
  if (config.LIVE_PROVIDER === 'off') return null;
  const registration = (address: Address, extraKnown: Address[] = []): VaultRegistration => ({
    slug: 'sepolia-treasury',
    name: config.LIVE_PROVIDER === 'mock' ? 'Sepolia Treasury (mock feed)' : 'Sepolia Treasury',
    network: 'sepolia',
    chainId: SEPOLIA_CHAIN_ID,
    address,
    knownCallers: [...extraKnown, ...config.LIVE_KNOWN_CALLERS.map((a) => getAddress(a))],
  });

  if (config.LIVE_PROVIDER === 'mock') {
    const reader = new MockVaultReader();
    const source = new MockPendingSource();
    source.replay(mockLiveTraffic(MOCK_LIVE_VAULT), 30_000);
    return {
      registration: registration(MOCK_LIVE_VAULT, [MOCK_OPERATOR]),
      reader,
      source,
      guardian: new MockGuardian(reader),
    };
  }

  const address = getAddress(config.LIVE_VAULT_ADDRESS!);
  const client = createPublicClient({ chain: sepolia, transport: http(config.SEPOLIA_RPC_URL) });
  const guardian = config.GUARDIAN_PRIVATE_KEY
    ? new ViemGuardian(
        createWalletClient({
          account: privateKeyToAccount(config.GUARDIAN_PRIVATE_KEY as `0x${string}`),
          chain: sepolia,
          transport: http(config.SEPOLIA_RPC_URL),
        }),
        client,
      )
    : undefined;
  if (!guardian)
    log.warn('GUARDIAN_PRIVATE_KEY not set: Sepolia watcher will alert but cannot pause');
  return {
    registration: registration(address),
    reader: new CachedVaultReader(new ChainVaultReader(client, address)),
    source: new AlchemyPendingSource(config.ALCHEMY_WS_URL!, [address], log),
    guardian,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development');
  const shutdown: (() => Promise<unknown>)[] = [];

  const db = createPool(config.DATABASE_URL);
  shutdown.push(() => db.end());
  const ran = await migrate(db);
  if (ran.length) log.info({ migrations: ran }, 'applied migrations');
  const repos = createRepos(db);

  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
  });
  shutdown.push(() => redis.quit());

  // ---- Sandbox chain -------------------------------------------------------
  let sandbox: Sandbox | null = null;
  if (config.SANDBOX_ENABLED) {
    if (config.SANDBOX_ANVIL_SPAWN) {
      const anvil = new AnvilProcess(
        {
          binary: config.ANVIL_PATH,
          rpcUrl: config.SANDBOX_RPC_URL,
          blockTime: config.SANDBOX_BLOCK_TIME,
          forkUrl: config.SANDBOX_FORK_URL,
        },
        log.child({ component: 'anvil' }),
      );
      anvil.start();
      shutdown.push(() => anvil.stop());
    }
    sandbox = new Sandbox(
      {
        rpcUrl: config.SANDBOX_RPC_URL,
        mnemonic: config.SANDBOX_MNEMONIC,
        forkUrl: config.SANDBOX_FORK_URL,
      },
      log.child({ component: 'sandbox' }),
    );
    await sandbox.waitUntilReady(60_000);
    await sandbox.ensureDeployed();
  }

  // ---- Vault registry & demo data -----------------------------------------
  const live = liveSetup(config, log);
  const registrations: VaultRegistration[] = [];
  if (sandbox) {
    registrations.push({
      slug: 'sandbox-treasury',
      name: 'Sandbox Treasury',
      network: 'sandbox',
      chainId: SANDBOX_CHAIN_ID,
      address: sandbox.vaultAddress,
      knownCallers: sandbox.knownCallers,
    });
  }
  if (live) registrations.push(live.registration);
  const vaultRows = await registerVaults(db, registrations);
  const sandboxRow = vaultRows.find((v) => v.network === 'sandbox');
  if (config.SEED_DEMO && sandbox && sandboxRow) {
    await seedDemo(
      db,
      {
        demoEmail: config.DEMO_EMAIL,
        sandbox: sandboxRow,
        attacker: sandbox.accounts.attacker.address,
        ops: sandbox.accounts.ops.address,
        admin: sandbox.accounts.admin.address,
      },
      log,
    );
  }

  const sandboxReader = sandbox
    ? new CachedVaultReader(new ChainVaultReader(sandbox.client, sandbox.vaultAddress), 500)
    : null;

  // ---- Watchers (producer side) ------------------------------------------
  const watchers: Watcher[] = [];
  if (runsWatcher(config)) {
    const publisher = new StreamPublisher(redis, config.STREAM_KEY, config.STREAM_MAXLEN);
    const rules = {
      largeWithdrawalBps: config.LARGE_WITHDRAWAL_BPS,
      rapidRepeatCount: config.RAPID_REPEAT_COUNT,
      rapidRepeatWindowSec: config.RAPID_REPEAT_WINDOW_SEC,
      pauseThreshold: config.PAUSE_THRESHOLD,
    };
    if (sandbox && sandboxReader) {
      const vault = sandbox.vaultAddress;
      watchers.push(
        new Watcher({
          target: {
            network: 'sandbox',
            chainId: SANDBOX_CHAIN_ID,
            vaultAddress: vault,
            knownCallers: sandbox.knownCallers,
          },
          source: new RpcPendingSource(
            config.SANDBOX_WS_URL,
            () => [vault],
            log.child({ source: 'sandbox' }),
          ),
          state: sandboxReader,
          publisher,
          guardian: new ViemGuardian(sandbox.wallet(sandbox.accounts.guardian), sandbox.client),
          rules,
          log: log.child({ watcher: 'sandbox' }),
        }),
      );
    }
    if (live) {
      watchers.push(
        new Watcher({
          target: {
            network: 'sepolia',
            chainId: SEPOLIA_CHAIN_ID,
            vaultAddress: live.registration.address,
            knownCallers: live.registration.knownCallers,
          },
          source: live.source,
          state: live.reader,
          publisher,
          guardian: live.guardian,
          rules,
          log: log.child({ watcher: 'sepolia' }),
        }),
      );
    }
    for (const w of watchers) {
      await w.start();
      shutdown.unshift(() => w.stop());
    }
  }

  // ---- API + stream consumer ---------------------------------------------
  if (runsApi(config)) {
    const broadcaster = new Broadcaster();
    const sandboxWatcher = watchers.find((w) => w.target.network === 'sandbox');
    const simulations = sandbox
      ? new SimulationRunner({
          sandbox,
          repos,
          broadcaster,
          log: log.child({ component: 'simulation' }),
          onReset: () => {
            sandboxWatcher?.reset();
            sandboxReader?.invalidate();
          },
        })
      : null;
    const stale = await repos.simulations.failStale();
    if (stale) log.warn({ stale }, 'marked interrupted simulations as failed');

    const consumer = new StreamConsumer(
      redis.duplicate(),
      { key: config.STREAM_KEY, group: config.STREAM_GROUP, blockMs: config.STREAM_BLOCK_MS },
      createIngestHandler({
        repos,
        broadcaster,
        simulations: simulations ?? { activeFor: () => null },
        log,
      }),
      log.child({ component: 'consumer' }),
    );
    await consumer.start();
    shutdown.unshift(() => consumer.stop());

    const vaultReader = (v: VaultRow): VaultStateReader | null => {
      if (v.network === 'sandbox') return sandboxReader;
      if (live && v.slug === live.registration.slug) return live.reader;
      return null;
    };

    const app = await buildApp({
      config,
      log,
      repos,
      tokens: new TokenService(config.JWT_SECRET),
      broadcaster,
      simulations,
      vaultReader,
      providerFor: (v) =>
        v.network === 'sandbox' ? 'anvil' : config.LIVE_PROVIDER === 'mock' ? 'mock' : 'alchemy',
      health: {
        db: async () => (await db.query('SELECT 1')).rowCount === 1,
        redis: async () => (await redis.ping()) === 'PONG',
        sandbox: sandbox ? () => sandbox.isReachable() : undefined,
      },
    });
    await app.listen({ host: config.HOST, port: config.PORT });
    shutdown.unshift(() => app.close());
  }

  let closing = false;
  const close = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    for (const fn of shutdown)
      await fn().catch((err: unknown) => log.error({ err }, 'shutdown step failed'));
    process.exit(0);
  };
  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
