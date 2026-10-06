import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { EVENTS, eventRoutingKey } from '@aegis/contracts';
import { createLogger, startTracing } from '@aegis/observability';
import { RabbitMqBroker } from '@aegis/service-kit';
import { AuditModule, buildDependencies } from './app.module';
import { AuditService } from './audit.service';
import { SERVICE_NAME, loadAuditConfig } from './config';

/**
 * Consumes journal entries and security events from every producing service. Durable queue with
 * retries and a dead-letter queue: a journal record is never dropped silently.
 */
async function main(): Promise<void> {
  const config = loadAuditConfig(process.env);
  startTracing(`${SERVICE_NAME}-worker`, config.OTEL_EXPORTER_OTLP_ENDPOINT);
  const logger = createLogger({
    service: `${SERVICE_NAME}-worker`,
    level: config.LOG_LEVEL,
    environment: config.NODE_ENV,
  });
  if (config.AMQP_URL === undefined) throw new Error('AMQP_URL is required for the worker');

  const app = await NestFactory.createApplicationContext(
    AuditModule.register(await buildDependencies(config), { withHttp: false }),
    {
      logger: ['error', 'warn'],
    },
  );
  const auditService = app.get(AuditService);
  const broker = new RabbitMqBroker(config.AMQP_URL, logger);
  await broker.connect();
  await broker.subscribe(
    {
      queue: `${SERVICE_NAME}.events`,
      routingKeys: [eventRoutingKey('journalEntry'), eventRoutingKey('securityEvent')],
      durable: true,
      maxAttempts: 20,
    },
    async (envelope) => {
      if (envelope.type === EVENTS.journalEntry.type) await auditService.onJournalEntry(envelope);
      else if (envelope.type === EVENTS.securityEvent.type)
        await auditService.onSecurityEvent(envelope);
    },
  );

  const shutdown = async (): Promise<void> => {
    await broker.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  logger.info({}, 'worker started');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${SERVICE_NAME} worker failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
