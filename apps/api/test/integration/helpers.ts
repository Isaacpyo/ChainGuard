import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { describe } from 'vitest';
import { migrate, type Db } from '../../src/db/pool';

export const DATABASE_URL = process.env.TEST_DATABASE_URL;
export const REDIS_URL = process.env.TEST_REDIS_URL;
export const ANVIL_PATH = process.env.ANVIL_PATH ?? 'anvil';

const hasInfra = Boolean(DATABASE_URL && REDIS_URL);
export const hasAnvil = (() => {
  try {
    execFileSync(ANVIL_PATH, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Integration suites need Postgres + Redis (TEST_DATABASE_URL / TEST_REDIS_URL).
 * Locally they are skipped without them; in CI they always run, so a missing
 * service is a failure rather than a silent skip.
 */
export const describeInfra = hasInfra || process.env.CI ? describe : describe.skip;
export const describeChain = (hasInfra && hasAnvil) || process.env.CI ? describe : describe.skip;

/** A migrated database in a throwaway schema, so test files can run in parallel. */
export async function isolatedDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
  if (!DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 5,
    options: `-c search_path=${schema}`,
  });
  await migrate(db);
  return {
    db,
    drop: async () => {
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export const uniqueKey = (prefix: string) => `${prefix}:${randomUUID()}`;
