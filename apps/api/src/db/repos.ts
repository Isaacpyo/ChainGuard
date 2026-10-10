import type {
  AlertDto,
  AlertPage,
  AlertStatus,
  AlertSummary,
  ResponseAction,
  Severity,
  SimulationDto,
  SimulationResult,
  UserDto,
  Network,
} from '@chainguard/shared';
import { SEVERITIES } from '@chainguard/shared';
import type { Db } from './pool';
import type { AlertPayload } from '../streams/events';

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  password_hash: string;
  is_demo: boolean;
}

const toUser = (r: UserRow): UserDto => ({
  id: r.id,
  email: r.email,
  name: r.name,
  isDemo: r.is_demo,
});

export class UsersRepo {
  constructor(private readonly db: Db) {}

  async findByEmail(email: string): Promise<(UserDto & { passwordHash: string }) | null> {
    const { rows } = await this.db.query<UserRow>(
      'SELECT * FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    const row = rows[0];
    return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
  }

  async findById(id: string): Promise<UserDto | null> {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findDemo(): Promise<UserDto | null> {
    const { rows } = await this.db.query<UserRow>(
      'SELECT * FROM users WHERE is_demo ORDER BY created_at LIMIT 1',
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  /** Returns null when the email is taken. */
  async create(input: {
    email: string;
    name: string | null;
    passwordHash: string;
    isDemo?: boolean;
  }): Promise<UserDto | null> {
    const { rows } = await this.db.query<UserRow>(
      `INSERT INTO users (email, name, password_hash, is_demo) VALUES ($1, $2, $3, $4)
       ON CONFLICT (lower(email)) DO NOTHING RETURNING *`,
      [input.email, input.name, input.passwordHash, input.isDemo ?? false],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }
}

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

export interface VaultRow {
  id: string;
  slug: string;
  name: string;
  network: Network;
  chain_id: number;
  address: string;
  known_callers: string[];
}

export class VaultsRepo {
  constructor(private readonly db: Db) {}

  async list(): Promise<VaultRow[]> {
    const { rows } = await this.db.query<VaultRow>(
      `SELECT * FROM vaults ORDER BY CASE network WHEN 'sepolia' THEN 0 ELSE 1 END, created_at`,
    );
    return rows;
  }

  async get(id: string): Promise<VaultRow | null> {
    const { rows } = await this.db.query<VaultRow>('SELECT * FROM vaults WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async findByAddress(network: string, address: string): Promise<VaultRow | null> {
    const { rows } = await this.db.query<VaultRow>(
      'SELECT * FROM vaults WHERE network = $1 AND lower(address) = lower($2)',
      [network, address],
    );
    return rows[0] ?? null;
  }

  async upsert(v: Omit<VaultRow, 'id'>): Promise<VaultRow> {
    const { rows } = await this.db.query<VaultRow>(
      `INSERT INTO vaults (slug, name, network, chain_id, address, known_callers)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, network = EXCLUDED.network,
         chain_id = EXCLUDED.chain_id, address = EXCLUDED.address, known_callers = EXCLUDED.known_callers
       RETURNING *`,
      [v.slug, v.name, v.network, v.chain_id, v.address, v.known_callers],
    );
    return rows[0]!;
  }
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

interface AlertRow {
  id: string;
  vault_id: string | null;
  network: Network;
  vault_address: string;
  tx_hash: string;
  stage: 'pending' | 'mined';
  from_address: string;
  function_name: string;
  args: Record<string, string>;
  value_wei: string;
  score: number;
  severity: Severity;
  rules: AlertDto['rules'];
  response: ResponseAction;
  response_tx_hash: string | null;
  status: AlertStatus;
  acknowledged_by: string | null;
  simulation_id: string | null;
  detected_at: Date;
}

const toAlert = (r: AlertRow): AlertDto => ({
  id: r.id,
  vaultId: r.vault_id,
  network: r.network,
  vaultAddress: r.vault_address,
  txHash: r.tx_hash,
  stage: r.stage,
  from: r.from_address,
  functionName: r.function_name,
  args: r.args,
  valueWei: r.value_wei,
  score: r.score,
  severity: r.severity,
  rules: r.rules,
  response: r.response,
  responseTxHash: r.response_tx_hash,
  status: r.status,
  acknowledgedBy: r.acknowledged_by,
  simulationId: r.simulation_id,
  detectedAt: r.detected_at.toISOString(),
});

/** Opaque keyset cursor: base64url("<iso>|<uuid>"). */
export function encodeCursor(detectedAt: string, id: string): string {
  return Buffer.from(`${detectedAt}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { detectedAt: string; id: string } | null {
  const [detectedAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!detectedAt || !id || Number.isNaN(Date.parse(detectedAt))) return null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { detectedAt, id };
}

export interface AlertQuery {
  vaultId?: string | undefined;
  severities?: Severity[] | undefined;
  status?: AlertStatus | undefined;
  limit: number;
  cursor?: { detectedAt: string; id: string } | null | undefined;
}

export class AlertsRepo {
  constructor(private readonly db: Db) {}

  /** Idempotent: redelivered stream messages are ignored. Returns null if it already existed. */
  async insertFromEvent(
    a: AlertPayload,
    ctx: { streamId: string | null; vaultId: string | null; simulationId: string | null },
  ): Promise<AlertDto | null> {
    const { rows } = await this.db.query<AlertRow>(
      `INSERT INTO alerts (id, stream_id, vault_id, network, vault_address, tx_hash, stage, from_address,
         function_name, args, value_wei, score, severity, rules, simulation_id, detected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT DO NOTHING RETURNING *`,
      [
        a.id,
        ctx.streamId,
        ctx.vaultId,
        a.network,
        a.vaultAddress,
        a.txHash,
        a.stage,
        a.from,
        a.functionName,
        JSON.stringify(a.args),
        a.valueWei,
        a.score,
        a.severity,
        JSON.stringify(a.rules),
        ctx.simulationId,
        a.detectedAt,
      ],
    );
    return rows[0] ? toAlert(rows[0]) : null;
  }

  async setResponse(
    id: string,
    response: ResponseAction,
    txHash: string | null,
  ): Promise<AlertDto | null> {
    const { rows } = await this.db.query<AlertRow>(
      `UPDATE alerts SET response = $2, response_tx_hash = COALESCE($3, response_tx_hash)
       WHERE id = $1 RETURNING *`,
      [id, response, txHash],
    );
    return rows[0] ? toAlert(rows[0]) : null;
  }

  async setStatus(id: string, status: AlertStatus, userId: string): Promise<AlertDto | null> {
    const { rows } = await this.db.query<AlertRow>(
      `UPDATE alerts SET status = $2,
         acknowledged_by = CASE WHEN $2 = 'open' THEN NULL ELSE $3::uuid END,
         acknowledged_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END
       WHERE id = $1 RETURNING *`,
      [id, status, userId],
    );
    return rows[0] ? toAlert(rows[0]) : null;
  }

  async list(q: AlertQuery): Promise<AlertPage> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.vaultId) add('vault_id = ?', q.vaultId);
    if (q.severities?.length) add('severity = ANY(?)', q.severities);
    if (q.status) add('status = ?', q.status);
    if (q.cursor) {
      params.push(q.cursor.detectedAt, q.cursor.id);
      where.push(
        `(detected_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(q.limit + 1);
    const { rows } = await this.db.query<AlertRow>(
      `SELECT * FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY detected_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    const items = rows.slice(0, q.limit).map(toAlert);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.detectedAt, last.id) : null,
    };
  }

  async summary(vaultId?: string): Promise<AlertSummary> {
    const { rows } = await this.db.query<{
      severity: Severity;
      total: string;
      open: string;
      last: Date | null;
    }>(
      `SELECT severity, count(*) AS total, count(*) FILTER (WHERE status = 'open') AS open,
              max(detected_at) AS last
       FROM alerts WHERE ($1::uuid IS NULL OR vault_id = $1) GROUP BY severity`,
      [vaultId ?? null],
    );
    const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<
      Severity,
      number
    >;
    let total = 0;
    let open = 0;
    let last: Date | null = null;
    for (const r of rows) {
      bySeverity[r.severity] = Number(r.total);
      total += Number(r.total);
      // Info-level activity is not something anyone needs to triage.
      if (r.severity !== 'info') open += Number(r.open);
      if (r.last && (!last || r.last > last)) last = r.last;
    }
    return { total, open, bySeverity, lastDetectedAt: last?.toISOString() ?? null };
  }
}

// ---------------------------------------------------------------------------
// Simulations
// ---------------------------------------------------------------------------

interface SimulationRow {
  id: string;
  status: SimulationDto['status'];
  result: SimulationResult | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

const toSimulation = (r: SimulationRow): SimulationDto => ({
  id: r.id,
  status: r.status,
  result: r.result,
  error: r.error,
  startedAt: r.started_at.toISOString(),
  finishedAt: r.finished_at?.toISOString() ?? null,
});

export class SimulationsRepo {
  constructor(private readonly db: Db) {}

  async create(userId: string | null): Promise<SimulationDto> {
    const { rows } = await this.db.query<SimulationRow>(
      `INSERT INTO simulations (user_id, status) VALUES ($1, 'running') RETURNING *`,
      [userId],
    );
    return toSimulation(rows[0]!);
  }

  async finish(
    id: string,
    outcome:
      { status: 'succeeded'; result: SimulationResult } | { status: 'failed'; error: string },
  ): Promise<SimulationDto> {
    const { rows } = await this.db.query<SimulationRow>(
      `UPDATE simulations SET status = $2, result = $3, error = $4, finished_at = now()
       WHERE id = $1 RETURNING *`,
      [
        id,
        outcome.status,
        outcome.status === 'succeeded' ? JSON.stringify(outcome.result) : null,
        outcome.status === 'failed' ? outcome.error : null,
      ],
    );
    return toSimulation(rows[0]!);
  }

  async get(id: string): Promise<SimulationDto | null> {
    const { rows } = await this.db.query<SimulationRow>('SELECT * FROM simulations WHERE id = $1', [
      id,
    ]);
    return rows[0] ? toSimulation(rows[0]) : null;
  }

  async list(limit: number): Promise<SimulationDto[]> {
    const { rows } = await this.db.query<SimulationRow>(
      'SELECT * FROM simulations ORDER BY started_at DESC LIMIT $1',
      [limit],
    );
    return rows.map(toSimulation);
  }

  /** Marks runs orphaned by a restart as failed. */
  async failStale(): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE simulations SET status = 'failed', error = 'interrupted by a server restart', finished_at = now()
       WHERE status = 'running'`,
    );
    return rowCount ?? 0;
  }
}

export interface Repos {
  users: UsersRepo;
  vaults: VaultsRepo;
  alerts: AlertsRepo;
  simulations: SimulationsRepo;
}

export function createRepos(db: Db): Repos {
  return {
    users: new UsersRepo(db),
    vaults: new VaultsRepo(db),
    alerts: new AlertsRepo(db),
    simulations: new SimulationsRepo(db),
  };
}
