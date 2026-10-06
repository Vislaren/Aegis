import {
  InternalServiceClient,
  ServiceTokenSigner,
  ServiceTokenVerifier,
  createAccessTokenVerifier,
} from '@aegis/service-kit';
import type { AdministrationDependencies } from './app.module';
import { SERVICE_NAME, type AdministrationConfig } from './config';
import { HttpIdentityClient } from './infrastructure/identity.client';

/** Production wiring from validated configuration. */
export async function buildDependencies(
  config: AdministrationConfig,
): Promise<AdministrationDependencies> {
  const signer = await ServiceTokenSigner.fromJwk(SERVICE_NAME, config.SERVICE_PRIVATE_KEY);
  const identity = new HttpIdentityClient(
    new InternalServiceClient({
      baseUrl: config.IDENTITY_INTERNAL_URL,
      callee: 'identity-service',
      signer,
      timeoutMs: 3000,
    }),
  );
  return {
    config,
    identity,
    accessTokenVerifier: createAccessTokenVerifier({
      issuer: config.ACCESS_TOKEN_ISSUER,
      jwksUrl: config.IDENTITY_JWKS_URL,
    }),
    serviceTokenVerifier: await ServiceTokenVerifier.create(
      SERVICE_NAME,
      config.TRUSTED_SERVICE_KEYS,
    ),
  };
}
