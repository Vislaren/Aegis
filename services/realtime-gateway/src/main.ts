import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { administration, identity } from '@aegis/contracts';
import { baseServiceEnv, commonSafetyRules, loadConfig } from '@aegis/config';
import { createLogger, startTracing } from '@aegis/observability';
import {
  AppError,
  InternalServiceClient,
  RabbitMqBroker,
  ServiceKitModule,
  ServiceTokenSigner,
  createAccessTokenVerifier,
  createServiceApp,
  listen,
  serviceRuntimeEnv,
} from '@aegis/service-kit';
import { RealtimeHub, type LeaseValidator, type SessionChecker } from './realtime-hub';

const SERVICE_NAME = 'realtime-gateway';

const schema = baseServiceEnv.extend(serviceRuntimeEnv.shape).extend({
  ADMINISTRATION_INTERNAL_URL: z.url(),
  IDENTITY_INTERNAL_URL: z.url(),
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:8081')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  REVALIDATE_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
});

@Module({})
class RealtimeShellModule {}

async function main(): Promise<void> {
  const config = loadConfig(SERVICE_NAME, schema, process.env, [
    ...commonSafetyRules(),
    {
      description: 'ALLOWED_ORIGINS must use https in deployed environments',
      violated: (c) => c.ALLOWED_ORIGINS.some((o) => !o.startsWith('https://')),
    },
  ]);
  startTracing(SERVICE_NAME, config.OTEL_EXPORTER_OTLP_ENDPOINT);
  const logger = createLogger({
    service: SERVICE_NAME,
    level: config.LOG_LEVEL,
    environment: config.NODE_ENV,
  });
  if (config.AMQP_URL === undefined) throw new Error('AMQP_URL is required');

  const signer = await ServiceTokenSigner.fromJwk(SERVICE_NAME, config.SERVICE_PRIVATE_KEY);
  const adminClient = new InternalServiceClient({
    baseUrl: config.ADMINISTRATION_INTERNAL_URL,
    callee: 'administration-service',
    signer,
  });
  const identityClient = new InternalServiceClient({
    baseUrl: config.IDENTITY_INTERNAL_URL,
    callee: 'identity-service',
    signer,
  });
  const accessTokenVerifier = createAccessTokenVerifier({
    issuer: config.ACCESS_TOKEN_ISSUER,
    jwksUrl: config.IDENTITY_JWKS_URL,
  });

  const leases: LeaseValidator = {
    async validate(input, correlationId) {
      const result = await adminClient.call(
        'POST',
        '/internal/v1/privileged-access/validate',
        { correlationId },
        administration.ValidateLeaseResponse,
        input,
      );
      if (!result.ok)
        throw new AppError(
          result.problem?.code === 'PRIVILEGED_LEASE_LOST'
            ? 'PRIVILEGED_LEASE_LOST'
            : 'PRIVILEGED_LEASE_REQUIRED',
        );
      return result.data.lease;
    },
  };
  const sessions: SessionChecker = {
    async isActive(sessionId, userId, correlationId) {
      const result = await identityClient.call(
        'GET',
        `/internal/v1/sessions/${encodeURIComponent(sessionId)}`,
        { correlationId },
        identity.SessionIntrospection,
      );
      return result.ok && result.data.active && result.data.userId === userId;
    },
  };

  // The HTTP surface is health endpoints only; realtime traffic is handled by Socket.IO below.
  const app = await createServiceApp(
    {
      module: RealtimeShellModule,
      imports: [ServiceKitModule.forRoot({ accessTokenVerifier, serviceTokenVerifier: null })],
    },
    { serviceName: SERVICE_NAME, environment: config.NODE_ENV, logLevel: config.LOG_LEVEL },
  );
  await app.init();
  const hub = new RealtimeHub(app.getHttpServer(), accessTokenVerifier, sessions, leases, logger, {
    allowedOrigins: config.ALLOWED_ORIGINS,
    revalidateIntervalMs: config.REVALIDATE_INTERVAL_SECONDS * 1000,
  });
  const broker = new RabbitMqBroker(config.AMQP_URL, logger);
  await broker.connect();
  await hub.attachBroker(broker);
  hub.start();
  await listen(app, config.PORT);

  const shutdown = async (): Promise<void> => {
    await hub.close();
    await broker.close();
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
