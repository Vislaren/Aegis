import 'reflect-metadata';
import { startTracing } from '@aegis/observability';
import { createServiceApp, listen } from '@aegis/service-kit';
import { AuditModule, buildDependencies } from './app.module';
import { SERVICE_NAME, loadAuditConfig } from './config';
import { PrismaService } from './infrastructure';

async function main(): Promise<void> {
  const config = loadAuditConfig(process.env);
  startTracing(SERVICE_NAME, config.OTEL_EXPORTER_OTLP_ENDPOINT);
  const app = await createServiceApp(
    AuditModule.register({
      ...(await buildDependencies(config)),
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
  process.stderr.write(
    `${SERVICE_NAME} failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
