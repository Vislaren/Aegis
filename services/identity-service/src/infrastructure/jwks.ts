import type { JWK } from 'jose';
import { publicJwk } from '@aegis/service-kit';

export interface JwksDocument {
  keys: JWK[];
}

export const JWKS_DOCUMENT = Symbol('JWKS_DOCUMENT');

/**
 * JWKS with the current signing key and, during rotation, the previous public key, so tokens
 * signed before a rotation stay verifiable until they expire (at most ACCESS_TOKEN_TTL_SECONDS).
 */
export function buildJwks(signingKey: JWK, previousPublicKey?: JWK): JwksDocument {
  const keys = [publicJwk(signingKey)];
  if (previousPublicKey !== undefined) keys.push(publicJwk(previousPublicKey));
  return { keys };
}
