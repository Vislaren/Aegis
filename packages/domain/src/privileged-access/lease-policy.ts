import { addSeconds } from '../common/time';

/**
 * Privileged access lease policy.
 *
 * PostgreSQL holds exactly one lease row per administration workspace and the API evaluates these
 * pure rules while holding that row's lock (`SELECT ... FOR UPDATE`). Exclusivity therefore comes
 * from the database lock, and the rules below decide what the locked row allows.
 */

export interface LeaseTimingConfig {
  /** How often the client is expected to heartbeat. Informational for clients. */
  heartbeatIntervalSeconds: number;
  /** A lease without a heartbeat for this long is expired (crashed browser recovery). */
  leaseTtlSeconds: number;
  /** A lease without privileged activity for this long is expired even if heartbeats continue. */
  idleTimeoutSeconds: number;
  /** Takeover and forced revocation require MFA verified within this window. */
  mfaFreshnessSeconds: number;
}

export const DEFAULT_LEASE_TIMING: Readonly<LeaseTimingConfig> = Object.freeze({
  heartbeatIntervalSeconds: 60,
  leaseTtlSeconds: 300,
  idleTimeoutSeconds: 900,
  mfaFreshnessSeconds: 300,
});

export function validateLeaseTiming(config: LeaseTimingConfig): string[] {
  const problems: string[] = [];
  if (config.heartbeatIntervalSeconds < 5) problems.push('heartbeat interval must be >= 5s');
  if (config.leaseTtlSeconds < config.heartbeatIntervalSeconds * 2) {
    problems.push('lease TTL must allow at least two missed heartbeats');
  }
  if (config.idleTimeoutSeconds < config.leaseTtlSeconds) {
    problems.push('idle timeout must be >= lease TTL');
  }
  if (config.mfaFreshnessSeconds < 30 || config.mfaFreshnessSeconds > 3600) {
    problems.push('MFA freshness must be between 30s and 3600s');
  }
  return problems;
}

export type LeaseStatus = 'VACANT' | 'ACTIVE' | 'RELEASED' | 'EXPIRED' | 'REVOKED';

export interface LeaseSnapshot {
  status: LeaseStatus;
  grantId: string | null;
  sessionId: string | null;
  ownerUserId: string | null;
  operatorProfileId: string | null;
  operatorDisplayName: string | null;
  acquiredAt: Date | null;
  heartbeatAt: Date | null;
  lastActivityAt: Date | null;
  expiresAt: Date | null;
  idleExpiresAt: Date | null;
  version: number;
}

export type LeaseLiveness = 'VACANT' | 'HELD' | 'HEARTBEAT_EXPIRED' | 'IDLE_EXPIRED' | 'ENDED';

/** Whether the lease currently excludes other sessions. Expiry is computed, never trusted from a job. */
export function leaseLiveness(lease: LeaseSnapshot, now: Date): LeaseLiveness {
  if (lease.status === 'VACANT') return 'VACANT';
  if (lease.status !== 'ACTIVE') return 'ENDED';
  if (lease.expiresAt === null || lease.idleExpiresAt === null) return 'HEARTBEAT_EXPIRED';
  const heartbeatExpired = now.getTime() >= lease.expiresAt.getTime();
  const idleExpired = now.getTime() >= lease.idleExpiresAt.getTime();
  if (heartbeatExpired && idleExpired) {
    return lease.expiresAt.getTime() <= lease.idleExpiresAt.getTime()
      ? 'HEARTBEAT_EXPIRED'
      : 'IDLE_EXPIRED';
  }
  if (heartbeatExpired) return 'HEARTBEAT_EXPIRED';
  if (idleExpired) return 'IDLE_EXPIRED';
  return 'HELD';
}

/** Only these holder fields may be shown to a denied operator (policy-approved disclosure). */
export interface LeaseOccupancy {
  operatorDisplayName: string;
  acquiredAt: Date;
  lastActivityAt: Date;
}

export function occupancyView(lease: LeaseSnapshot): LeaseOccupancy {
  return {
    operatorDisplayName: lease.operatorDisplayName ?? 'Another operator',
    acquiredAt: lease.acquiredAt ?? new Date(0),
    lastActivityAt: lease.lastActivityAt ?? lease.acquiredAt ?? new Date(0),
  };
}

export type SupersededGrantReason = 'HEARTBEAT_EXPIRED' | 'IDLE_TIMEOUT';

export interface SupersededGrant {
  grantId: string;
  sessionId: string | null;
  reason: SupersededGrantReason;
}

export type AcquireDecision =
  | { kind: 'REUSE' }
  | { kind: 'GRANT'; superseded: SupersededGrant | null }
  | { kind: 'DENY_IN_USE'; occupancy: LeaseOccupancy };

/**
 * The same authenticated session may reuse its live lease (reconnect, extra tab). Any other session,
 * including another session of the same person, is denied while the lease is live. An expired lease
 * is recovered and the stale grant is reported so its history can be closed.
 */
export function decideAcquire(
  lease: LeaseSnapshot,
  requesterSessionId: string,
  now: Date,
): AcquireDecision {
  const liveness = leaseLiveness(lease, now);
  switch (liveness) {
    case 'VACANT':
    case 'ENDED':
      return { kind: 'GRANT', superseded: null };
    case 'HELD':
      return lease.sessionId === requesterSessionId
        ? { kind: 'REUSE' }
        : { kind: 'DENY_IN_USE', occupancy: occupancyView(lease) };
    case 'HEARTBEAT_EXPIRED':
    case 'IDLE_EXPIRED':
      return {
        kind: 'GRANT',
        superseded:
          lease.grantId === null
            ? null
            : {
                grantId: lease.grantId,
                sessionId: lease.sessionId,
                reason: liveness === 'IDLE_EXPIRED' ? 'IDLE_TIMEOUT' : 'HEARTBEAT_EXPIRED',
              },
      };
  }
}

export interface LeaseWindow {
  expiresAt: Date;
  idleExpiresAt: Date;
}

export function newLeaseWindow(now: Date, config: LeaseTimingConfig): LeaseWindow {
  return {
    expiresAt: addSeconds(now, config.leaseTtlSeconds),
    idleExpiresAt: addSeconds(now, config.idleTimeoutSeconds),
  };
}

export type LeaseLossReason =
  'NO_LEASE' | 'NOT_OWNER' | 'GRANT_MISMATCH' | 'HEARTBEAT_EXPIRED' | 'IDLE_TIMEOUT' | 'ENDED';

export type LeaseCheck = { ok: true } | { ok: false; reason: LeaseLossReason };

/** Run before every privileged command and privileged realtime subscription. */
export function validateLeaseForSession(
  lease: LeaseSnapshot | null,
  sessionId: string,
  now: Date,
  expectedGrantId?: string,
): LeaseCheck {
  if (lease === null) return { ok: false, reason: 'NO_LEASE' };
  const liveness = leaseLiveness(lease, now);
  if (liveness === 'VACANT') return { ok: false, reason: 'NO_LEASE' };
  if (lease.sessionId !== sessionId) return { ok: false, reason: 'NOT_OWNER' };
  if (expectedGrantId !== undefined && lease.grantId !== expectedGrantId) {
    return { ok: false, reason: 'GRANT_MISMATCH' };
  }
  if (liveness === 'ENDED') return { ok: false, reason: 'ENDED' };
  if (liveness === 'HEARTBEAT_EXPIRED') return { ok: false, reason: 'HEARTBEAT_EXPIRED' };
  if (liveness === 'IDLE_EXPIRED') return { ok: false, reason: 'IDLE_TIMEOUT' };
  return { ok: true };
}

export type HeartbeatDecision =
  | { kind: 'RENEWED'; expiresAt: Date; idleExpiresAt: Date }
  | { kind: 'LOST'; reason: LeaseLossReason };

/**
 * A heartbeat proves the client is alive and extends the missed-heartbeat expiry. It only extends
 * the idle window when the client reports recent operator interaction, so an unattended open tab
 * still times out.
 */
export function decideHeartbeat(
  lease: LeaseSnapshot | null,
  sessionId: string,
  grantId: string,
  now: Date,
  userActive: boolean,
  config: LeaseTimingConfig,
): HeartbeatDecision {
  const check = validateLeaseForSession(lease, sessionId, now, grantId);
  if (!check.ok || lease === null)
    return { kind: 'LOST', reason: check.ok ? 'NO_LEASE' : check.reason };
  const window = newLeaseWindow(now, config);
  const currentIdle = lease.idleExpiresAt ?? now;
  return {
    kind: 'RENEWED',
    expiresAt: window.expiresAt,
    idleExpiresAt: userActive ? window.idleExpiresAt : currentIdle,
  };
}

/** A privileged command counts as operator activity and extends both windows. */
export function activityWindow(now: Date, config: LeaseTimingConfig): LeaseWindow {
  return newLeaseWindow(now, config);
}

export function isMfaFresh(mfaVerifiedAt: Date | null, now: Date, maxAgeSeconds: number): boolean {
  if (mfaVerifiedAt === null) return false;
  const age = (now.getTime() - mfaVerifiedAt.getTime()) / 1000;
  return age >= 0 && age <= maxAgeSeconds;
}

export const MIN_OVERRIDE_REASON_LENGTH = 10;

export function isAcceptableReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.trim().length >= MIN_OVERRIDE_REASON_LENGTH;
}

export type TakeoverDecision =
  | { kind: 'TAKEOVER'; displaced: { grantId: string; sessionId: string | null } }
  | { kind: 'GRANT_WITHOUT_TAKEOVER'; superseded: SupersededGrant | null }
  | { kind: 'ALREADY_OWNER' }
  | { kind: 'DENY'; reason: 'MFA_NOT_FRESH' | 'REASON_REQUIRED' };

/**
 * Emergency takeover by another authorized operator of the same workspace. Requires fresh MFA and
 * a written reason. Authority (being an active operator of the workspace) is checked by the caller
 * through the authorization policy before this is evaluated.
 */
export function decideTakeover(input: {
  lease: LeaseSnapshot;
  requesterSessionId: string;
  mfaVerifiedAt: Date | null;
  reason: string | null | undefined;
  now: Date;
  config: LeaseTimingConfig;
}): TakeoverDecision {
  if (!isAcceptableReason(input.reason)) return { kind: 'DENY', reason: 'REASON_REQUIRED' };
  if (!isMfaFresh(input.mfaVerifiedAt, input.now, input.config.mfaFreshnessSeconds)) {
    return { kind: 'DENY', reason: 'MFA_NOT_FRESH' };
  }
  const acquire = decideAcquire(input.lease, input.requesterSessionId, input.now);
  if (acquire.kind === 'REUSE') return { kind: 'ALREADY_OWNER' };
  if (acquire.kind === 'GRANT')
    return { kind: 'GRANT_WITHOUT_TAKEOVER', superseded: acquire.superseded };
  return {
    kind: 'TAKEOVER',
    displaced: { grantId: input.lease.grantId ?? '', sessionId: input.lease.sessionId },
  };
}

export type RevokeDecision =
  | { kind: 'REVOKE'; displaced: { grantId: string; sessionId: string | null } }
  | { kind: 'NOTHING_TO_REVOKE' }
  | { kind: 'DENY'; reason: 'MFA_NOT_FRESH' | 'REASON_REQUIRED' };

/**
 * Forced revocation of another workspace's lease (a platform operator unlocking a stuck school
 * workspace). Revocation never grants the revoker access to that workspace.
 */
export function decideForcedRevocation(input: {
  lease: LeaseSnapshot;
  mfaVerifiedAt: Date | null;
  reason: string | null | undefined;
  now: Date;
  config: LeaseTimingConfig;
}): RevokeDecision {
  if (!isAcceptableReason(input.reason)) return { kind: 'DENY', reason: 'REASON_REQUIRED' };
  if (!isMfaFresh(input.mfaVerifiedAt, input.now, input.config.mfaFreshnessSeconds)) {
    return { kind: 'DENY', reason: 'MFA_NOT_FRESH' };
  }
  const liveness = leaseLiveness(input.lease, input.now);
  if (liveness !== 'HELD' || input.lease.grantId === null) return { kind: 'NOTHING_TO_REVOKE' };
  return {
    kind: 'REVOKE',
    displaced: { grantId: input.lease.grantId, sessionId: input.lease.sessionId },
  };
}

/** Release reasons recorded in session history and on the lease row. */
export const LEASE_END_REASONS = [
  'LOGOUT',
  'RELEASED_BY_OPERATOR',
  'HEARTBEAT_EXPIRED',
  'IDLE_TIMEOUT',
  'SESSION_REVOKED',
  'OPERATOR_SUSPENDED',
  'SCHOOL_SUSPENDED',
  'TAKEOVER',
  'FORCED_REVOCATION',
  'CONTEXT_SWITCH',
] as const;

export type LeaseEndReason = (typeof LEASE_END_REASONS)[number];
