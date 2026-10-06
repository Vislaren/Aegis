import { z } from 'zod';

export const Uuid = z.uuid();
export const IsoDateTime = z.iso.datetime({ offset: false });

/** Request bodies are strict: unknown keys are rejected, which blocks mass assignment. */
export const strict = z.strictObject;

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export const PageQuery = z.strictObject({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type PageQuery = z.infer<typeof PageQuery>;

export function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

/** A free-text reason required for sensitive overrides; mirrors MIN_OVERRIDE_REASON_LENGTH. */
export const Reason = z.string().trim().min(10).max(500);
export const ReasonBody = z.strictObject({ reason: Reason });

export const DisplayName = z.string().trim().min(2).max(120);
export const LanguageTag = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/);
export const IanaTimezone = z
  .string()
  .min(3)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'unknown IANA timezone');
export const CountryCode = z.string().regex(/^[A-Z]{2}$/);

/** Email or E.164 phone. The server normalizes with `parseContactIdentifier`. */
export const ContactIdentifier = z.string().trim().min(3).max(254);

export const WorkspaceTypeSchema = z.enum(['PLATFORM', 'SCHOOL']);

export const WorkspaceSelector = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('PLATFORM') }),
  z.strictObject({ type: z.literal('SCHOOL'), schoolId: Uuid }),
]);
export type WorkspaceSelector = z.infer<typeof WorkspaceSelector>;

/** RFC 9457 problem details with Aegis extensions. */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  correlationId: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  occupancy: z
    .object({
      operatorDisplayName: z.string(),
      acquiredAt: IsoDateTime,
      lastActivityAt: IsoDateTime,
    })
    .optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'MFA_REQUIRED',
  'REAUTHENTICATION_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'ADMIN_WORKSPACE_IN_USE',
  'PRIVILEGED_LEASE_REQUIRED',
  'PRIVILEGED_LEASE_LOST',
  'STALE_FENCING_TOKEN',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'OTP_INVALID',
  'INVITATION_INVALID',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
