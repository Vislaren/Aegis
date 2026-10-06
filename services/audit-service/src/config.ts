import { z } from 'zod';
import { baseServiceEnv, commonSafetyRules, loadConfig, type SafetyRule } from '@aegis/config';
import { serviceRuntimeEnv } from '@aegis/service-kit';

export const SERVICE_NAME = 'audit-service';

const schema = baseServiceEnv.extend(serviceRuntimeEnv.shape).extend({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
  ADMINISTRATION_INTERNAL_URL: z.url(),
});

export type AuditConfig = z.infer<typeof schema>;

const safetyRules: SafetyRule<AuditConfig>[] = [
  ...commonSafetyRules<AuditConfig>(),
  {
    description: 'BROKER=memory is not allowed in deployed environments',
    violated: (c) => c.BROKER === 'memory',
  },
];

export function loadAuditConfig(env: Readonly<Record<string, string | undefined>>): AuditConfig {
  return loadConfig(SERVICE_NAME, schema, env, safetyRules);
}

export const AUDIT_CONFIG = Symbol('AUDIT_CONFIG');
