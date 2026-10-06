import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../errors';

function fromZod(error: ZodError): AppError {
  return new AppError('VALIDATION_FAILED', {
    errors: error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.join('.') || '(body)',
      message: issue.message,
    })),
  });
}

/** Converts every failure into RFC 9457 problem details without leaking internals. */
export function toAppError(exception: unknown): AppError {
  if (exception instanceof AppError) return exception;
  if (exception instanceof ZodError) return fromZod(exception);
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status === 404) return new AppError('NOT_FOUND');
    if (status === 413) return new AppError('PAYLOAD_TOO_LARGE');
    if (status === 429) return new AppError('RATE_LIMITED');
    if (status === 401) return new AppError('UNAUTHENTICATED');
    if (status === 403) return new AppError('FORBIDDEN');
    if (status >= 400 && status < 500) return new AppError('VALIDATION_FAILED');
    return new AppError('INTERNAL', { cause: exception });
  }
  if (typeof exception === 'object' && exception !== null && 'code' in exception) {
    const code = String((exception as { code: unknown }).code);
    const statusCode = (exception as { statusCode?: unknown }).statusCode;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return new AppError('PAYLOAD_TOO_LARGE');
    if (code.startsWith('FST_ERR_CTP') || code === 'FST_ERR_VALIDATION')
      return new AppError('VALIDATION_FAILED');
    if (code === 'FST_ERR_NOT_FOUND') return new AppError('NOT_FOUND');
    if (statusCode === 429) return new AppError('RATE_LIMITED');
  }
  return new AppError('INTERNAL', { cause: exception });
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const error = toAppError(exception);
    const correlationId = String(request.id);

    if (error.status >= 500) {
      request.log.error({ err: exception, code: error.code }, 'request failed');
    } else if (error.options.internalReason !== undefined) {
      request.log.info(
        { code: error.code, reason: error.options.internalReason },
        'request denied',
      );
    }

    void reply
      .status(error.status)
      .header('content-type', 'application/problem+json; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(error.toProblem(correlationId));
  }
}
