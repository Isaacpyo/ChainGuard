/**
 * Wire types shared by the API and the dashboard. Amounts are decimal wei strings
 * (JSON has no bigint); timestamps are ISO-8601 strings.
 */

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ALERT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export type Network = 'sandbox' | 'sepolia';
export type ChainProvider = 'anvil' | 'alchemy' | 'mock';

/** How the guardian reacted to an alert. */
export type ResponseAction =
  'none' | 'pause_submitted' | 'pause_confirmed' | 'pause_failed' | 'already_paused';

export interface TriggeredRule {
  id: string;
  label: string;
  weight: number;
  reason: string;
}

export interface AlertDto {
  id: string;
  vaultId: string | null;
  network: Network;
  vaultAddress: string;
  txHash: string;
  stage: 'pending' | 'mined';
  from: string;
  functionName: string;
  args: Record<string, string>;
  valueWei: string;
  score: number;
  severity: Severity;
  rules: TriggeredRule[];
  response: ResponseAction;
  responseTxHash: string | null;
  status: AlertStatus;
  acknowledgedBy: string | null;
  simulationId: string | null;
  detectedAt: string;
}

export interface AlertPage {
  items: AlertDto[];
  nextCursor: string | null;
}

export interface AlertSummary {
  total: number;
  open: number;
  bySeverity: Record<Severity, number>;
  lastDetectedAt: string | null;
}

export interface VaultDto {
  id: string;
  slug: string;
  name: string;
  network: Network;
  chainId: number;
  address: string;
  provider: ChainProvider;
  explorerUrl: string | null;
  simulatable: boolean;
}

export interface VaultStateDto {
  deployed: boolean;
  paused: boolean;
  balanceWei: string;
  availableWei: string;
  limitWei: string;
  windowSeconds: number;
  timelockDelaySeconds: number;
  blockNumber: string;
  readAt: string;
}

export interface UserDto {
  id: string;
  email: string;
  name: string | null;
  isDemo: boolean;
}

export interface AuthResponse {
  token: string;
  user: UserDto;
}

export interface RuleInfo {
  id: string;
  label: string;
  weight: number;
  description: string;
}

export interface ConfigDto {
  pauseThreshold: number;
  rules: RuleInfo[];
  severityBands: { severity: Severity; minScore: number }[];
  sandbox: { enabled: boolean; forked: boolean; blockTimeSeconds: number };
  live: { provider: ChainProvider | 'off' };
}

export const SIMULATION_STEPS = [
  'reset',
  'deploy',
  'fund',
  'benign',
  'attack',
  'response',
  'settle',
] as const;
export type SimulationStep = (typeof SIMULATION_STEPS)[number];

export interface SimulationTx {
  hash: string;
  label: string;
  status: 'success' | 'reverted' | 'pending';
  amountWei: string;
  blockNumber: string | null;
}

export interface SimulationResult {
  vaultAddress: string;
  fundedWei: string;
  attemptedWei: string;
  stolenWei: string;
  protectedWei: string;
  paused: boolean;
  pauseTxHash: string | null;
  /** Time from the first attack tx hitting the mempool to the guardian's pause() being sent. */
  detectionMs: number | null;
  /** What the rate limit alone would have allowed (no guardian). */
  rateLimitCapWei: string;
  transactions: SimulationTx[];
}

export interface SimulationDto {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  result: SimulationResult | null;
  error: string | null;
}

/** Server-sent events pushed on GET /stream. */
export type StreamEvent =
  | { type: 'alert'; alert: AlertDto }
  | { type: 'alert.updated'; alert: AlertDto }
  | {
      type: 'simulation.step';
      simulationId: string;
      step: SimulationStep;
      message: string;
      at: string;
    }
  | { type: 'simulation.finished'; simulation: SimulationDto };
