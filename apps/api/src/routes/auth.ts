import type { AuthResponse, UserDto } from '@chainguard/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth/password';
import { HttpError, parse, requireAuth } from '../http';
import type { AppDeps } from '../app';

const Credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((e) => e.trim().toLowerCase()),
  password: z.string().min(1).max(128),
});

const Registration = z.object({
  email: z
    .email()
    .max(254)
    .transform((e) => e.trim().toLowerCase()),
  password: z.string().min(10, 'Use at least 10 characters').max(128),
  name: z.string().trim().min(1).max(80).optional(),
});

// Equalises timing between unknown emails and wrong passwords.
const DUMMY_HASH = hashPassword('timing-equaliser');

export async function authRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { repos, tokens } = deps;
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  const respond = async (user: UserDto): Promise<AuthResponse> => ({
    token: await tokens.sign({ sub: user.id, email: user.email }),
    user,
  });

  app.post('/auth/register', limited, async (req, reply) => {
    const body = parse(Registration, req.body);
    const user = await repos.users.create({
      email: body.email,
      name: body.name ?? null,
      passwordHash: await hashPassword(body.password),
    });
    if (!user) throw new HttpError(409, 'email_taken', 'An account with that email already exists');
    reply.code(201);
    return respond(user);
  });

  app.post('/auth/login', limited, async (req) => {
    const body = parse(Credentials, req.body);
    const user = await repos.users.findByEmail(body.email);
    const ok = await verifyPassword(body.password, user?.passwordHash ?? (await DUMMY_HASH));
    if (!user || !ok || user.isDemo) {
      throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
    }
    const { passwordHash: _omit, ...dto } = user;
    return respond(dto);
  });

  app.post('/auth/demo', limited, async () => {
    if (!deps.config.SEED_DEMO)
      throw new HttpError(404, 'demo_disabled', 'The demo account is disabled');
    const user = await repos.users.findDemo();
    if (!user)
      throw new HttpError(503, 'demo_unavailable', 'The demo account has not been seeded yet');
    return respond(user);
  });

  app.get('/me', { preHandler: requireAuth(tokens) }, async (req) => {
    const user = await repos.users.findById(req.userId);
    if (!user) throw new HttpError(401, 'unauthorized', 'Account no longer exists');
    return user;
  });
}
