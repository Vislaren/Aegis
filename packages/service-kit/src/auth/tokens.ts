import { randomUUID } from 'node:crypto';
import {
  SignJWT,
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import type { z } from 'zod';
import { identity } from '@aegis/contracts';

type AccessClaims = z.infer<typeof identity.AccessTokenClaims>;
/** Key material as returned by jose's importJWK (a WebCrypto CryptoKey for EC keys). */
type SigningKey = Awaited<ReturnType<typeof importJWK>>;

export const ACCESS_TOKEN_ALG = 'ES256';
export const ACCESS_TOKEN_AUDIENCE = 'aegis-api';

export interface AuthContext {
  userId: string;
  sessionId: string;
  aal: 1 | 2;
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<AuthContext>;
}

export class InvalidTokenError extends Error {
  constructor() {
    super('invalid token');
    this.name = 'InvalidTokenError';
  }
}

/** Verifies ES256 access tokens against the identity-service JWKS. */
export function createAccessTokenVerifier(options: {
  issuer: string;
  jwksUrl?: string;
  jwks?: { keys: JWK[] };
}): AccessTokenVerifier {
  let keySet: JWTVerifyGetKey;
  if (options.jwks !== undefined) keySet = createLocalJWKSet(options.jwks);
  else if (options.jwksUrl !== undefined)
    keySet = createRemoteJWKSet(new URL(options.jwksUrl), { cooldownDuration: 30_000 });
  else throw new Error('jwksUrl or jwks is required');

  return {
    async verify(token: string): Promise<AuthContext> {
      try {
        const { payload } = await jwtVerify(token, keySet, {
          issuer: options.issuer,
          audience: ACCESS_TOKEN_AUDIENCE,
          algorithms: [ACCESS_TOKEN_ALG],
          clockTolerance: 5,
        });
        const claims: AccessClaims = identity.AccessTokenClaims.parse(payload);
        return { userId: claims.sub, sessionId: claims.sid, aal: claims.aal };
      } catch {
        throw new InvalidTokenError();
      }
    },
  };
}

/** Signs access tokens. Lives in identity-service only; exported here for tests and tooling. */
export class AccessTokenSigner {
  private constructor(
    private readonly key: SigningKey,
    private readonly kid: string,
    private readonly issuer: string,
  ) {}

  static async fromJwk(privateJwk: JWK, issuer: string): Promise<AccessTokenSigner> {
    if (privateJwk.kid === undefined) throw new Error('signing JWK must have a kid');
    const key = (await importJWK(privateJwk, ACCESS_TOKEN_ALG)) as SigningKey;
    return new AccessTokenSigner(key, privateJwk.kid, issuer);
  }

  async sign(
    claims: Pick<identity.SessionIntrospection, 'userId' | 'sessionId'> & { aal: 1 | 2 },
    ttlSeconds: number,
  ): Promise<{ token: string; expiresAt: Date }> {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sid: claims.sessionId, aal: claims.aal })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALG, kid: this.kid, typ: 'at+jwt' })
      .setSubject(claims.userId)
      .setIssuer(this.issuer)
      .setAudience(ACCESS_TOKEN_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .setJti(randomUUID())
      .sign(this.key);
    return { token, expiresAt: new Date((now + ttlSeconds) * 1000) };
  }
}

/** Public JWK (no private members) suitable for a JWKS document. */
export function publicJwk(privateJwk: JWK): JWK {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...rest } = privateJwk;
  return { ...rest, use: 'sig', alg: ACCESS_TOKEN_ALG };
}

export async function generateSigningJwk(kid: string): Promise<JWK> {
  const { privateKey } = await generateKeyPair(ACCESS_TOKEN_ALG, { extractable: true });
  const jwk = await exportJWK(privateKey);
  return { ...jwk, kid, alg: ACCESS_TOKEN_ALG };
}

// ---------- Service-to-service tokens ----------

const SERVICE_TOKEN_TTL_SECONDS = 60;
export const SERVICE_TOKEN_HEADER = 'x-service-token';

/**
 * Each service signs short-lived ES256 tokens with its own private key (iss = caller,
 * aud = callee). Callees trust an explicit allowlist of caller public keys, so a compromised
 * callee cannot impersonate other services.
 */
export class ServiceTokenSigner {
  private constructor(
    private readonly key: SigningKey,
    readonly serviceName: string,
  ) {}

  static async fromJwk(serviceName: string, privateJwk: JWK): Promise<ServiceTokenSigner> {
    return new ServiceTokenSigner(
      (await importJWK(privateJwk, ACCESS_TOKEN_ALG)) as SigningKey,
      serviceName,
    );
  }

  async tokenFor(callee: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALG, typ: 'svc+jwt' })
      .setIssuer(this.serviceName)
      .setAudience(callee)
      .setIssuedAt(now)
      .setExpirationTime(now + SERVICE_TOKEN_TTL_SECONDS)
      .setJti(randomUUID())
      .sign(this.key);
  }
}

export class ServiceTokenVerifier {
  private constructor(
    private readonly serviceName: string,
    private readonly trusted: ReadonlyMap<string, readonly SigningKey[]>,
  ) {}

  /** Each caller may list several public keys, so keys can be rotated without downtime. */
  static async create(
    serviceName: string,
    trustedCallers: Record<string, JWK | JWK[]>,
  ): Promise<ServiceTokenVerifier> {
    const entries = await Promise.all(
      Object.entries(trustedCallers).map(async ([caller, value]) => {
        const jwks = Array.isArray(value) ? value : [value];
        const keys = await Promise.all(
          jwks.map(
            async (jwk) => (await importJWK(publicJwk(jwk), ACCESS_TOKEN_ALG)) as SigningKey,
          ),
        );
        return [caller, keys] as const;
      }),
    );
    return new ServiceTokenVerifier(serviceName, new Map(entries));
  }

  /** Returns the authenticated caller service name, or throws InvalidTokenError. */
  async verify(token: string): Promise<string> {
    const unverified = decodeIssuer(token);
    const keys = unverified === null ? undefined : this.trusted.get(unverified);
    if (keys === undefined) throw new InvalidTokenError();
    for (const key of keys) {
      try {
        const { payload } = await jwtVerify(token, key, {
          audience: this.serviceName,
          issuer: unverified ?? '',
          algorithms: [ACCESS_TOKEN_ALG],
          maxTokenAge: SERVICE_TOKEN_TTL_SECONDS + 5,
          clockTolerance: 5,
        });
        return String(payload.iss);
      } catch {
        // Try the next trusted key for this caller.
      }
    }
    throw new InvalidTokenError();
  }
}

function decodeIssuer(token: string): string | null {
  const [, payload] = token.split('.');
  if (payload === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && 'iss' in parsed
      ? String(parsed.iss)
      : null;
  } catch {
    return null;
  }
}
