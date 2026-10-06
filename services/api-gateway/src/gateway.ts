import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import proxy from '@fastify/http-proxy';
import rateLimit from '@fastify/rate-limit';
import { loggerOptions } from '@aegis/observability';
import { AppError, SERVICE_TOKEN_HEADER, correlationIdFor } from '@aegis/service-kit';
import { ROUTES, checkCsrf, isBlockedPath, type Upstream } from './routing';

export interface GatewayOptions {
  serviceName: string;
  environment: string;
  logLevel: string;
  upstreams: Record<Upstream, string>;
  allowedOrigins: readonly string[];
  rateLimitPerMinute: number;
  authRateLimitPerMinute: number;
  openApiDocument: object | null;
}

function problem(error: AppError, correlationId: string) {
  return error.toProblem(correlationId);
}

/**
 * The public edge. It filters and forwards; it never grants access. Every upstream service
 * authenticates the bearer token and authorizes the request itself.
 */
export async function buildGateway(options: GatewayOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions({
      service: options.serviceName,
      level: options.logLevel,
      environment: options.environment,
    }),
    genReqId: correlationIdFor,
    bodyLimit: 64 * 1024,
    // Only the load balancer (private address space) may set X-Forwarded-For; client IPs drive rate limits.
    trustProxy: 'loopback,uniquelocal',
    return503OnClosing: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: (origin, callback) =>
      callback(null, origin === undefined || options.allowedOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'idempotency-key',
      'x-csrf-token',
      'x-correlation-id',
    ],
    exposedHeaders: ['x-correlation-id', 'idempotent-replayed'],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: true,
    timeWindow: '1 minute',
    max: (request) =>
      request.url.startsWith('/api/v1/auth/')
        ? options.authRateLimitPerMinute
        : options.rateLimitPerMinute,
    allowList: (request) => request.url.startsWith('/health/'),
    errorResponseBuilder: (request) => ({
      ...problem(new AppError('RATE_LIMITED'), String(request.id)),
      statusCode: 429,
    }),
  });

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-correlation-id', request.id);
    const pathname = request.url.split('?')[0] ?? '';
    if (isBlockedPath(pathname)) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem(new AppError('NOT_FOUND'), String(request.id)));
    }
    // Callers can never present service credentials through the public edge.
    delete request.headers[SERVICE_TOKEN_HEADER];
    const csrf = checkCsrf(request.method, request.headers);
    if (!csrf.ok) {
      return reply
        .status(403)
        .type('application/problem+json')
        .send(
          problem(
            new AppError('FORBIDDEN', { detail: 'Missing or invalid CSRF token.' }),
            String(request.id),
          ),
        );
    }
    if (csrf.bearerFromCookie !== null)
      request.headers.authorization = `Bearer ${csrf.bearerFromCookie}`;
    request.headers['x-correlation-id'] = String(request.id);
    return undefined;
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => ({ status: 'ok' }));
  if (options.openApiDocument !== null) {
    const document = options.openApiDocument;
    app.get('/api/v1/openapi.json', async () => document);
  }

  for (const route of ROUTES) {
    await app.register(proxy, {
      upstream: options.upstreams[route.upstream],
      prefix: route.prefix,
      rewritePrefix: route.prefix,
      websocket: route.websocket === true,
      http: { requestOptions: { timeout: 15_000 } },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .type('application/problem+json')
      .send(problem(new AppError('NOT_FOUND'), String(request.id)));
  });
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    const appError =
      status === 413
        ? new AppError('PAYLOAD_TOO_LARGE')
        : status === 429
          ? new AppError('RATE_LIMITED')
          : status >= 500
            ? new AppError('DEPENDENCY_UNAVAILABLE')
            : new AppError('VALIDATION_FAILED');
    if (appError.status >= 500) request.log.error({ err: error }, 'gateway error');
    void reply
      .status(appError.status)
      .type('application/problem+json')
      .send(problem(appError, String(request.id)));
  });

  return app;
}
