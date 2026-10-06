import 'reflect-metadata';
import { createServiceApp, listen } from '@aegis/service-kit';
import { startTracing } from '@aegis/observability';
import { AdministrationModule } from './app.module';
import { SERVICE_NAME, loadAdministrationConfig } from './config';
import { PrismaService } from './infrastructure/prisma.service';
import { buildDependencies } from './runtime';

async function main(): Promise<void> {
  const config = loadAdministrationConfig(process.env);
  startTracing(SERVICE_NAME, config.OTEL_EXPORTER_OTLP_ENDPOINT);
  const deps = await buildDependencies(config);
  const app = await createServiceApp(
    AdministrationModule.register({
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
  await listen(app, config.PORT);
}

main().catch((error: unknown) => {
  // Configuration errors list variable names only; never values.
  process.stderr.write(
    `${SERVICE_NAME} failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
