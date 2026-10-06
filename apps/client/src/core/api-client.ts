import { ProblemDetails, type ProblemDetails as Problem } from '@aegis/contracts';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem | null,
  ) {
    super(problem?.title ?? `Request failed (${status})`);
    this.name = 'ApiError';
  }

  get code(): string {
    return this.problem?.code ?? (this.status === 0 ? 'NETWORK' : 'UNKNOWN');
  }
}

/** Where credentials live: web uses HttpOnly cookies (+ CSRF header); native uses bearer tokens. */
export interface CredentialStrategy {
  kind: 'cookie' | 'bearer';
  accessToken(): string | null;
  /** Web: reads the non-HttpOnly CSRF cookie. Native: null. */
  csrfToken(): string | null;
  /** Obtains new tokens using the stored refresh token; returns false when the session is over. */
  refresh(): Promise<boolean>;
}

export interface ApiClientOptions {
  baseUrl: string;
  credentials: CredentialStrategy;
  fetchImpl?: typeof fetch;
  newIdempotencyKey?: () => string;
}

export interface RequestOptions<S extends z.ZodType> {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  schema?: S;
  idempotent?: boolean;
  /** Internal: prevents refresh loops. */
  retried?: boolean;
}

/**
 * Typed client for the public API. Responses are validated against the shared contracts; a 401
 * triggers one refresh attempt; problem details are surfaced as ApiError with a stable code.
 */
export class ApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async request<S extends z.ZodType>(
    path: string,
    opts: RequestOptions<S> = {},
  ): Promise<z.infer<S>> {
    const method = opts.method ?? 'GET';
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const { credentials } = this.options;
    if (credentials.kind === 'bearer') {
      const token = credentials.accessToken();
      if (token !== null) headers.authorization = `Bearer ${token}`;
    } else if (method !== 'GET') {
      const csrf = credentials.csrfToken();
      if (csrf !== null) headers['x-csrf-token'] = csrf;
    }
    if (opts.idempotent === true) {
      headers['idempotency-key'] = (this.options.newIdempotencyKey ?? defaultIdempotencyKey)();
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        credentials: credentials.kind === 'cookie' ? 'include' : 'omit',
      });
    } catch {
      throw new ApiError(0, null);
    }

    if (response.status === 401 && opts.retried !== true && !path.startsWith('/api/v1/auth/')) {
      if (await credentials.refresh()) return this.request(path, { ...opts, retried: true });
    }
    const text = await response.text();
    const json: unknown = text.length === 0 ? undefined : JSON.parse(text);
    if (!response.ok) {
      const problem = ProblemDetails.safeParse(json);
      throw new ApiError(response.status, problem.success ? problem.data : null);
    }
    if (opts.schema === undefined) return undefined as z.infer<S>;
    return opts.schema.parse(json);
  }
}

function defaultIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `ck-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Plain-language messages for codes the UI shows; never exposes server internals. */
export function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  switch (error.code) {
    case 'NETWORK':
      return 'You appear to be offline. Check your connection and try again.';
    case 'ADMIN_WORKSPACE_IN_USE':
      return 'Another operator is using this administration workspace.';
    case 'PRIVILEGED_LEASE_LOST':
    case 'PRIVILEGED_LEASE_REQUIRED':
      return 'Your administration access has ended. Open the workspace again to continue.';
    case 'OTP_INVALID':
      return 'That code is not valid or has expired. Request a new code.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'REAUTHENTICATION_REQUIRED':
      return 'Confirm your identity with your authenticator code first.';
    default:
      return error.problem?.title ?? 'Something went wrong. Try again.';
  }
}
