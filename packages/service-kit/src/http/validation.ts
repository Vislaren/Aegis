import {
  Inject,
  Injectable,
  SetMetadata,
  createParamDecorator,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  type PipeTransform,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { map, type Observable } from 'rxjs';
import type { z } from 'zod';
import { AppError } from '../errors';

/** Validates a request part with a zod schema. Strict schemas reject unknown keys. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    // The ProblemDetailsFilter turns ZodError into VALIDATION_FAILED.
    return this.schema.parse(value ?? {});
  }
}

export const RESPONSE_SCHEMA = 'aegis:response-schema';

/**
 * Declares the response contract. The interceptor parses every response through it, which
 * strips undeclared fields so internal columns can never leak into an API response.
 */
export const ResponseSchema = (schema: z.ZodType): MethodDecorator & ClassDecorator =>
  SetMetadata(RESPONSE_SCHEMA, schema);

@Injectable()
export class ResponseValidationInterceptor implements NestInterceptor {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const schema = this.reflector.get<z.ZodType | undefined>(RESPONSE_SCHEMA, context.getHandler());
    return next.handle().pipe(
      map((body: unknown) => {
        if (schema === undefined || body === undefined) return body;
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          throw new AppError('INTERNAL', {
            internalReason: 'response contract violation',
            cause: parsed.error,
          });
        }
        return parsed.data;
      }),
    );
  }
}

export interface RequestMeta {
  correlationId: string;
  sourceIp: string | null;
  userAgent: string | null;
  idempotencyKey: string | null;
  traceparent: string | null;
}

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

export function requestMeta(request: FastifyRequest): RequestMeta {
  const idempotencyKey = header(request, 'idempotency-key');
  return {
    correlationId: String(request.id),
    sourceIp: request.ip ?? null,
    userAgent: header(request, 'user-agent')?.slice(0, 256) ?? null,
    idempotencyKey:
      idempotencyKey !== null && /^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)
        ? idempotencyKey
        : null,
    traceparent: header(request, 'traceparent')?.slice(0, 100) ?? null,
  };
}

/** Correlation, source, and idempotency metadata for journaling and events. */
export const Meta = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestMeta =>
  requestMeta(ctx.switchToHttp().getRequest<FastifyRequest>()),
);
