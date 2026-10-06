import { z } from 'zod';
import type { JWK } from 'jose';

const jwkJson = z
  .string()
  .min(10)
  .transform((value, ctx): JWK => {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== 'object' || parsed === null || !('kty' in parsed))
        throw new Error('not a JWK');
      return parsed as JWK;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a JSON Web Key' });
      return z.NEVER;
    }
  });

const jwkMapJson = z
  .string()
  .default('{}')
  .transform((value, ctx): Record<string, JWK | JWK[]> => {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('not a map');
      return parsed as Record<string, JWK | JWK[]>;
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'must be a JSON object of service name to a public JWK or a list of public JWKs',
      });
      return z.NEVER;
    }
  });

/** Environment shared by every backend service (see docs/operations/environment-variables.md). */
export const serviceRuntimeEnv = z.object({
  SERVICE_NAME: z.string().min(3),
  /** This service's private ES256 JWK for signing service-to-service tokens. */
  SERVICE_PRIVATE_KEY: jwkJson,
  /** Public JWKs of services allowed to call this service's internal API. */
  TRUSTED_SERVICE_KEYS: jwkMapJson,
  ACCESS_TOKEN_ISSUER: z.string().min(3).default('https://identity.aegis.local'),
  IDENTITY_JWKS_URL: z.url(),
  AMQP_URL: z
    .string()
    .regex(/^amqps?:\/\//)
    .optional(),
  BROKER: z.enum(['rabbitmq', 'memory']).default('rabbitmq'),
});

export type ServiceRuntimeEnv = z.infer<typeof serviceRuntimeEnv>;
