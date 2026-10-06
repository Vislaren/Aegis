import type { LeaseSnapshot, LeaseStatus, WorkspaceType } from '@aegis/domain';
import type { Tx } from '../infrastructure/prisma.service';

/** A locked lease row: the domain snapshot plus storage identifiers. */
export interface LockedLease extends LeaseSnapshot {
  id: string;
  workspaceType: WorkspaceType;
  workspaceId: string;
  schoolId: string | null;
  fencingToken: number;
}

interface LeaseRow {
  id: string;
  workspace_type: WorkspaceType;
  workspace_id: string;
  school_id: string | null;
  status: LeaseStatus;
  grant_id: string | null;
  fencing_token: bigint | number;
  version: number;
  owner_user_id: string | null;
  operator_profile_id: string | null;
  operator_display_name: string | null;
  session_id: string | null;
  acquired_at: Date | null;
  heartbeat_at: Date | null;
  last_activity_at: Date | null;
  expires_at: Date | null;
  idle_expires_at: Date | null;
}

const COLUMNS = `id, workspace_type, workspace_id, school_id, status, grant_id, fencing_token, version,
  owner_user_id, operator_profile_id, operator_display_name, session_id, acquired_at, heartbeat_at,
  last_activity_at, expires_at, idle_expires_at`;

function toLease(row: LeaseRow): LockedLease {
  return {
    id: row.id,
    workspaceType: row.workspace_type,
    workspaceId: row.workspace_id,
    schoolId: row.school_id,
    status: row.status,
    grantId: row.grant_id,
    fencingToken: Number(row.fencing_token),
    version: row.version,
    ownerUserId: row.owner_user_id,
    operatorProfileId: row.operator_profile_id,
    operatorDisplayName: row.operator_display_name,
    sessionId: row.session_id,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    idleExpiresAt: row.idle_expires_at,
  };
}

/**
 * Raw SQL for the lease row. `lock` takes a row lock held until the transaction ends, so every
 * acquire, renew, takeover, revoke, and privileged command on a workspace is serialized.
 */
export const leaseRepository = {
  /** Database clock, read after the lock is granted so waiting never skews expiry decisions. */
  async now(tx: Tx): Promise<Date> {
    const rows = await tx.$queryRawUnsafe<Array<{ now: Date }>>(`SELECT clock_timestamp() AS now`);
    const now = rows[0]?.now;
    if (now === undefined) throw new Error('clock_timestamp() returned no row');
    return now;
  },

  async lock(
    tx: Tx,
    workspaceType: WorkspaceType,
    workspaceId: string,
  ): Promise<LockedLease | null> {
    const rows = await tx.$queryRawUnsafe<LeaseRow[]>(
      `SELECT ${COLUMNS} FROM privileged_access_leases
        WHERE workspace_type = $1 AND workspace_id = $2::uuid
        FOR UPDATE`,
      workspaceType,
      workspaceId,
    );
    const row = rows[0];
    return row === undefined ? null : toLease(row);
  },

  /** The live lease held by a session, if any (visible to the session owner through RLS). */
  async lockActiveForSession(tx: Tx, sessionId: string): Promise<LockedLease[]> {
    const rows = await tx.$queryRawUnsafe<LeaseRow[]>(
      `SELECT ${COLUMNS} FROM privileged_access_leases
        WHERE session_id = $1::uuid AND status = 'ACTIVE'
        FOR UPDATE`,
      sessionId,
    );
    return rows.map(toLease);
  },

  async createVacant(
    tx: Tx,
    workspaceType: WorkspaceType,
    workspaceId: string,
    schoolId: string | null,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO privileged_access_leases (workspace_type, workspace_id, school_id, status)
       VALUES ($1, $2::uuid, $3::uuid, 'VACANT')`,
      workspaceType,
      workspaceId,
      schoolId,
    );
  },

  /** Issues a new grant. The fencing token strictly increases. Returns the new token. */
  async grant(
    tx: Tx,
    leaseId: string,
    input: {
      grantId: string;
      ownerUserId: string;
      operatorProfileId: string;
      operatorDisplayName: string;
      sessionId: string;
      now: Date;
      expiresAt: Date;
      idleExpiresAt: Date;
      takeoverOfGrantId: string | null;
    },
  ): Promise<number> {
    const rows = await tx.$queryRawUnsafe<Array<{ fencing_token: bigint | number }>>(
      `UPDATE privileged_access_leases
          SET status = 'ACTIVE', grant_id = $2::uuid, fencing_token = fencing_token + 1, version = version + 1,
              owner_user_id = $3::uuid, operator_profile_id = $4::uuid, operator_display_name = $5,
              session_id = $6::uuid, acquired_at = $7, heartbeat_at = $7, last_activity_at = $7,
              expires_at = $8, idle_expires_at = $9, released_at = NULL, release_reason = NULL,
              released_by_user_id = NULL, takeover_of_grant_id = $10::uuid
        WHERE id = $1::uuid
        RETURNING fencing_token`,
      leaseId,
      input.grantId,
      input.ownerUserId,
      input.operatorProfileId,
      input.operatorDisplayName,
      input.sessionId,
      input.now,
      input.expiresAt,
      input.idleExpiresAt,
      input.takeoverOfGrantId,
    );
    const token = rows[0]?.fencing_token;
    if (token === undefined) throw new Error('lease grant affected no row');
    return Number(token);
  },

  async renew(
    tx: Tx,
    leaseId: string,
    input: { now: Date; expiresAt: Date; idleExpiresAt: Date; activity: boolean },
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `UPDATE privileged_access_leases
          SET heartbeat_at = $2, expires_at = $3, idle_expires_at = $4, version = version + 1,
              last_activity_at = CASE WHEN $5 THEN $2 ELSE last_activity_at END
        WHERE id = $1::uuid AND status = 'ACTIVE'`,
      leaseId,
      input.now,
      input.expiresAt,
      input.idleExpiresAt,
      input.activity,
    );
  },

  async end(
    tx: Tx,
    leaseId: string,
    input: {
      status: Extract<LeaseStatus, 'RELEASED' | 'EXPIRED' | 'REVOKED'>;
      reason: string;
      now: Date;
      byUserId: string | null;
    },
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `UPDATE privileged_access_leases
          SET status = $2, release_reason = $3, released_at = $4, released_by_user_id = $5::uuid, version = version + 1
        WHERE id = $1::uuid`,
      leaseId,
      input.status,
      input.reason,
      input.now,
      input.byUserId,
    );
  },
};

export const historyRepository = {
  async recordGrant(
    tx: Tx,
    input: {
      lease: LockedLease;
      outcome: 'GRANTED' | 'TAKEOVER';
      userId: string;
      operatorProfileId: string;
      operatorDisplayName: string;
      sessionId: string;
      grantId: string;
      fencingToken: number;
      now: Date;
      sourceIp: string | null;
      userAgent: string | null;
      correlationId: string;
    },
  ): Promise<void> {
    await tx.privilegedSessionHistory.create({
      data: {
        workspaceType: input.lease.workspaceType,
        workspaceId: input.lease.workspaceId,
        schoolId: input.lease.schoolId,
        userId: input.userId,
        operatorProfileId: input.operatorProfileId,
        operatorDisplayName: input.operatorDisplayName,
        sessionId: input.sessionId,
        grantId: input.grantId,
        fencingToken: BigInt(input.fencingToken),
        outcome: input.outcome,
        attemptedAt: input.now,
        acquiredAt: input.now,
        lastActiveAt: input.now,
        sourceIp: input.sourceIp,
        userAgent: input.userAgent,
        correlationId: input.correlationId,
      },
    });
  },

  async recordDenial(
    tx: Tx,
    input: {
      workspaceType: WorkspaceType;
      workspaceId: string;
      schoolId: string | null;
      userId: string;
      operatorProfileId: string | null;
      operatorDisplayName: string | null;
      sessionId: string;
      outcome: 'DENIED_IN_USE' | 'DENIED_POLICY';
      reason: string;
      now: Date;
      sourceIp: string | null;
      userAgent: string | null;
      correlationId: string;
    },
  ): Promise<void> {
    await tx.privilegedSessionHistory.create({
      data: {
        workspaceType: input.workspaceType,
        workspaceId: input.workspaceId,
        schoolId: input.schoolId,
        userId: input.userId,
        operatorProfileId: input.operatorProfileId,
        operatorDisplayName: input.operatorDisplayName,
        sessionId: input.sessionId,
        outcome: input.outcome,
        attemptedAt: input.now,
        endedAt: input.now,
        endReason: input.reason,
        sourceIp: input.sourceIp,
        userAgent: input.userAgent,
        correlationId: input.correlationId,
      },
    });
  },

  async touch(tx: Tx, grantId: string, now: Date): Promise<void> {
    await tx.privilegedSessionHistory.updateMany({
      where: { grantId, endedAt: null },
      data: { lastActiveAt: now },
    });
  },

  async close(tx: Tx, grantId: string, reason: string, now: Date): Promise<void> {
    await tx.privilegedSessionHistory.updateMany({
      where: { grantId, endedAt: null },
      data: { endedAt: now, endReason: reason },
    });
  },
};
