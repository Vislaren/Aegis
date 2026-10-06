import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { eventRoutingKey, EVENTS } from '@aegis/contracts';
import { createLogger, startTracing } from '@aegis/observability';
import { OutboxRelay, RabbitMqBroker } from '@aegis/service-kit';
import { AdministrationModule } from './app.module';
import { AdministrationEventHandlers } from './application/event-handlers';
import { SERVICE_NAME, loadAdministrationConfig } from './config';
import { PrismaService } from './infrastructure/prisma.service';
import { buildDependencies } from './runtime';

/**
 * Background process for administration-service: outbox relay, event consumers, and the lease
 * sweeper. Scales independently of the API process; correctness never depends on it running
 * promptly (leases are validated on every use).
 */
async function main(): Promise<void> {
  const config = loadAdministrationConfig(process.env);
  startTracing(`${SERVICE_NAME}-worker`, config.OTEL_EXPORTER_OTLP_ENDPOINT);
  const logger = createLogger({
    service: `${SERVICE_NAME}-worker`,
    level: config.LOG_LEVEL,
    environment: config.NODE_ENV,
  });
  if (config.AMQP_URL === undefined) throw new Error('AMQP_URL is required for the worker');

  const app = await NestFactory.createApplicationContext(
    AdministrationModule.register(await buildDependencies(config), { withHttp: false }),
    { logger: ['error', 'warn'] },
  );
  const handlers = app.get(AdministrationEventHandlers);
  const prisma = app.get(PrismaService);

  const broker = new RabbitMqBroker(config.AMQP_URL, logger);
  await broker.connect();
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 4 });
  const relay = new OutboxRelay(pool, broker, logger);
  relay.start(250);

  await broker.subscribe(
    {
      queue: `${SERVICE_NAME}.events`,
      routingKeys: [eventRoutingKey('invitationAccepted'), eventRoutingKey('sessionRevoked')],
      durable: true,
    },
    async (envelope) => {
      if (envelope.type === EVENTS.invitationAccepted.type)
        await handlers.onInvitationAccepted(envelope);
      else if (envelope.type === EVENTS.sessionRevoked.type)
        await handlers.onSessionRevoked(envelope);
    },
  );

  const sweep = setInterval(() => {
    prisma
      .$queryRawUnsafe<Array<{ swept: number }>>('SELECT aegis_sweep_expired_leases() AS swept')
      .then((rows) => {
        const swept = rows[0]?.swept ?? 0;
        if (swept > 0) logger.info({ swept }, 'expired privileged leases closed');
      })
      .catch((error: unknown) => logger.error({ err: error }, 'lease sweep failed'));
  }, 60_000);

  const shutdown = async (): Promise<void> => {
    clearInterval(sweep);
    relay.stop();
    await broker.close();
    await pool.end();
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
