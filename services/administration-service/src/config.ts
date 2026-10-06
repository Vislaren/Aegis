import { z } from 'zod';
import {
  baseServiceEnv,
  commonSafetyRules,
  envSeconds,
  loadConfig,
  type SafetyRule,
} from '@aegis/config';
import { serviceRuntimeEnv } from '@aegis/service-kit';
import { DEFAULT_LEASE_TIMING, validateLeaseTiming, type LeaseTimingConfig } from '@aegis/domain';

export const SERVICE_NAME = 'administration-service';

const schema = baseServiceEnv.extend(serviceRuntimeEnv.shape).extend({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
  IDENTITY_INTERNAL_URL: z.url(),
  LEASE_HEARTBEAT_SECONDS: envSeconds.default(DEFAULT_LEASE_TIMING.heartbeatIntervalSeconds),
  LEASE_TTL_SECONDS: envSeconds.default(DEFAULT_LEASE_TIMING.leaseTtlSeconds),
  LEASE_IDLE_TIMEOUT_SECONDS: envSeconds.default(DEFAULT_LEASE_TIMING.idleTimeoutSeconds),
  MFA_FRESHNESS_SECONDS: envSeconds.default(DEFAULT_LEASE_TIMING.mfaFreshnessSeconds),
});

export type AdministrationConfig = z.infer<typeof schema>;

const safetyRules: SafetyRule<AdministrationConfig>[] = [
  ...commonSafetyRules<AdministrationConfig>(),
  {
    description: 'BROKER=memory is not allowed in deployed environments',
    violated: (c) => c.BROKER === 'memory',
  },
  {
    description: 'AMQP_URL is required in deployed environments',
    violated: (c) => c.AMQP_URL === undefined,
  },
  {
    description: 'AMQP_URL must use TLS (amqps://) in deployed environments',
    violated: (c) => c.AMQP_URL !== undefined && !c.AMQP_URL.startsWith('amqps://'),
  },
];

export function loadAdministrationConfig(
  env: Readonly<Record<string, string | undefined>>,
): AdministrationConfig {
  const config = loadConfig(SERVICE_NAME, schema, env, safetyRules);
  const problems = validateLeaseTiming(leaseTiming(config));
  if (problems.length > 0) throw new Error(`Invalid lease timing: ${problems.join('; ')}`);
  return config;
}

export function leaseTiming(config: AdministrationConfig): LeaseTimingConfig {
  return {
    heartbeatIntervalSeconds: config.LEASE_HEARTBEAT_SECONDS,
    leaseTtlSeconds: config.LEASE_TTL_SECONDS,
    idleTimeoutSeconds: config.LEASE_IDLE_TIMEOUT_SECONDS,
    mfaFreshnessSeconds: config.MFA_FRESHNESS_SECONDS,
  };
}

export const ADMINISTRATION_CONFIG = Symbol('ADMINISTRATION_CONFIG');
