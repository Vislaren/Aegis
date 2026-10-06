import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { EVENTS, eventRoutingKey } from '@aegis/contracts';
import { createLogger, startTracing } from '@aegis/observability';
import { OutboxRelay, RabbitMqBroker } from '@aegis/service-kit';
import { IdentityModule } from './app.module';
import { ProvisioningService } from './application/provisioning.service';
import { SERVICE_NAME, loadIdentityConfig } from './config';
import { PrismaService } from './infrastructure/prisma.service';
import { buildDependencies } from './runtime';

/** identity-service background process: outbox relay, invitation consumers, expiry housekeeping. */
async function main(): Promise<void> {
  const config = loadIdentityConfig(process.env);
  startTracing(`${SERVICE_NAME}-worker`, config.OTEL_EXPORTER_OTLP_ENDPOINT);
  const logger = createLogger({
    service: `${SERVICE_NAME}-worker`,
    level: config.LOG_LEVEL,
    environment: config.NODE_ENV,
  });
  if (config.AMQP_URL === undefined) throw new Error('AMQP_URL is required for the worker');

  const app = await NestFactory.createApplicationContext(
    IdentityModule.register(await buildDependencies(config, logger), { withHttp: false }),
    { logger: ['error', 'warn'] },
  );
  const provisioning = app.get(ProvisioningService);
  const prisma = app.get(PrismaService);

  const broker = new RabbitMqBroker(config.AMQP_URL, logger);
  await broker.connect();
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 4 });
  const relay = new OutboxRelay(pool, broker, logger);
  relay.start(250);

  await broker.subscribe(
    {
      queue: `${SERVICE_NAME}.events`,
      routingKeys: [eventRoutingKey('invitationRequested'), eventRoutingKey('invitationCancelled')],
      durable: true,
    },
    async (envelope) => {
      if (envelope.type === EVENTS.invitationRequested.type)
        await provisioning.onInvitationRequested(envelope);
      else if (envelope.type === EVENTS.invitationCancelled.type)
        await provisioning.onInvitationCancelled(envelope);
    },
  );

  // Housekeeping only: every expiry is also enforced when a token or session is used.
  const housekeeping = setInterval(() => {
    const now = new Date();
    void Promise.all([
      prisma.invitation.updateMany({
        where: { status: 'PENDING', expiresAt: { lte: now } },
        data: { status: 'EXPIRED' },
      }),
      prisma.session.updateMany({
        where: { status: 'ACTIVE', absoluteExpiresAt: { lte: now } },
        data: { status: 'EXPIRED' },
      }),
    ]).catch((error: unknown) => logger.error({ err: error }, 'identity housekeeping failed'));
  }, 60_000);

  const shutdown = async (): Promise<void> => {
    clearInterval(housekeeping);
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
