import { eventRoutingKey, type EventName } from '@aegis/contracts';

export {
  AccessTokenSigner,
  AppError,
  InMemoryBroker,
  createAccessTokenVerifier,
  createEnvelope,
  generateSigningJwk,
  publicJwk,
} from '@aegis/service-kit';

export function eventRoutingKeyFor(name: EventName): string {
  return eventRoutingKey(name);
}
