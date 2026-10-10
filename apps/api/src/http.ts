import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TokenService } from './auth/tokens';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Validates untrusted input at the API boundary; 400 with field-level issues on failure. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(
      400,
      'invalid_request',
      'Request validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

/** preHandler: requires `Authorization: Bearer <jwt>`. */
export function requireAuth(tokens: TokenService) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const claims = token ? await tokens.verify(token) : null;
    if (!claims) throw new HttpError(401, 'unauthorized', 'Sign in to continue');
    req.userId = claims.sub;
  };
}

export const uuidParam = z.object({ id: z.uuid() });
