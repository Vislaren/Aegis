import type { z } from 'zod';
import { ProblemDetails } from '@aegis/contracts';
import { AppError } from '../errors';
import { SERVICE_TOKEN_HEADER, type ServiceTokenSigner } from '../auth/tokens';

export type InternalResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; problem: ProblemDetails | null };

export interface InternalCallMeta {
  correlationId: string;
  traceparent?: string | null;
}

/**
 * Typed client for another service's `/internal/v1` API. Transport failures, timeouts, and 5xx
 * responses raise DEPENDENCY_UNAVAILABLE so callers fail closed; 4xx responses are returned for
 * the caller to interpret.
 */
export class InternalServiceClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      callee: string;
      signer: ServiceTokenSigner;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async call<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    meta: InternalCallMeta,
    responseSchema: S,
    body?: unknown,
  ): Promise<InternalResult<z.infer<S>>> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      accept: 'application/json',
      [SERVICE_TOKEN_HEADER]: await this.options.signer.tokenFor(this.options.callee),
      'x-correlation-id': meta.correlationId,
    };
    if (meta.traceparent) headers.traceparent = meta.traceparent;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 3000),
      });
    } catch (cause) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', {
        internalReason: `${this.options.callee} unreachable`,
        cause,
      });
    }

    if (response.status >= 500) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', {
        internalReason: `${this.options.callee} responded ${response.status}`,
      });
    }

    const text = await response.text();
    const json: unknown = text.length === 0 ? undefined : JSON.parse(text);

    if (!response.ok) {
      const problem = ProblemDetails.safeParse(json);
      return { ok: false, status: response.status, problem: problem.success ? problem.data : null };
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', {
        internalReason: `${this.options.callee} violated its response contract`,
        cause: parsed.error,
      });
    }
    return { ok: true, status: response.status, data: parsed.data };
  }
}
