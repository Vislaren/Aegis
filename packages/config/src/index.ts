import { z } from 'zod';

export const NODE_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export class ConfigError extends Error {
  constructor(
    readonly service: string,
    readonly problems: readonly string[],
  ) {
    // Only variable names and rule descriptions are reported, never values.
    super(`Invalid configuration for ${service}:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

/** Boolean env parsing that does not treat the string "false" as truthy. */
export const envBoolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const envPort = z.coerce.number().int().min(1).max(65_535);

export const envSeconds = z.coerce.number().int().positive();

/** Variables every Aegis service accepts. */
export const baseServiceEnv = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: envPort,
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
});

export type BaseServiceEnv = z.infer<typeof baseServiceEnv>;

/**
 * A production-safety rule: a predicate over the parsed configuration and a message when it fails.
 * Rules only run in staging and production, so local development keeps convenient defaults while
 * deployed environments can never fall back to them silently.
 */
export interface SafetyRule<T> {
  description: string;
  violated: (config: T) => boolean;
}

export function loadConfig<S extends z.ZodType<BaseServiceEnv>>(
  service: string,
  schema: S,
  env: Readonly<Record<string, string | undefined>>,
  safetyRules: ReadonlyArray<SafetyRule<z.infer<S>>> = [],
): z.infer<S> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new ConfigError(service, problems);
  }
  const config = parsed.data;
  if (config.NODE_ENV === 'staging' || config.NODE_ENV === 'production') {
    const violations = safetyRules
      .filter((rule) => rule.violated(config))
      .map((rule) => rule.description);
    if (violations.length > 0) throw new ConfigError(service, violations);
  }
  return config;
}

export function isDeployed(env: NodeEnv): boolean {
  return env === 'staging' || env === 'production';
}

/** Shared safety rules for values that commonly leak from development into deployments. */
export function commonSafetyRules<T extends Record<string, unknown>>(): SafetyRule<T>[] {
  return [
    {
      description: 'URLs must not point at localhost in deployed environments',
      violated: (config) =>
        Object.entries(config).some(
          ([key, value]) =>
            key.endsWith('_URL') &&
            typeof value === 'string' &&
            /localhost|127\.0\.0\.1/.test(value),
        ),
    },
  ];
}
