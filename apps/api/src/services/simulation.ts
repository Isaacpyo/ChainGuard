import {
  formatEth,
  type SimulationDto,
  type SimulationStep,
  type SimulationTx,
} from '@chainguard/shared';
import { guardedVaultAbi } from '@chainguard/shared/abi';
import { parseEther, parseGwei, type Hex } from 'viem';
import { SANDBOX_PARAMS, type Sandbox } from '../chain/sandbox';
import type { Repos } from '../db/repos';
import { redactUrls, type Logger } from '../logger';
import type { ResponseEvent } from '../streams/events';
import type { Broadcaster } from './broadcaster';
import type { ActiveSimulation } from './ingest';

export class SimulationBusyError extends Error {
  constructor() {
    super('a simulation is already running');
  }
}

export const ATTACK = {
  transactions: 5,
  amount: parseEther('10'),
  benignAmount: parseEther('2'),
} as const;

type GuardianEvent = ResponseEvent & { network: string };

/**
 * Runs the drain scenario on the sandbox chain: reset → deploy → fund → normal
 * activity → a burst of withdrawals from a leaked withdrawer key right after a
 * block. The simulator never touches pause(); stopping the attack is entirely up
 * to the watcher seeing the burst in the mempool.
 */
export class SimulationRunner implements ActiveSimulation {
  #busy = false;
  #activeId: string | null = null;

  constructor(
    private readonly deps: {
      sandbox: Sandbox;
      repos: Repos;
      broadcaster: Broadcaster;
      log: Logger;
      /** Called after the chain reset so the sandbox watcher drops stale state. */
      onReset?: () => void;
      receiptTimeoutMs?: number;
    },
  ) {}

  activeFor(network: string): string | null {
    return network === 'sandbox' ? this.#activeId : null;
  }

  get running(): boolean {
    return this.#busy;
  }

  /** Starts a run in the background; progress arrives as simulation.* stream events. */
  async start(userId: string | null): Promise<SimulationDto> {
    if (this.#busy) throw new SimulationBusyError();
    this.#busy = true;
    let sim: SimulationDto;
    try {
      sim = await this.deps.repos.simulations.create(userId);
    } catch (err) {
      this.#busy = false;
      throw err;
    }
    this.#activeId = sim.id;
    const id = sim.id;
    // Nothing awaits a background run: an error escaping it (the database is down, so even
    // recording the failure fails) must be logged, not left as an unhandled rejection.
    this.#done = this.#run(id)
      .catch((err: unknown) => {
        this.deps.log.error({ err, id }, 'could not record the simulation outcome');
        return null;
      })
      .finally(() => {
        this.#busy = false;
        this.#activeId = null;
      });
    return sim;
  }

  #done: Promise<SimulationDto | null> | null = null;

  /** Resolves with the finished simulation of the current/last run. For tests. */
  async waitForCompletion(): Promise<SimulationDto | null> {
    return this.#done;
  }

  async #run(id: string): Promise<SimulationDto> {
    const { sandbox, repos, broadcaster, log } = this.deps;
    const step = (s: SimulationStep, message: string) =>
      broadcaster.publish({
        type: 'simulation.step',
        simulationId: id,
        step: s,
        message,
        at: new Date().toISOString(),
      });
    const guardianEvents: GuardianEvent[] = [];
    const off = broadcaster.onGuardian((e) => {
      if (e.network === 'sandbox') guardianEvents.push(e);
    });

    try {
      const { ops, attacker, treasury } = sandbox.accounts;
      const vault = sandbox.vaultAddress;
      const transactions: SimulationTx[] = [];

      step('reset', 'Resetting the sandbox chain');
      await sandbox.reset();
      this.deps.onReset?.();

      step('deploy', `Deploying GuardedVault to ${vault}`);
      const { deployTx, fundTx } = await sandbox.deployAndFund();
      step(
        'fund',
        `Vault funded with ${formatEth(SANDBOX_PARAMS.funding)} ETH (deploy ${short(deployTx)}, deposit ${short(fundTx)})`,
      );

      step(
        'benign',
        `Ops withdraws ${formatEth(ATTACK.benignAmount)} ETH to the treasury — normal activity`,
      );
      const benignHash = await sandbox.wallet(ops).writeContract({
        address: vault,
        abi: guardedVaultAbi,
        functionName: 'withdraw',
        args: [treasury.address, ATTACK.benignAmount],
      });
      const benign = await sandbox.client.waitForTransactionReceipt({ hash: benignHash });
      transactions.push({
        hash: benignHash,
        label: 'Ops withdrawal',
        status: benign.status,
        amountWei: ATTACK.benignAmount.toString(),
        blockNumber: benign.blockNumber.toString(),
      });

      await sandbox.nextBlock();
      const capacity = await sandbox.client.readContract({
        address: vault,
        abi: guardedVaultAbi,
        functionName: 'availableToWithdraw',
      });
      step(
        'attack',
        `Leaked withdrawer key fires ${ATTACK.transactions} × ${formatEth(ATTACK.amount)} ETH withdrawals into the mempool`,
      );
      const attackerWallet = sandbox.wallet(attacker);
      let nonce = await sandbox.client.getTransactionCount({
        address: attacker.address,
        blockTag: 'pending',
      });
      const attackStartedAt = Date.now();
      const attackHashes: Hex[] = [];
      for (let i = 0; i < ATTACK.transactions; i++) {
        attackHashes.push(
          await attackerWallet.writeContract({
            address: vault,
            abi: guardedVaultAbi,
            functionName: 'withdraw',
            args: [attacker.address, ATTACK.amount],
            nonce: nonce++,
            gas: 150_000n, // no estimation: a real attacker does not wait either
            maxPriorityFeePerGas: parseGwei('1'),
            maxFeePerGas: parseGwei('30'),
          }),
        );
      }

      step('response', 'Waiting for the next block…');
      const receipts = await Promise.all(
        attackHashes.map((hash) =>
          sandbox.client.waitForTransactionReceipt({
            hash,
            timeout: this.deps.receiptTimeoutMs ?? 30_000,
          }),
        ),
      );
      let stolen = 0n;
      receipts.forEach((r, i) => {
        if (r.status === 'success') stolen += ATTACK.amount;
        transactions.push({
          hash: attackHashes[i]!,
          label: `Attack #${i + 1}`,
          status: r.status,
          amountWei: ATTACK.amount.toString(),
          blockNumber: r.blockNumber.toString(),
        });
      });

      const state = await sandbox.client.readContract({
        address: vault,
        abi: guardedVaultAbi,
        functionName: 'getState',
      });
      // The guardian's events travel watcher → Redis → consumer; give them a moment.
      const pauseEvent = state.paused
        ? await waitFor(() => guardianEvents.find((e) => e.action === 'pause_submitted'), 5_000)
        : undefined;
      if (pauseEvent?.txHash) {
        const r = await sandbox.client
          .getTransactionReceipt({ hash: pauseEvent.txHash as Hex })
          .catch(() => null);
        transactions.push({
          hash: pauseEvent.txHash,
          label: 'Guardian pause()',
          status: r?.status ?? 'pending',
          amountWei: '0',
          blockNumber: r?.blockNumber.toString() ?? null,
        });
      }

      const attempted = ATTACK.amount * BigInt(ATTACK.transactions);
      const detectionMs = pauseEvent
        ? Math.max(0, Date.parse(pauseEvent.at) - attackStartedAt)
        : null;
      step(
        'settle',
        state.paused
          ? `Vault paused${detectionMs !== null ? ` ${detectionMs} ms after the attack hit the mempool` : ''} — ${formatEth(stolen)} of ${formatEth(attempted)} ETH lost`
          : `Vault not paused — rate limit held losses to ${formatEth(stolen)} ETH`,
      );

      const finished = await repos.simulations.finish(id, {
        status: 'succeeded',
        result: {
          vaultAddress: vault,
          fundedWei: SANDBOX_PARAMS.funding.toString(),
          attemptedWei: attempted.toString(),
          stolenWei: stolen.toString(),
          protectedWei: (attempted - stolen).toString(),
          paused: state.paused,
          pauseTxHash: pauseEvent?.txHash ?? null,
          detectionMs,
          rateLimitCapWei: capacity.toString(),
          transactions,
        },
      });
      broadcaster.publish({ type: 'simulation.finished', simulation: finished });
      log.info({ id, stolen: stolen.toString(), paused: state.paused }, 'simulation finished');
      return finished;
    } catch (err) {
      log.error({ err, id }, 'simulation failed');
      // Stored and shown on the dashboard: no RPC URLs (a fork URL carries an API key).
      const message = redactUrls(err instanceof Error ? err.message.split('\n')[0]! : String(err));
      const failed = await repos.simulations.finish(id, { status: 'failed', error: message });
      broadcaster.publish({ type: 'simulation.finished', simulation: failed });
      return failed;
    } finally {
      off();
    }
  }
}

const short = (hash: string) => `${hash.slice(0, 10)}…`;

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
}
