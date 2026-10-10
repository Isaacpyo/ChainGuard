import pg from 'pg';
import { migrations } from './migrations';

export type Db = pg.Pool;

export function createPool(databaseUrl: string): Db {
  return new pg.Pool({
    connectionString: databaseUrl,
    // Neon and Render close idle connections; keep the pool small and short-lived.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

/** Applies pending migrations inside a transaction guarded by an advisory lock. */
export async function migrate(db: Db): Promise<string[]> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727274)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.id));
    const ran: string[] = [];
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
      ran.push(m.id);
    }
    await client.query('COMMIT');
    return ran;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
