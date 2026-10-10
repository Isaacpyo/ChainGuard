# ChainGuard MVP — build plan

## Goal

Detect a malicious transaction while it is still in the mempool and pause the
target contract before it lands. Everything runs on free tiers and works
end-to-end without paid API keys (an anvil sandbox chain stands in for Sepolia).

## Components

| Path | What | Tech |
| --- | --- | --- |
| `packages/contracts` | `GuardedVault` + Foundry tests + Sepolia deploy script | Solidity 0.8.24, Foundry, OpenZeppelin 5 |
| `packages/shared` | API DTO types and the generated vault ABI/bytecode | TypeScript |
| `apps/api` | HTTP API, Redis Stream consumer, mempool watcher, guardian, attack simulator | Node 22, Fastify, viem, ioredis, pg, zod |
| `apps/web` | Dashboard (static export) | Next.js 15, React 19, Tailwind 4 |

## Contract: `GuardedVault`

- Holds ETH. `WITHDRAWER_ROLE` can `withdraw(to, amount)`.
- **Rate limit**: token bucket, `withdrawLimit` wei refilling linearly over
  `windowDuration`. A drained bucket blocks further withdrawals until it refills.
- **Pausable**: `GUARDIAN_ROLE` pauses instantly. Unpausing is timelocked so a
  stolen admin key cannot undo an emergency pause.
- **Timelock**: `ADMIN_ROLE` schedules admin calls (`grantRole`, `revokeRole`,
  `setRateLimit`, `setTimelockDelay`, `unpause`) which execute only after
  `timelockDelay`. The vault is its own `DEFAULT_ADMIN_ROLE`, so role changes
  *must* go through the timelock. Guardians can cancel queued operations.
- Tests: unit, fuzz, invariant (bucket never exceeds limit, outflow bounded),
  a drain attack stopped by rate limit + pause, and a re-entrancy attack.

## Detection pipeline

```
pending tx ──▶ PendingTxSource ──▶ decode (viem) ──▶ rules engine ──▶ score
                (alchemy | rpc | mock)                              │
                                                                    ├──▶ XADD chainguard:events (Redis Stream)
                                                                    └──▶ score ≥ threshold → Guardian.pause() (priority fee bump)
Redis Stream ──▶ consumer group "api" ──▶ Postgres (alerts) ──▶ SSE ──▶ dashboard
```

Rules (pure function, unit-tested): large withdrawal (share of balance),
unknown caller, rapid repeats per sender, bucket exhaustion, timelock
schedule. Score = capped sum of weights; severity bands; pause threshold
configurable.

## Sandbox / "Simulate attack"

anvil runs with interval mining (`--block-time 2`, fee ordering) — a separate
container locally, a child process of the API on Render. Optional
`--fork-url` makes it a Sepolia fork. Each simulation `anvil_reset`s, deploys
the vault via the deterministic CREATE2 factory (same address every run, so
the watcher needs no coordination), funds it, sends benign traffic, then
fires a burst of drain transactions from an unknown withdrawer right after a
block. The watcher sees them pending and front-runs with `pause()`. Progress
streams to the UI; the result is stored in Postgres.

## Data

Postgres: `users`, `vaults`, `alerts`, `simulations` (plain SQL migrations,
idempotent seed with a demo user and historical alerts). Redis: one stream
with a consumer group; idempotent inserts keyed by stream id.

## Hosting constraints

- Render free = one web service, sleeps when idle → watcher, consumer and API
  share a process (`ROLE=all`, splittable), UI shows "waking server…".
- Upstash free has a command budget → long `XREADGROUP BLOCK`, capped stream.
- Netlify serves a static export; no Next.js server needed.

## Order of work

1. Monorepo scaffold, tooling, CI skeleton
2. Contract + Foundry tests + deploy script + ABI export
3. API: config, DB, auth, rules, watcher, guardian, streams, simulator, SSE
4. Dashboard
5. Playwright smoke test, Docker, compose, render.yaml, netlify.toml
6. README, PR
