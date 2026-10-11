import type {
  AlertDto,
  AlertPage,
  AlertStatus,
  AlertSummary,
  AuthResponse,
  ConfigDto,
  SimulationDto,
  UserDto,
  VaultDto,
  VaultStateDto,
} from '@chainguard/shared';
import { setServerStatus } from './server-status';
import { clearSession, getSession } from './session';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);

/** After this long without a response we assume the free-tier instance is cold-starting. */
export const WAKING_AFTER_MS = 2_500;
/** Render can take about a minute to boot a sleeping service. */
const WAKE_BUDGET_MS = 90_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  auth?: boolean;
  signal?: AbortSignal;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 502/503/504 or a network error from a sleeping instance: worth retrying while it boots. */
const isColdStart = (status: number) => status === 502 || status === 503 || status === 504;

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.auth !== false) {
    const token = getSession()?.token;
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const started = Date.now();
  const wakingTimer = setTimeout(() => setServerStatus('waking'), WAKING_AFTER_MS);
  try {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(`${API_URL}${path}`, {
          method: opts.method ?? 'GET',
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: opts.signal,
        });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (Date.now() - started > WAKE_BUDGET_MS) {
          setServerStatus('down');
          throw new ApiError(
            0,
            'network',
            'Cannot reach the ChainGuard API. Please try again shortly.',
          );
        }
        setServerStatus('waking');
        await sleep(Math.min(8_000, 1_000 * 2 ** attempt));
        continue;
      }

      if (isColdStart(res.status) && path !== '/health' && Date.now() - started < WAKE_BUDGET_MS) {
        // Only retry idempotent requests; a POST may already have run.
        if ((opts.method ?? 'GET') === 'GET') {
          setServerStatus('waking');
          await sleep(Math.min(8_000, 1_000 * 2 ** attempt));
          continue;
        }
      }

      setServerStatus('ready');
      const text = await res.text();
      const data: unknown = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const body = (data ?? {}) as {
          error?: string;
          message?: string;
          details?: ApiError['details'];
        };
        if (res.status === 401 && opts.auth !== false) clearSession();
        throw new ApiError(
          res.status,
          body.error ?? 'error',
          body.message ?? res.statusText,
          body.details,
        );
      }
      return data as T;
    }
  } finally {
    clearTimeout(wakingTimer);
  }
}

export const api = {
  health: (signal?: AbortSignal) =>
    request<{ status: string }>('/health', { auth: false, ...(signal ? { signal } : {}) }),
  demo: () => request<AuthResponse>('/auth/demo', { method: 'POST', auth: false }),
  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      auth: false,
      body: { email, password },
    }),
  register: (email: string, password: string, name?: string) =>
    request<AuthResponse>('/auth/register', {
      method: 'POST',
      auth: false,
      body: { email, password, ...(name ? { name } : {}) },
    }),
  me: () => request<UserDto>('/me'),
  config: () => request<ConfigDto>('/config', { auth: false }),
  vaults: () => request<VaultDto[]>('/vaults'),
  vaultState: (id: string) => request<VaultStateDto>(`/vaults/${id}/state`),
  alerts: (q: {
    vaultId?: string;
    severity?: string;
    status?: AlertStatus;
    cursor?: string;
    limit?: number;
  }) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q))
      if (v !== undefined && v !== '') params.set(k, String(v));
    return request<AlertPage>(`/alerts?${params.toString()}`);
  },
  summary: (vaultId?: string) =>
    request<AlertSummary>(`/alerts/summary${vaultId ? `?vaultId=${vaultId}` : ''}`),
  setAlertStatus: (id: string, status: AlertStatus) =>
    request<AlertDto>(`/alerts/${id}`, { method: 'PATCH', body: { status } }),
  simulate: () => request<SimulationDto>('/simulations', { method: 'POST' }),
  simulations: (limit = 1) => request<SimulationDto[]>(`/simulations?limit=${limit}`),
};
