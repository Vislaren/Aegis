import { z } from 'zod';
import { baseServiceEnv, commonSafetyRules, envBoolean, loadConfig } from '@aegis/config';
import { buildOpenApiDocument } from '@aegis/contracts/dist/openapi';
import { startTracing } from '@aegis/observability';
import { buildGateway } from './gateway';

const SERVICE_NAME = 'api-gateway';

const schema = baseServiceEnv.extend({
  IDENTITY_URL: z.url(),
  ADMINISTRATION_URL: z.url(),
  AUDIT_URL: z.url(),
  REALTIME_URL: z.url(),
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:8081')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  PUBLISH_OPENAPI: envBoolean.default(true),
});

async function main(): Promise<void> {
  const config = loadConfig(SERVICE_NAME, schema, process.env, [
    ...commonSafetyRules(),
    {
      description: 'ALLOWED_ORIGINS must use https in deployed environments',
      violated: (c) => c.ALLOWED_ORIGINS.some((o) => !o.startsWith('https://')),
    },
    {
      description: 'PUBLISH_OPENAPI must be false in production',
      violated: (c) => c.NODE_ENV === 'production' && c.PUBLISH_OPENAPI,
    },
  ]);
  startTracing(SERVICE_NAME, config.OTEL_EXPORTER_OTLP_ENDPOINT);
  const app = await buildGateway({
    serviceName: SERVICE_NAME,
    environment: config.NODE_ENV,
    logLevel: config.LOG_LEVEL,
    upstreams: {
      identity: config.IDENTITY_URL,
      administration: config.ADMINISTRATION_URL,
      audit: config.AUDIT_URL,
      realtime: config.REALTIME_URL,
    },
    allowedOrigins: config.ALLOWED_ORIGINS,
    rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
    authRateLimitPerMinute: config.AUTH_RATE_LIMIT_PER_MINUTE,
    openApiDocument: config.PUBLISH_OPENAPI ? buildOpenApiDocument() : null,
  });
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${SERVICE_NAME} failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
