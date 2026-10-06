import type { ErrorCode, ProblemDetails } from '@aegis/contracts';
import type { DenyReason } from '@aegis/domain';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 403,
  REAUTHENTICATION_REQUIRED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ADMIN_WORKSPACE_IN_USE: 409,
  PRIVILEGED_LEASE_REQUIRED: 403,
  PRIVILEGED_LEASE_LOST: 409,
  STALE_FENCING_TOKEN: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 422,
  OTP_INVALID: 400,
  INVITATION_INVALID: 400,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL: 500,
};

const TITLE: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'The request is not valid.',
  UNAUTHENTICATED: 'Sign-in is required.',
  MFA_REQUIRED: 'Multi-factor verification is required.',
  REAUTHENTICATION_REQUIRED: 'Recent multi-factor verification is required for this action.',
  FORBIDDEN: 'This action is not allowed.',
  NOT_FOUND: 'The requested resource was not found.',
  CONFLICT: 'The request conflicts with the current state.',
  ADMIN_WORKSPACE_IN_USE: 'Another operator is currently using this administration workspace.',
  PRIVILEGED_LEASE_REQUIRED: 'Open the administration workspace before performing this action.',
  PRIVILEGED_LEASE_LOST: 'Your administration access has ended. Reopen the workspace to continue.',
  STALE_FENCING_TOKEN: 'A newer administration session has taken over this workspace.',
  IDEMPOTENCY_KEY_REQUIRED: 'An Idempotency-Key header is required.',
  IDEMPOTENCY_KEY_REUSED: 'This Idempotency-Key was already used for a different request.',
  OTP_INVALID: 'The code is invalid or has expired. Request a new code.',
  INVITATION_INVALID:
    'The invitation is invalid or has expired. Ask your administrator for a new one.',
  RATE_LIMITED: 'Too many requests. Wait and try again.',
  PAYLOAD_TOO_LARGE: 'The request is too large.',
  DEPENDENCY_UNAVAILABLE: 'A required service is temporarily unavailable. Try again shortly.',
  INTERNAL: 'An unexpected error occurred.',
};

export interface AppErrorOptions {
  detail?: string;
  errors?: Array<{ path: string; message: string }>;
  occupancy?: ProblemDetails['occupancy'];
  /** Logged server-side only; never returned to clients. */
  internalReason?: string;
  cause?: unknown;
}

/** The only error type services throw deliberately. Messages are safe for clients. */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    readonly options: AppErrorOptions = {},
  ) {
    super(TITLE[code], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.status = STATUS[code];
  }

  toProblem(correlationId: string): ProblemDetails {
    return {
      type: `https://docs.aegis.invalid/problems/${this.code.toLowerCase().replace(/_/g, '-')}`,
      title: TITLE[this.code],
      status: this.status,
      code: this.code,
      correlationId,
      ...(this.options.detail === undefined ? {} : { detail: this.options.detail }),
      ...(this.options.errors === undefined ? {} : { errors: this.options.errors }),
      ...(this.options.occupancy === undefined ? {} : { occupancy: this.options.occupancy }),
    };
  }
}

export function statusForCode(code: ErrorCode): number {
  return STATUS[code];
}

/**
 * Maps a domain deny reason to a client-safe error. Object-level denials become NOT_FOUND so
 * that responses never disclose whether another tenant's object exists.
 */
export function errorForDenial(reason: DenyReason): AppError {
  switch (reason) {
    case 'UNAUTHENTICATED':
      return new AppError('UNAUTHENTICATED', { internalReason: reason });
    case 'MFA_REQUIRED':
      return new AppError('MFA_REQUIRED', { internalReason: reason });
    case 'MFA_NOT_FRESH':
      return new AppError('REAUTHENTICATION_REQUIRED', { internalReason: reason });
    case 'NO_PRIVILEGED_LEASE':
      return new AppError('PRIVILEGED_LEASE_REQUIRED', { internalReason: reason });
    case 'REASON_REQUIRED':
      return new AppError('VALIDATION_FAILED', {
        internalReason: reason,
        errors: [{ path: 'reason', message: 'A reason of at least 10 characters is required.' }],
      });
    case 'NOT_FOUND':
      return new AppError('NOT_FOUND', { internalReason: reason });
    case 'ROLE_NOT_ASSIGNABLE':
    case 'FEATURE_DISABLED':
    case 'FORBIDDEN':
    case 'USER_NOT_ACTIVE':
    case 'SCHOOL_NOT_ACTIVE':
    case 'OPERATOR_NOT_ACTIVE':
      return new AppError('FORBIDDEN', { internalReason: reason });
  }
}
