import type { Repos } from '../db/repos';
import type { Logger } from '../logger';
import type { ChainGuardEvent } from '../streams/events';
import type { Broadcaster } from './broadcaster';

export interface ActiveSimulation {
  /** The running simulation on this network, if any — its alerts get linked to it. */
  activeFor(network: string): string | null;
}

/** Consumer-side handler: persists stream events and pushes them to live dashboards. */
export function createIngestHandler(deps: {
  repos: Repos;
  broadcaster: Broadcaster;
  simulations: ActiveSimulation;
  log: Logger;
}) {
  const { repos, broadcaster, simulations, log } = deps;

  return async function ingest(event: ChainGuardEvent, streamId: string): Promise<void> {
    if (event.type === 'alert') {
      const a = event.alert;
      const vault = await repos.vaults.findByAddress(a.network, a.vaultAddress);
      const alert = await repos.alerts.insertFromEvent(a, {
        streamId,
        vaultId: vault?.id ?? null,
        simulationId: simulations.activeFor(a.network),
      });
      if (alert) broadcaster.publish({ type: 'alert', alert });
      return;
    }

    const alert = await repos.alerts.setResponse(event.alertId, event.action, event.txHash);
    if (!alert) {
      log.warn({ alertId: event.alertId }, 'response for unknown alert');
      return;
    }
    broadcaster.publish({ type: 'alert.updated', alert });
    broadcaster.publishGuardian({ ...event, network: alert.network });
  };
}
