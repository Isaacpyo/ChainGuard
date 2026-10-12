import { parseGwei } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { TokenService } from '../src/auth/tokens';
import { CachedVaultReader, toVaultStateDto, type VaultStateReader } from '../src/chain/vault';
import { loadConfig } from '../src/config';
import { createPool } from '../src/db/pool';
import type { Logger } from '../src/logger';
import { decodeEvent, encodeEvent, type ChainGuardEvent } from '../src/streams/events';
import { MAX_TIP, MIN_TIP, outbidFees } from '../src/watcher/fees';
import { BoundedSet, SenderHistory } from '../src/watcher/history';
import { ATTACKER, VAULT, vaultState } from './fixtures';

describe('SenderHistory', () => {
  it('counts calls inside the sliding window per sender', () => {
    const h = new SenderHistory(60);
    expect(h.record(ATTACKER, 0)).toBe(1);
    expect(h.record(ATTACKER, 10_000)).toBe(2);
    expect(h.record(ATTACKER.toLowerCase(), 59_000)).toBe(3);
    expect(h.record(ATTACKER, 70_001)).toBe(2); // the first two fell out of the window
    expect(h.record(VAULT, 70_001)).toBe(1);
  });

  it('evicts the least recently active sender beyond capacity', () => {
    const h = new SenderHistory(60, 2);
    h.record('0xa', 0);
    h.record('0xb', 1);
    h.record('0xa', 2);
    h.record('0xc', 3);
    expect(h.size).toBe(2);
    expect(h.record('0xb', 4)).toBe(1); // b was evicted, so it starts over
  });
});

describe('BoundedSet', () => {
  it('deduplicates and forgets the oldest entries', () => {
    const s = new BoundedSet(2);
    expect(s.add('a')).toBe(true);
    expect(s.add('a')).toBe(false);
    s.add('b');
    s.add('c');
    expect(s.add('a')).toBe(true);
  });
});

describe('outbidFees', () => {
  const base = parseGwei('10');

  it('doubles an EIP-1559 tip and leaves base-fee headroom', () => {
    const bid = outbidFees(
      { maxFeePerGas: parseGwei('30'), maxPriorityFeePerGas: parseGwei('3') },
      base,
    );
    expect(bid.maxPriorityFeePerGas).toBe(parseGwei('6'));
    expect(bid.maxFeePerGas).toBe(parseGwei('36'));
  });

  it('uses the effective tip when maxFee caps it', () => {
    const bid = outbidFees(
      { maxFeePerGas: parseGwei('12'), maxPriorityFeePerGas: parseGwei('5') },
      base,
    );
    expect(bid.maxPriorityFeePerGas).toBe(parseGwei('4'));
  });

  it('handles legacy gasPrice transactions', () => {
    const bid = outbidFees({ gasPrice: parseGwei('15') }, base);
    expect(bid.maxPriorityFeePerGas).toBe(parseGwei('10'));
  });

  it('applies the floor and ceiling', () => {
    expect(
      outbidFees({ maxPriorityFeePerGas: 0n, maxFeePerGas: base }, base).maxPriorityFeePerGas,
    ).toBe(MIN_TIP);
    const huge = outbidFees(
      { maxPriorityFeePerGas: parseGwei('5000'), maxFeePerGas: parseGwei('9000') },
      base,
    );
    expect(huge.maxPriorityFeePerGas).toBe(MAX_TIP);
    expect(huge.maxFeePerGas).toBeGreaterThanOrEqual(parseGwei('9000'));
  });
});

describe('stream events', () => {
  const alertEvent: ChainGuardEvent = {
    type: 'alert',
    alert: {
      id: '7b7c5f6a-63b3-4f4b-9d43-2f9a2b1c0d11',
      network: 'sandbox',
      chainId: 31337,
      vaultAddress: VAULT,
      txHash: `0x${'ab'.repeat(32)}`,
      stage: 'pending',
      from: ATTACKER,
      functionName: 'withdraw',
      args: { to: ATTACKER, amount: '1' },
      valueWei: '0',
      score: 75,
      severity: 'high',
      rules: [{ id: 'unknown-caller', label: 'Unknown caller', weight: 35, reason: 'x' }],
      detectedAt: new Date(0).toISOString(),
    },
  };

  it('round-trips through XADD field encoding', () => {
    expect(decodeEvent(encodeEvent(alertEvent))).toEqual(alertEvent);
  });

  it('rejects malformed messages', () => {
    expect(() => decodeEvent(['type', 'alert'])).toThrow(/no payload/);
    expect(() => decodeEvent(['payload', '{not json'])).toThrow();
    const bad = { ...alertEvent, alert: { ...alertEvent.alert, score: 101 } };
    expect(() => decodeEvent(encodeEvent(bad as ChainGuardEvent))).toThrow();
  });
});

describe('auth primitives', () => {
  it('hashes and verifies passwords with a per-hash salt', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
    await expect(verifyPassword('correct horse battery', a)).resolves.toBe(true);
    await expect(verifyPassword('wrong', a)).resolves.toBe(false);
    await expect(verifyPassword('x', 'garbage')).resolves.toBe(false);
  });

  it('signs and verifies tokens, rejecting tampering and other secrets', async () => {
    const svc = new TokenService('a'.repeat(32));
    const token = await svc.sign({ sub: 'user-1', email: 'a@b.co' });
    await expect(svc.verify(token)).resolves.toEqual({ sub: 'user-1', email: 'a@b.co' });
    await expect(new TokenService('b'.repeat(32)).verify(token)).resolves.toBeNull();
    await expect(svc.verify(`${token.slice(0, -2)}xx`)).resolves.toBeNull();
    await expect(svc.verify('not-a-jwt')).resolves.toBeNull();
  });
});

describe('CachedVaultReader', () => {
  it('coalesces concurrent reads and honours the TTL', async () => {
    let now = 0;
    const inner: VaultStateReader = { read: vi.fn(async () => vaultState()) };
    const cached = new CachedVaultReader(inner, 1_000, () => now);
    await Promise.all([cached.read(), cached.read(), cached.read()]);
    expect(inner.read).toHaveBeenCalledTimes(1);
    now = 999;
    await cached.read();
    expect(inner.read).toHaveBeenCalledTimes(1);
    now = 1_000;
    await cached.read();
    expect(inner.read).toHaveBeenCalledTimes(2);
    cached.invalidate();
    await cached.read();
    expect(inner.read).toHaveBeenCalledTimes(3);
  });

  it('serialises state for the API', () => {
    expect(toVaultStateDto(null)).toMatchObject({ deployed: false, balanceWei: '0' });
    expect(toVaultStateDto(vaultState({ paused: true }))).toMatchObject({
      deployed: true,
      paused: true,
      balanceWei: '100000000000000000000',
      windowSeconds: 3600,
    });
  });
});

describe('createPool', () => {
  it('logs errors from idle connections instead of crashing the process', async () => {
    const log = { warn: vi.fn() } as unknown as Logger;
    const pool = createPool('postgres://u:p@127.0.0.1:1/db', log);
    const dropped = new Error('terminating connection due to administrator command');
    // pg re-emits an idle client's error on the pool; with no listener, emit() throws.
    expect(() => pool.emit('error', dropped)).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith({ err: dropped }, expect.any(String));
    await pool.end();
  });
});

describe('loadConfig', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'x'.repeat(32),
  };

  it('applies defaults and parses lists and booleans', () => {
    const c = loadConfig({
      ...base,
      CORS_ORIGINS: 'https://a.com, https://b.com',
      SANDBOX_ANVIL_SPAWN: 'true',
    });
    expect(c.CORS_ORIGINS).toEqual(['https://a.com', 'https://b.com']);
    expect(c.SANDBOX_ANVIL_SPAWN).toBe(true);
    expect(c.PAUSE_THRESHOLD).toBe(70);
    expect(c.LIVE_PROVIDER).toBe('off');
  });

  it('treats empty strings as unset', () => {
    expect(
      loadConfig({ ...base, SANDBOX_FORK_URL: '', GUARDIAN_PRIVATE_KEY: '' }).SANDBOX_FORK_URL,
    ).toBeUndefined();
  });

  it('reports every problem at once', () => {
    expect(() => loadConfig({ JWT_SECRET: 'short' })).toThrow(
      /JWT_SECRET[\s\S]*DATABASE_URL[\s\S]*REDIS_URL/,
    );
  });

  it('requires the Alchemy settings when LIVE_PROVIDER=alchemy', () => {
    expect(() => loadConfig({ ...base, LIVE_PROVIDER: 'alchemy' })).toThrow(/ALCHEMY_WS_URL/);
  });
});
