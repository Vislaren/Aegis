import { z } from 'zod';
import {
  baseServiceEnv,
  commonSafetyRules,
  envBoolean,
  envSeconds,
  loadConfig,
  type SafetyRule,
} from '@aegis/config';
import { serviceRuntimeEnv } from '@aegis/service-kit';

export const SERVICE_NAME = 'identity-service';

const base64Key32 = z
  .string()
  .refine(
    (value) => Buffer.from(value, 'base64').length === 32,
    'must be 32 bytes, base64-encoded',
  );

const schema = baseServiceEnv
  .extend(serviceRuntimeEnv.omit({ IDENTITY_JWKS_URL: true }).shape)
  .extend({
    IDENTITY_JWKS_URL: z.url().optional(),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
    /** Private ES256 JWK (with kid) used to sign access tokens. Rotate by publishing two keys. */
    ACCESS_TOKEN_SIGNING_KEY: z.string().min(10),
    /** Optional previous public JWK kept in the JWKS during rotation. */
    ACCESS_TOKEN_PREVIOUS_PUBLIC_KEY: z.string().optional(),
    ACCESS_TOKEN_TTL_SECONDS: envSeconds.default(300),
    /** Server-side pepper for keyed hashes of one-time codes and device identifiers. */
    OTP_PEPPER: z.string().min(32),
    /** AES-256-GCM key for TOTP secrets at rest. */
    MFA_ENCRYPTION_KEY: base64Key32,
    DELIVERY: z.enum(['smtp', 'memory']).default('smtp'),
    SMTP_URL: z
      .string()
      .regex(/^smtps?:\/\//)
      .optional(),
    MAIL_FROM: z.string().default('Aegis <no-reply@aegis.invalid>'),
    APP_PUBLIC_URL: z.url().default('http://localhost:8081'),
    COOKIE_SECURE: envBoolean.default(true),
  });

export type IdentityConfig = z.infer<typeof schema>;

const safetyRules: SafetyRule<IdentityConfig>[] = [
  ...commonSafetyRules<IdentityConfig>(),
  {
    description: 'DELIVERY=memory is not allowed in deployed environments',
    violated: (c) => c.DELIVERY === 'memory',
  },
  {
    description: 'COOKIE_SECURE must be true in deployed environments',
    violated: (c) => !c.COOKIE_SECURE,
  },
  {
    description: 'ACCESS_TOKEN_TTL_SECONDS must be at most 600',
    violated: (c) => c.ACCESS_TOKEN_TTL_SECONDS > 600,
  },
  {
    description: 'BROKER=memory is not allowed in deployed environments',
    violated: (c) => c.BROKER === 'memory',
  },
  {
    description:
      'Development SMTP capture (SMS-as-email) must not be used in deployed environments',
    violated: (c) => c.SMTP_URL?.includes('mailpit') === true,
  },
];

export function loadIdentityConfig(
  env: Readonly<Record<string, string | undefined>>,
): IdentityConfig {
  return loadConfig(SERVICE_NAME, schema, env, safetyRules);
}

export const IDENTITY_CONFIG = Symbol('IDENTITY_CONFIG');
