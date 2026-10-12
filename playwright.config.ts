import { defineConfig, devices } from '@playwright/test';

const API_PORT = 4100;
const WEB_PORT = 3100;
const ANVIL_PORT = 8745;
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgres://chainguard:chainguard@localhost:5432/chainguard';
const REDIS_URL =
  process.env.E2E_REDIS_URL ?? process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

/**
 * Smoke test of the whole system: the real API (with its own anvil child process),
 * Postgres, Redis and the static dashboard build, driven through a browser.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run build -w @chainguard/api && node apps/api/dist/server.js',
      url: `http://localhost:${API_PORT}/health`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'production',
        PORT: String(API_PORT),
        LOG_LEVEL: 'warn',
        DATABASE_URL,
        REDIS_URL,
        JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e',
        CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
        STREAM_KEY: 'chainguard:e2e:events',
        STREAM_BLOCK_MS: '1000',
        SANDBOX_ANVIL_SPAWN: 'true',
        SANDBOX_RPC_URL: `http://127.0.0.1:${ANVIL_PORT}`,
        SANDBOX_WS_URL: `ws://127.0.0.1:${ANVIL_PORT}`,
      },
    },
    {
      command: `npm run build -w @chainguard/web && node e2e/serve.mjs apps/web/out ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: { NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`, NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
