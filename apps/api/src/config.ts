import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address');

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(4000),
    /**
     * Reverse-proxy hops in front of the API (Render: 3). The client IP behind the per-IP
     * rate limits is taken that many hops back along X-Forwarded-For; 0 trusts no proxy.
     */
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** all = API + stream consumer + watchers in one process (Render free tier). */
    ROLE: z.enum(['all', 'api', 'watcher']).default('all'),
    CORS_ORIGINS: csv,
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    STREAM_KEY: z.string().default('chainguard:events'),
    STREAM_GROUP: z.string().default('api'),
    STREAM_MAXLEN: z.coerce.number().int().positive().default(5_000),
    STREAM_BLOCK_MS: z.coerce.number().int().positive().default(20_000),

    SEED_DEMO: bool.default(true),
    DEMO_EMAIL: z.string().email().default('demo@chainguard.dev'),

    SANDBOX_ENABLED: bool.default(true),
    SANDBOX_RPC_URL: z.string().url().default('http://127.0.0.1:8545'),
    SANDBOX_WS_URL: z.string().url().default('ws://127.0.0.1:8545'),
    SANDBOX_ANVIL_SPAWN: bool.default(false),
    ANVIL_PATH: z.string().default('anvil'),
    SANDBOX_FORK_URL: z
      .string()
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    SANDBOX_BLOCK_TIME: z.coerce.number().int().min(1).max(12).default(2),
    /** anvil's public dev mnemonic — these keys only ever sign for the local sandbox chain. */
    SANDBOX_MNEMONIC: z
      .string()
      .default('test test test test test test test test test test test junk'),

    PAUSE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(70),
    LARGE_WITHDRAWAL_BPS: z.coerce.number().int().min(1).max(10_000).default(1_000),
    RAPID_REPEAT_COUNT: z.coerce.number().int().min(2).default(3),
    RAPID_REPEAT_WINDOW_SEC: z.coerce.number().int().min(1).default(60),

    LIVE_PROVIDER: z.enum(['off', 'alchemy', 'mock']).default('off'),
    ALCHEMY_WS_URL: z.string().url().optional(),
    SEPOLIA_RPC_URL: z.string().url().optional(),
    LIVE_VAULT_ADDRESS: address.optional(),
    LIVE_KNOWN_CALLERS: csv,
    GUARDIAN_PRIVATE_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex key')
      .optional(),
  })
  .superRefine((c, ctx) => {
    if (c.LIVE_PROVIDER === 'alchemy') {
      for (const key of ['ALCHEMY_WS_URL', 'SEPOLIA_RPC_URL', 'LIVE_VAULT_ADDRESS'] as const) {
        if (!c[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `required when LIVE_PROVIDER=alchemy`,
          });
        }
      }
    }
    if (c.NODE_ENV === 'production' && c.JWT_SECRET.startsWith('dev-only')) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'set a real secret in production',
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

/** Empty strings from .env files mean "unset". */
function stripEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== ''),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(stripEmpty(env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export const runsApi = (c: Config) => c.ROLE === 'all' || c.ROLE === 'api';
export const runsWatcher = (c: Config) => c.ROLE === 'all' || c.ROLE === 'watcher';
