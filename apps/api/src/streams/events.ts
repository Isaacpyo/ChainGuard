import { SEVERITIES } from '@chainguard/shared';
import { z } from 'zod';

/**
 * Messages on the Redis Stream between the watcher (producer) and the API (consumer).
 * Validated on read: the stream is a trust boundary when the roles run separately.
 */

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const AlertEventSchema = z.object({
  type: z.literal('alert'),
  alert: z.object({
    id: z.uuid(),
    network: z.enum(['sandbox', 'sepolia']),
    chainId: z.number().int().positive(),
    vaultAddress: address,
    txHash,
    stage: z.enum(['pending', 'mined']),
    from: address,
    functionName: z.string().min(1).max(100),
    args: z.record(z.string(), z.string().max(2_000)),
    valueWei: z.string().regex(/^\d+$/),
    score: z.number().int().min(0).max(100),
    severity: z.enum(SEVERITIES),
    rules: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          weight: z.number().int(),
          reason: z.string(),
        }),
      )
      .max(20),
    detectedAt: z.iso.datetime(),
    input: hex.optional(),
  }),
});

export const ResponseEventSchema = z.object({
  type: z.literal('alert.response'),
  alertId: z.uuid(),
  action: z.enum(['pause_submitted', 'pause_confirmed', 'pause_failed', 'already_paused']),
  txHash: txHash.nullable(),
  error: z.string().max(500).nullable(),
  at: z.iso.datetime(),
});

export const ChainGuardEventSchema = z.discriminatedUnion('type', [
  AlertEventSchema,
  ResponseEventSchema,
]);

export type AlertEvent = z.infer<typeof AlertEventSchema>;
export type AlertPayload = AlertEvent['alert'];
export type ResponseEvent = z.infer<typeof ResponseEventSchema>;
export type ChainGuardEvent = z.infer<typeof ChainGuardEventSchema>;

/** Flat field list for XADD: type, <type>, payload, <json>. */
export function encodeEvent(event: ChainGuardEvent): string[] {
  return ['type', event.type, 'payload', JSON.stringify(event)];
}

/** Parses XREAD field pairs; throws on malformed or invalid messages. */
export function decodeEvent(fields: string[]): ChainGuardEvent {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i]!, fields[i + 1]!);
  const payload = map.get('payload');
  if (payload === undefined) throw new Error('stream message has no payload field');
  return ChainGuardEventSchema.parse(JSON.parse(payload));
}
