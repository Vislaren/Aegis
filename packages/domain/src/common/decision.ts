/**
 * Every authorization or policy check returns an explicit decision. Deny reasons are for
 * server-side logging and audit; API responses map them to safe, non-disclosing errors.
 */
export type DenyReason =
  | 'UNAUTHENTICATED'
  | 'USER_NOT_ACTIVE'
  | 'MFA_REQUIRED'
  | 'MFA_NOT_FRESH'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'NO_PRIVILEGED_LEASE'
  | 'SCHOOL_NOT_ACTIVE'
  | 'OPERATOR_NOT_ACTIVE'
  | 'ROLE_NOT_ASSIGNABLE'
  | 'FEATURE_DISABLED'
  | 'REASON_REQUIRED';

export type Decision = { allowed: true } | { allowed: false; reason: DenyReason };

export const ALLOW: Decision = Object.freeze({ allowed: true });

export function deny(reason: DenyReason): Decision {
  return { allowed: false, reason };
}
