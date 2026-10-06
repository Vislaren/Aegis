import 'reflect-metadata';
import rateLimit from '@fastify/rate-limit';
import { createLogger, startTracing } from '@aegis/observability';
import { createServiceApp, listen } from '@aegis/service-kit';
import { IdentityModule } from './app.module';
import { SERVICE_NAME, loadIdentityConfig } from './config';
import { PrismaService } from './infrastructure/prisma.service';
import { buildDependencies } from './runtime';

/** Sign-in endpoints get a much lower per-IP budget than the rest of the API. */
export const AUTH_RATE_LIMIT_PER_MINUTE = 10;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

async function main(): Promise<void> {
  const config = loadIdentityConfig(process.env);
  startTracing(SERVICE_NAME, config.OTEL_EXPORTER_OTLP_ENDPOINT);
  const logger = createLogger({
    service: SERVICE_NAME,
    level: config.LOG_LEVEL,
    environment: config.NODE_ENV,
  });
  const deps = await buildDependencies(config, logger);

  const app = await createServiceApp(
    IdentityModule.register({
      ...deps,
      readinessChecks: [
        {
          name: 'database',
          check: async () => {
            await app.get(PrismaService).$queryRawUnsafe('SELECT 1');
            return true;
          },
        },
      ],
    }),
    { serviceName: SERVICE_NAME, environment: config.NODE_ENV, logLevel: config.LOG_LEVEL },
  );

  // In-memory store per instance; deployed environments front this with the gateway's limits and
  // a shared Redis store (docs/operations/environment-variables.md).
  await app
    .getHttpAdapter()
    .getInstance()
    .register(rateLimit, {
      global: true,
      timeWindow: '1 minute',
      max: (request) =>
        request.url.startsWith('/api/v1/auth/')
          ? AUTH_RATE_LIMIT_PER_MINUTE
          : DEFAULT_RATE_LIMIT_PER_MINUTE,
      allowList: (request) =>
        request.url.startsWith('/internal/') || request.url.startsWith('/health/'),
    });

  await listen(app, config.PORT);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${SERVICE_NAME} failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
