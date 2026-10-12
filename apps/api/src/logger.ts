import pino from 'pino';

export type Logger = pino.Logger;

/** `destination` is for tests; by default pino writes to stdout. */
export function createLogger(
  level: string,
  pretty: boolean,
  destination?: pino.DestinationStream,
): Logger {
  const options: pino.LoggerOptions = {
    level,
    redact: ['req.headers.authorization', '*.password', '*.privateKey', '*.GUARDIAN_PRIVATE_KEY'],
    serializers: { err: serializeError },
    ...(pretty && !destination
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
      : {}),
  };
  return destination ? pino(options, destination) : pino(options);
}

/** Logger that drops everything; handy in tests. */
export const silentLogger: Logger = pino({ level: 'silent' });

const URL_PATTERN = /\b([a-z][a-z\d+.-]*:\/\/)(?:[^\s/?#@"'`]*@)?([^\s/?#"'`]+)([^\s"'`]*)/gi;

/**
 * RPC URLs carry API keys in their path (Alchemy: `/v2/<key>`) or credentials before the
 * host, and viem copies the full URL into its error messages. Keeps scheme and host only.
 */
export function redactUrls(text: string): string {
  return text.replace(URL_PATTERN, (_url, scheme: string, host: string, rest: string) =>
    rest.length > 1 ? `${scheme}${host}/[redacted]` : `${scheme}${host}${rest}`,
  );
}

const SERIALIZED_ERROR = Object.getPrototypeOf(pino.stdSerializers.err(new Error())) as object;

/** Redacts URLs in every string of a serialized error, its arrays and plain objects. */
function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactUrls(value);
  if (depth > 4 || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((v: unknown) => redactDeep(v, depth + 1));
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null && proto !== SERIALIZED_ERROR) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, depth + 1)]));
}

/** pino's standard error serializer (message, stack, causes, own fields), URLs redacted. */
export function serializeError(err: unknown): unknown {
  return redactDeep(pino.stdSerializers.err(err as Error));
}
