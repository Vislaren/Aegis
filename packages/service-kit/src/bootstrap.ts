import 'reflect-metadata';
import {
  Controller,
  Get,
  Inject,
  Module,
  Optional,
  type DynamicModule,
  type INestApplication,
  type Provider,
  type Type,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loggerOptions } from '@aegis/observability';
import { AppError } from './errors';
import { correlationIdFor } from './http/correlation';
import { ProblemDetailsFilter } from './http/problem-filter';
import { ResponseValidationInterceptor } from './http/validation';
import { ACCESS_TOKEN_VERIFIER, AuthGuard, Public, SERVICE_TOKEN_VERIFIER } from './auth/guards';
import type { AccessTokenVerifier, ServiceTokenVerifier } from './auth/tokens';

export const READINESS_CHECKS = Symbol('READINESS_CHECKS');

export interface ReadinessCheck {
  name: string;
  check(): Promise<boolean>;
}

@Controller('health')
@Public()
class HealthController {
  constructor(
    @Optional() @Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[] | null,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: Record<string, boolean> }> {
    const results: Record<string, boolean> = {};
    for (const check of this.checks ?? []) {
      results[check.name] = await check.check().catch(() => false);
    }
    if (Object.values(results).some((ok) => !ok)) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', { internalReason: JSON.stringify(results) });
    }
    return { status: 'ok', checks: results };
  }
}

export interface ServiceKitOptions {
  accessTokenVerifier: AccessTokenVerifier;
  serviceTokenVerifier: ServiceTokenVerifier | null;
  readinessChecks?: ReadinessCheck[];
}

/**
 * Registers deny-by-default authentication, problem-details errors, response-contract
 * enforcement, and health endpoints for a service.
 */
@Module({})
export class ServiceKitModule {
  static forRoot(options: ServiceKitOptions): DynamicModule {
    const providers: Provider[] = [
      { provide: ACCESS_TOKEN_VERIFIER, useValue: options.accessTokenVerifier },
      { provide: SERVICE_TOKEN_VERIFIER, useValue: options.serviceTokenVerifier },
      { provide: READINESS_CHECKS, useValue: options.readinessChecks ?? [] },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      { provide: APP_INTERCEPTOR, useClass: ResponseValidationInterceptor },
    ];
    return {
      module: ServiceKitModule,
      global: true,
      controllers: [HealthController],
      providers,
      exports: [ACCESS_TOKEN_VERIFIER, SERVICE_TOKEN_VERIFIER, READINESS_CHECKS],
    };
  }
}

export interface CreateServiceAppOptions {
  serviceName: string;
  environment: string;
  logLevel: string;
  /** Default 64 KiB: Phase 1 APIs never need large bodies. */
  bodyLimit?: number;
  /** Proxies whose X-Forwarded-For is trusted. Never trust arbitrary hops: client IPs feed rate limits and audit. */
  trustProxy?: boolean | string;
}

export async function createServiceApp(
  module: Type<unknown> | DynamicModule,
  options: CreateServiceAppOptions,
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    logger: loggerOptions({
      service: options.serviceName,
      level: options.logLevel,
      environment: options.environment,
    }),
    genReqId: correlationIdFor,
    bodyLimit: options.bodyLimit ?? 64 * 1024,
    trustProxy: options.trustProxy ?? 'loopback,uniquelocal',
    return503OnClosing: true,
  });
  const app = await NestFactory.create<NestFastifyApplication>(module, adapter, {
    logger: ['error', 'warn'],
    abortOnError: false,
  });
  const fastify = app.getHttpAdapter().getInstance();
  // Set in onRequest: headers set here persist to the response without touching the payload.
  fastify.addHook('onRequest', async (request, reply) => {
    void reply.header('x-correlation-id', request.id);
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('cache-control', 'no-store');
  });
  app.enableShutdownHooks();
  return app;
}

export async function listen(app: INestApplication, port: number): Promise<void> {
  await app.listen(port, '0.0.0.0');
}
