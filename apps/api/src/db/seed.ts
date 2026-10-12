import { randomBytes, randomUUID } from 'node:crypto';
import type { Severity, SimulationResult, TriggeredRule } from '@chainguard/shared';
import { severityForScore } from '@chainguard/shared';
import { keccak256, parseEther, toHex, type Address } from 'viem';
import { hashPassword } from '../auth/password';
import type { Logger } from '../logger';
import type { Db } from './pool';
import { createRepos, type VaultRow } from './repos';

export interface VaultRegistration {
  slug: string;
  name: string;
  network: 'sandbox' | 'sepolia';
  chainId: number;
  address: Address;
  knownCallers: Address[];
}

/** Keeps the vaults table in sync with what this deployment monitors. Runs on every boot. */
export async function registerVaults(db: Db, vaults: VaultRegistration[]): Promise<VaultRow[]> {
  const repo = createRepos(db).vaults;
  const rows: VaultRow[] = [];
  for (const v of vaults) {
    rows.push(
      await repo.upsert({
        slug: v.slug,
        name: v.name,
        network: v.network,
        chain_id: v.chainId,
        address: v.address,
        known_callers: v.knownCallers,
      }),
    );
  }
  return rows;
}

const fakeHash = (label: string) => keccak256(toHex(`chainguard-seed:${label}`));

/**
 * Idempotent demo data: the demo account plus one historical incident on the
 * sandbox vault, so the dashboard has something to show before the first run.
 */
export async function seedDemo(
  db: Db,
  opts: { demoEmail: string; sandbox: VaultRow; attacker: Address; ops: Address; admin: Address },
  log: Logger,
): Promise<void> {
  const repos = createRepos(db);

  if (!(await repos.users.findDemo())) {
    // Random password: the demo account is only reachable through POST /auth/demo.
    await repos.users.create({
      email: opts.demoEmail,
      name: 'Demo Analyst',
      passwordHash: await hashPassword(randomBytes(32).toString('hex')),
      isDemo: true,
    });
    log.info({ email: opts.demoEmail }, 'seeded demo user');
  }

  const { rows } = await db.query<{ n: string }>(
    'SELECT count(*) AS n FROM alerts WHERE vault_id = $1',
    [opts.sandbox.id],
  );
  if (Number(rows[0]?.n ?? 0) > 0) return;

  const start = Date.now() - 26 * 3_600_000;
  const at = (offsetMs: number) => new Date(start + offsetMs);

  const sim = await db.query<{ id: string }>(
    `INSERT INTO simulations (status, result, started_at, finished_at)
     VALUES ('succeeded', $1, $2, $3) RETURNING id`,
    [
      JSON.stringify({
        vaultAddress: opts.sandbox.address,
        fundedWei: parseEther('100').toString(),
        attemptedWei: parseEther('50').toString(),
        stolenWei: '0',
        protectedWei: parseEther('50').toString(),
        paused: true,
        pauseTxHash: fakeHash('pause'),
        detectionMs: 38,
        rateLimitCapWei: parseEther('18').toString(),
        transactions: [],
      } satisfies SimulationResult),
      at(0),
      at(9_000),
    ],
  );
  const simulationId = sim.rows[0]!.id;

  const rule = (id: string, label: string, weight: number, reason: string): TriggeredRule => ({
    id,
    label,
    weight,
    reason,
  });
  const unknown = rule(
    'unknown-caller',
    'Unknown caller',
    35,
    `${opts.attacker} has never been seen operating this vault`,
  );
  const large = rule(
    'large-withdrawal',
    'Large withdrawal',
    40,
    '10 ETH is 10.2% of the 98 ETH balance',
  );
  const rapid = (n: number) =>
    rule('rapid-repeats', 'Rapid repeats', 30, `${n} calls from this sender in the last 60s`);

  type Seed = {
    label: string;
    from: Address;
    fn: string;
    args: Record<string, string>;
    value?: bigint;
    rules: TriggeredRule[];
    offsetMs: number;
    response?: string;
    status?: 'open' | 'acknowledged' | 'resolved';
  };
  const withdraw = (to: Address, eth: string) => ({ to, amount: parseEther(eth).toString() });
  const seeds: Seed[] = [
    {
      label: 'deposit',
      from: opts.admin,
      fn: 'deposit',
      args: {},
      value: parseEther('100'),
      rules: [],
      offsetMs: 1_000,
    },
    {
      label: 'ops',
      from: opts.ops,
      fn: 'withdraw',
      args: withdraw(opts.ops, '2'),
      rules: [],
      offsetMs: 3_000,
    },
    {
      label: 'a1',
      from: opts.attacker,
      fn: 'withdraw',
      args: withdraw(opts.attacker, '10'),
      rules: [large, unknown],
      offsetMs: 6_000,
      response: 'pause_confirmed',
      status: 'resolved',
    },
    {
      label: 'a2',
      from: opts.attacker,
      fn: 'withdraw',
      args: withdraw(opts.attacker, '10'),
      rules: [large, unknown],
      offsetMs: 6_004,
      response: 'already_paused',
      status: 'acknowledged',
    },
    {
      label: 'a3',
      from: opts.attacker,
      fn: 'withdraw',
      args: withdraw(opts.attacker, '10'),
      rules: [large, unknown, rapid(3)],
      offsetMs: 6_008,
      response: 'already_paused',
    },
    {
      label: 'a4',
      from: opts.attacker,
      fn: 'withdraw',
      args: withdraw(opts.attacker, '10'),
      rules: [large, unknown, rapid(4)],
      offsetMs: 6_012,
      response: 'already_paused',
    },
    {
      label: 'a5',
      from: opts.attacker,
      fn: 'withdraw',
      args: withdraw(opts.attacker, '10'),
      rules: [large, unknown, rapid(5)],
      offsetMs: 6_016,
      response: 'already_paused',
    },
  ];

  for (const s of seeds) {
    const score = Math.min(
      100,
      s.rules.reduce((sum, r) => sum + r.weight, 0),
    );
    const severity: Severity = severityForScore(score);
    await db.query(
      `INSERT INTO alerts (id, vault_id, network, vault_address, tx_hash, stage, from_address, function_name,
         args, value_wei, score, severity, rules, response, response_tx_hash, status, simulation_id, detected_at)
       VALUES ($1,$2,'sandbox',$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        randomUUID(),
        opts.sandbox.id,
        opts.sandbox.address,
        fakeHash(s.label),
        s.from,
        s.fn,
        JSON.stringify(s.args),
        (s.value ?? 0n).toString(),
        score,
        severity,
        JSON.stringify(s.rules),
        s.response ?? 'none',
        s.response ? fakeHash('pause') : null,
        s.status ?? (severity === 'info' ? 'resolved' : 'open'),
        simulationId,
        at(s.offsetMs),
      ],
    );
  }
  log.info({ alerts: seeds.length }, 'seeded demo incident');
}
