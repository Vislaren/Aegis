import type { JWK } from 'jose';
import type { Logger } from '@aegis/observability';
import {
  AccessTokenSigner,
  ServiceTokenVerifier,
  createAccessTokenVerifier,
} from '@aegis/service-kit';
import type { IdentityDependencies } from './app.module';
import { SERVICE_NAME, type IdentityConfig } from './config';
import {
  DeliveryDispatcher,
  InMemoryDelivery,
  SmtpDevDelivery,
  type MessageDelivery,
} from './infrastructure/delivery';
import { buildJwks } from './infrastructure/jwks';
import { OtplibTotp } from './infrastructure/totp';

function parseJwk(value: string, name: string): JWK {
  try {
    return JSON.parse(value) as JWK;
  } catch {
    throw new Error(`${name} must be a JSON Web Key`);
  }
}

export async function buildDependencies(
  config: IdentityConfig,
  logger: Pick<Logger, 'warn' | 'error'>,
): Promise<IdentityDependencies> {
  const signingKey = parseJwk(config.ACCESS_TOKEN_SIGNING_KEY, 'ACCESS_TOKEN_SIGNING_KEY');
  const previous =
    config.ACCESS_TOKEN_PREVIOUS_PUBLIC_KEY === undefined
      ? undefined
      : parseJwk(config.ACCESS_TOKEN_PREVIOUS_PUBLIC_KEY, 'ACCESS_TOKEN_PREVIOUS_PUBLIC_KEY');
  const jwks = buildJwks(signingKey, previous);

  let delivery: MessageDelivery;
  if (config.DELIVERY === 'memory') delivery = new InMemoryDelivery();
  else {
    if (config.SMTP_URL === undefined) throw new Error('SMTP_URL is required when DELIVERY=smtp');
    delivery = new SmtpDevDelivery(config.SMTP_URL, config.MAIL_FROM, logger);
  }

  return {
    config,
    signer: await AccessTokenSigner.fromJwk(signingKey, config.ACCESS_TOKEN_ISSUER),
    jwks,
    accessTokenVerifier: createAccessTokenVerifier({ issuer: config.ACCESS_TOKEN_ISSUER, jwks }),
    serviceTokenVerifier: await ServiceTokenVerifier.create(
      SERVICE_NAME,
      config.TRUSTED_SERVICE_KEYS,
    ),
    dispatcher: new DeliveryDispatcher(delivery, logger),
    totp: new OtplibTotp(),
  };
}
