import { SignJWT, jwtVerify } from 'jose';

const ISSUER = 'chainguard-api';
const TTL = '12h';

export interface TokenClaims {
  sub: string;
  email: string;
}

export class TokenService {
  readonly #key: Uint8Array;

  constructor(secret: string) {
    this.#key = new TextEncoder().encode(secret);
  }

  sign(claims: TokenClaims): Promise<string> {
    return new SignJWT({ email: claims.email })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(TTL)
      .sign(this.#key);
  }

  /** Returns the claims, or null for any invalid/expired token. */
  async verify(token: string): Promise<TokenClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.#key, {
        issuer: ISSUER,
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
      return { sub: payload.sub, email: payload.email };
    } catch {
      return null;
    }
  }
}
