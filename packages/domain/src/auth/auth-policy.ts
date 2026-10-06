import { addSeconds } from '../common/time';

export const OTP_POLICY = Object.freeze({
  length: 6,
  ttlSeconds: 300,
  maxVerifyAttempts: 5,
  /** Maximum challenges per destination per window, to stop OTP flooding and SMS cost abuse. */
  maxChallengesPerDestination: 5,
  destinationWindowSeconds: 900,
});

export interface OtpChallengeState {
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
  maxAttempts: number;
  /** Challenges issued for unknown identifiers exist only to keep responses uniform. */
  deliverable: boolean;
}

export type OtpVerificationDecision =
  | { kind: 'CHECK_CODE' }
  | { kind: 'REJECT'; reason: 'EXPIRED' | 'CONSUMED' | 'TOO_MANY_ATTEMPTS' | 'UNDELIVERABLE' };

/** Evaluated before comparing the code; every rejection is reported identically to the client. */
export function decideOtpVerification(
  challenge: OtpChallengeState,
  now: Date,
): OtpVerificationDecision {
  if (challenge.consumedAt !== null) return { kind: 'REJECT', reason: 'CONSUMED' };
  if (now.getTime() >= challenge.expiresAt.getTime()) return { kind: 'REJECT', reason: 'EXPIRED' };
  if (challenge.attempts >= challenge.maxAttempts)
    return { kind: 'REJECT', reason: 'TOO_MANY_ATTEMPTS' };
  if (!challenge.deliverable) return { kind: 'REJECT', reason: 'UNDELIVERABLE' };
  return { kind: 'CHECK_CODE' };
}

export function canIssueOtp(recentChallengesForDestination: number): boolean {
  return recentChallengesForDestination < OTP_POLICY.maxChallengesPerDestination;
}

export const SESSION_POLICY = Object.freeze({
  accessTokenTtlSeconds: 600,
  refreshTokenTtlSeconds: 60 * 60 * 24 * 14,
  /** Absolute session lifetime regardless of refresh activity. */
  sessionAbsoluteTtlSeconds: 60 * 60 * 24 * 30,
  /** Privileged operators must re-authenticate at least daily. */
  privilegedSessionAbsoluteTtlSeconds: 60 * 60 * 12,
  /** An OTP-authenticated session may enroll MFA only shortly after sign-in. */
  mfaEnrollmentWindowSeconds: 600,
});

export type RefreshTokenStatus = 'ACTIVE' | 'ROTATED' | 'REVOKED';
export type SessionStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export type RefreshDecision =
  | { kind: 'ROTATE' }
  | { kind: 'REUSE_DETECTED' }
  | { kind: 'REJECT'; reason: 'EXPIRED' | 'REVOKED' | 'SESSION_ENDED' };

/**
 * Refresh tokens rotate on every use. Presenting an already-rotated token means a copy exists
 * somewhere else, so the whole session is revoked (OAuth 2.0 Security BCP reuse detection).
 */
export function decideRefresh(
  token: { status: RefreshTokenStatus; expiresAt: Date },
  session: { status: SessionStatus; absoluteExpiresAt: Date },
  now: Date,
): RefreshDecision {
  if (token.status === 'ROTATED') return { kind: 'REUSE_DETECTED' };
  if (token.status === 'REVOKED') return { kind: 'REJECT', reason: 'REVOKED' };
  if (session.status !== 'ACTIVE') return { kind: 'REJECT', reason: 'SESSION_ENDED' };
  if (now.getTime() >= session.absoluteExpiresAt.getTime())
    return { kind: 'REJECT', reason: 'SESSION_ENDED' };
  if (now.getTime() >= token.expiresAt.getTime()) return { kind: 'REJECT', reason: 'EXPIRED' };
  return { kind: 'ROTATE' };
}

export function canEnrollMfa(
  session: { authenticatedAt: Date },
  hasActiveFactor: boolean,
  now: Date,
): boolean {
  if (hasActiveFactor) return false;
  const deadline = addSeconds(session.authenticatedAt, SESSION_POLICY.mfaEnrollmentWindowSeconds);
  return now.getTime() <= deadline.getTime();
}

export const INVITATION_POLICY = Object.freeze({
  ttlSeconds: 60 * 60 * 72,
});

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';

export type InvitationDecision =
  { kind: 'ACCEPTABLE' } | { kind: 'REJECT'; reason: 'EXPIRED' | 'ALREADY_USED' | 'REVOKED' };

export function decideInvitationAcceptance(
  invitation: { status: InvitationStatus; expiresAt: Date },
  now: Date,
): InvitationDecision {
  if (invitation.status === 'ACCEPTED') return { kind: 'REJECT', reason: 'ALREADY_USED' };
  if (invitation.status === 'REVOKED') return { kind: 'REJECT', reason: 'REVOKED' };
  if (invitation.status === 'EXPIRED' || now.getTime() >= invitation.expiresAt.getTime()) {
    return { kind: 'REJECT', reason: 'EXPIRED' };
  }
  return { kind: 'ACCEPTABLE' };
}

export function invitationExpiry(now: Date): Date {
  return addSeconds(now, INVITATION_POLICY.ttlSeconds);
}
