import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEASE_TIMING,
  decideAcquire,
  decideForcedRevocation,
  decideHeartbeat,
  decideTakeover,
  leaseLiveness,
  newLeaseWindow,
  validateLeaseForSession,
  validateLeaseTiming,
  type LeaseSnapshot,
} from './lease-policy';
import { addSeconds } from '../common/time';

const T0 = new Date('2026-03-02T07:00:00.000Z');
const config = DEFAULT_LEASE_TIMING;
const REASON = 'Operator left the laptop unlocked at the office';

function vacant(): LeaseSnapshot {
  return {
    status: 'VACANT',
    grantId: null,
    sessionId: null,
    ownerUserId: null,
    operatorProfileId: null,
    operatorDisplayName: null,
    acquiredAt: null,
    heartbeatAt: null,
    lastActivityAt: null,
    expiresAt: null,
    idleExpiresAt: null,
    version: 0,
  };
}

function heldBy(sessionId: string, at: Date = T0, grantId = `grant-${sessionId}`): LeaseSnapshot {
  const window = newLeaseWindow(at, config);
  return {
    status: 'ACTIVE',
    grantId,
    sessionId,
    ownerUserId: `user-${sessionId}`,
    operatorProfileId: `profile-${sessionId}`,
    operatorDisplayName: 'Operator Ama Fictional',
    acquiredAt: at,
    heartbeatAt: at,
    lastActivityAt: at,
    expiresAt: window.expiresAt,
    idleExpiresAt: window.idleExpiresAt,
    version: 1,
  };
}

describe('lease timing configuration', () => {
  it('accepts the documented defaults', () => {
    expect(validateLeaseTiming(DEFAULT_LEASE_TIMING)).toEqual([]);
  });

  it('rejects a TTL that cannot survive two missed heartbeats and an idle timeout shorter than the TTL', () => {
    const problems = validateLeaseTiming({
      heartbeatIntervalSeconds: 60,
      leaseTtlSeconds: 90,
      idleTimeoutSeconds: 60,
      mfaFreshnessSeconds: 300,
    });
    expect(problems).toHaveLength(2);
  });
});

describe('decideAcquire', () => {
  it('grants a vacant workspace', () => {
    expect(decideAcquire(vacant(), 's1', T0)).toEqual({ kind: 'GRANT', superseded: null });
  });

  it('lets the same session reuse its live lease (reconnect or another tab)', () => {
    expect(decideAcquire(heldBy('s1'), 's1', addSeconds(T0, 30))).toEqual({ kind: 'REUSE' });
  });

  it('denies an independent session, even of the same person, and discloses only approved fields', () => {
    const decision = decideAcquire(heldBy('s1'), 's2', addSeconds(T0, 30));
    expect(decision).toEqual({
      kind: 'DENY_IN_USE',
      occupancy: {
        operatorDisplayName: 'Operator Ama Fictional',
        acquiredAt: T0,
        lastActivityAt: T0,
      },
    });
  });

  it('recovers a lease whose heartbeat expired and reports the stale grant', () => {
    const later = addSeconds(T0, config.leaseTtlSeconds);
    expect(decideAcquire(heldBy('s1'), 's2', later)).toEqual({
      kind: 'GRANT',
      superseded: { grantId: 'grant-s1', sessionId: 's1', reason: 'HEARTBEAT_EXPIRED' },
    });
  });

  it('recovers a lease that keeps heartbeating but has been idle past the idle timeout', () => {
    const lease = heldBy('s1');
    lease.expiresAt = addSeconds(T0, config.idleTimeoutSeconds + config.leaseTtlSeconds);
    expect(decideAcquire(lease, 's2', addSeconds(T0, config.idleTimeoutSeconds))).toEqual({
      kind: 'GRANT',
      superseded: { grantId: 'grant-s1', sessionId: 's1', reason: 'IDLE_TIMEOUT' },
    });
  });

  it('grants after an explicit release', () => {
    const lease: LeaseSnapshot = { ...heldBy('s1'), status: 'RELEASED' };
    expect(decideAcquire(lease, 's2', addSeconds(T0, 1))).toEqual({
      kind: 'GRANT',
      superseded: null,
    });
  });

  it('property: at any instant at most one session holds the lease', () => {
    let seed = 42;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let lease = vacant();
    let now = T0;
    const sessions = ['s0', 's1', 's2', 's3'];
    for (let step = 0; step < 2000; step += 1) {
      now = addSeconds(now, Math.floor(random() * 120));
      const session = sessions[Math.floor(random() * sessions.length)] ?? 's0';
      if (decideAcquire(lease, session, now).kind === 'GRANT') {
        lease = heldBy(session, now, `g${step}`);
      }
      const holders = sessions.filter((s) => validateLeaseForSession(lease, s, now).ok);
      expect(holders.length).toBeLessThanOrEqual(1);
    }
  });
});

describe('validateLeaseForSession', () => {
  it('accepts the owning session before expiry', () => {
    expect(validateLeaseForSession(heldBy('s1'), 's1', addSeconds(T0, 10))).toEqual({ ok: true });
  });

  it('rejects missing leases, other sessions, expired leases, ended leases, and wrong grants', () => {
    const lease = heldBy('s1');
    expect(validateLeaseForSession(null, 's1', T0)).toEqual({ ok: false, reason: 'NO_LEASE' });
    expect(validateLeaseForSession(lease, 's2', T0)).toEqual({ ok: false, reason: 'NOT_OWNER' });
    expect(validateLeaseForSession(lease, 's1', addSeconds(T0, config.leaseTtlSeconds))).toEqual({
      ok: false,
      reason: 'HEARTBEAT_EXPIRED',
    });
    expect(validateLeaseForSession(lease, 's1', T0, 'another-grant')).toEqual({
      ok: false,
      reason: 'GRANT_MISMATCH',
    });
    expect(validateLeaseForSession({ ...lease, status: 'REVOKED' }, 's1', T0)).toEqual({
      ok: false,
      reason: 'ENDED',
    });
  });
});

describe('decideHeartbeat', () => {
  it('extends only the heartbeat window when the operator was not active', () => {
    const lease = heldBy('s1');
    const at = addSeconds(T0, 60);
    expect(decideHeartbeat(lease, 's1', 'grant-s1', at, false, config)).toEqual({
      kind: 'RENEWED',
      expiresAt: addSeconds(at, config.leaseTtlSeconds),
      idleExpiresAt: lease.idleExpiresAt,
    });
  });

  it('extends the idle window when the operator interacted recently', () => {
    const at = addSeconds(T0, 60);
    expect(decideHeartbeat(heldBy('s1'), 's1', 'grant-s1', at, true, config)).toEqual({
      kind: 'RENEWED',
      expiresAt: addSeconds(at, config.leaseTtlSeconds),
      idleExpiresAt: addSeconds(at, config.idleTimeoutSeconds),
    });
  });

  it('cannot resurrect an expired lease', () => {
    const at = addSeconds(T0, config.leaseTtlSeconds + 1);
    expect(decideHeartbeat(heldBy('s1'), 's1', 'grant-s1', at, true, config)).toEqual({
      kind: 'LOST',
      reason: 'HEARTBEAT_EXPIRED',
    });
  });

  it('rejects a replayed heartbeat for a previous grant', () => {
    expect(decideHeartbeat(heldBy('s1', T0, 'new'), 's1', 'old', T0, true, config)).toEqual({
      kind: 'LOST',
      reason: 'GRANT_MISMATCH',
    });
  });
});

describe('decideTakeover', () => {
  const fresh = addSeconds(T0, 50);
  const now = addSeconds(T0, 60);

  it('requires a written reason', () => {
    expect(
      decideTakeover({
        lease: heldBy('s1'),
        requesterSessionId: 's2',
        mfaVerifiedAt: fresh,
        reason: 'x',
        now,
        config,
      }),
    ).toEqual({ kind: 'DENY', reason: 'REASON_REQUIRED' });
  });

  it('requires fresh MFA', () => {
    const stale = addSeconds(now, -config.mfaFreshnessSeconds - 1);
    expect(
      decideTakeover({
        lease: heldBy('s1'),
        requesterSessionId: 's2',
        mfaVerifiedAt: stale,
        reason: REASON,
        now,
        config,
      }),
    ).toEqual({ kind: 'DENY', reason: 'MFA_NOT_FRESH' });
  });

  it('displaces a live holder when conditions are met', () => {
    expect(
      decideTakeover({
        lease: heldBy('s1'),
        requesterSessionId: 's2',
        mfaVerifiedAt: fresh,
        reason: REASON,
        now,
        config,
      }),
    ).toEqual({ kind: 'TAKEOVER', displaced: { grantId: 'grant-s1', sessionId: 's1' } });
  });

  it('is an ordinary grant when the lease is already free', () => {
    expect(
      decideTakeover({
        lease: vacant(),
        requesterSessionId: 's2',
        mfaVerifiedAt: fresh,
        reason: REASON,
        now,
        config,
      }),
    ).toEqual({ kind: 'GRANT_WITHOUT_TAKEOVER', superseded: null });
  });

  it('reports the requester already owning the lease', () => {
    expect(
      decideTakeover({
        lease: heldBy('s2'),
        requesterSessionId: 's2',
        mfaVerifiedAt: fresh,
        reason: REASON,
        now,
        config,
      }),
    ).toEqual({ kind: 'ALREADY_OWNER' });
  });
});

describe('decideForcedRevocation', () => {
  it('revokes a live lease with fresh MFA and a reason', () => {
    const now = addSeconds(T0, 10);
    expect(
      decideForcedRevocation({
        lease: heldBy('s1'),
        mfaVerifiedAt: now,
        reason: REASON,
        now,
        config,
      }),
    ).toEqual({ kind: 'REVOKE', displaced: { grantId: 'grant-s1', sessionId: 's1' } });
  });

  it('reports nothing to revoke for an expired lease', () => {
    const now = addSeconds(T0, config.leaseTtlSeconds + 5);
    expect(
      decideForcedRevocation({
        lease: heldBy('s1'),
        mfaVerifiedAt: now,
        reason: REASON,
        now,
        config,
      }),
    ).toEqual({ kind: 'NOTHING_TO_REVOKE' });
  });

  it('refuses without a reason', () => {
    expect(
      decideForcedRevocation({
        lease: heldBy('s1'),
        mfaVerifiedAt: T0,
        reason: '',
        now: T0,
        config,
      }),
    ).toEqual({ kind: 'DENY', reason: 'REASON_REQUIRED' });
  });
});

describe('leaseLiveness', () => {
  it('reports the earliest expiry when both windows have passed', () => {
    expect(leaseLiveness(heldBy('s1'), addSeconds(T0, 10_000))).toBe('HEARTBEAT_EXPIRED');
  });
});
