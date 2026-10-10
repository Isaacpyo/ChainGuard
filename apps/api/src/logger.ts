import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    redact: ['req.headers.authorization', '*.password', '*.privateKey', '*.GUARDIAN_PRIVATE_KEY'],
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
      : {}),
  });
}

/** Logger that drops everything; handy in tests. */
export const silentLogger: Logger = pino({ level: 'silent' });
