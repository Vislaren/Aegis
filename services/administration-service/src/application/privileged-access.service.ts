import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  activityWindow,
  authorize,
  decideAcquire,
  decideHeartbeat,
  decideTakeover,
  leaseLiveness,
  newLeaseWindow,
  validateLeaseForSession,
  type Action,
  type ActorContext,
  type LeaseCheck,
  type LeaseEndReason,
  type LeaseTimingConfig,
  type WorkspaceType,
} from '@aegis/domain';
import type { WorkspaceSelector, administration } from '@aegis/contracts';
import {
  AppError,
  OUTBOX_PRIORITY,
  USER_CONTEXT,
  enqueueEvent,
  errorForDenial,
  type AuthContext,
  type RequestMeta,
  type TenantContext,
} from '@aegis/service-kit';
import {
  ADMINISTRATION_CONFIG,
  SERVICE_NAME,
  leaseTiming,
  type AdministrationConfig,
} from '../config';
import { PrismaService, type Tx } from '../infrastructure/prisma.service';
import { ActorService, type LoadedActor } from './actor.service';
import { historyRepository, leaseRepository, type LockedLease } from './lease.repository';
import {
  journal,
  securityEvent,
  type JournalActor,
  type JournalRecord,
  type JournalWorkspace,
} from './journal';

type Meta = Pick<RequestMeta, 'correlationId' | 'sourceIp' | 'userAgent' | 'traceparent'>;

interface TargetWorkspace {
  type: WorkspaceType;
  workspaceId: string;
  schoolId: string | null;
  schoolName: string | null;
  operatorProfileId: string;
  operatorDisplayName: string;
}

/** Everything a privileged command needs, established under a validated, locked lease. */
export interface PrivilegedContext {
  loaded: LoadedActor;
  actor: ActorContext;
  lease: LockedLease;
  workspace: JournalWorkspace;
  journalActor: JournalActor;
  meta: Meta;
  now: Date;
  journal(record: JournalRecord, workspaceOverride?: Partial<JournalWorkspace>): Promise<void>;
}

function tenantContextFor(
  target: { type: WorkspaceType; schoolId: string | null },
  userId: string,
): TenantContext {
  return target.type === 'PLATFORM'
    ? { kind: 'platform', schoolId: null, userId }
    : { kind: 'school', schoolId: target.schoolId, userId };
}

function lossError(check: Extract<LeaseCheck, { ok: false }>): AppError {
  return check.reason === 'NO_LEASE' || check.reason === 'NOT_OWNER'
    ? new AppError('PRIVILEGED_LEASE_REQUIRED', { internalReason: check.reason })
    : new AppError('PRIVILEGED_LEASE_LOST', { internalReason: check.reason });
}

@Injectable()
export class PrivilegedAccessService {
  private readonly timing: LeaseTimingConfig;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ActorService) private readonly actors: ActorService,
    @Inject(ADMINISTRATION_CONFIG) config: AdministrationConfig,
  ) {
    this.timing = leaseTiming(config);
  }

  // ---------------------------------------------------------------- public commands

  async acquire(
    auth: AuthContext,
    meta: Meta,
    selector: WorkspaceSelector,
  ): Promise<administration.LeaseView> {
    const loaded = await this.actors.load(auth, meta);
    const target = await this.authorizeAcquisition(loaded, selector, meta);

    const outcome = await this.prisma.withContext(
      tenantContextFor(target, auth.userId),
      async (tx) => {
        const lease = await this.lockTarget(tx, target);
        const now = await leaseRepository.now(tx);
        const decision = decideAcquire(lease, auth.sessionId, now);

        if (decision.kind === 'REUSE')
          return { kind: 'ok' as const, view: this.view(lease, target) };

        if (decision.kind === 'DENY_IN_USE') {
          await historyRepository.recordDenial(tx, {
            workspaceType: target.type,
            workspaceId: target.workspaceId,
            schoolId: target.schoolId,
            userId: auth.userId,
            operatorProfileId: target.operatorProfileId,
            operatorDisplayName: target.operatorDisplayName,
            sessionId: auth.sessionId,
            outcome: 'DENIED_IN_USE',
            reason: 'ADMIN_WORKSPACE_IN_USE',
            now,
            sourceIp: meta.sourceIp,
            userAgent: meta.userAgent,
            correlationId: meta.correlationId,
          });
          await journal(
            tx,
            this.journalWorkspace(target),
            this.journalActorFor(auth, target.operatorProfileId, null, null),
            {
              action: 'PRIVILEGED_LEASE_DENIED',
              targetType: 'PRIVILEGED_LEASE',
              targetId: lease.id,
              outcome: 'DENIED',
            },
            meta,
          );
          return { kind: 'in_use' as const, occupancy: decision.occupancy };
        }

        await this.releaseOtherLeasesOfSession(tx, auth, lease.id, now, meta);
        if (decision.superseded !== null) {
          await this.closeSupersededGrant(
            tx,
            lease,
            decision.superseded.reason === 'IDLE_TIMEOUT' ? 'IDLE_TIMEOUT' : 'HEARTBEAT_EXPIRED',
            now,
            meta,
          );
        }
        const granted = await this.grant(tx, lease, target, auth, now, meta, 'GRANTED', null);
        return { kind: 'ok' as const, view: granted };
      },
    );

    if (outcome.kind === 'in_use') {
      throw new AppError('ADMIN_WORKSPACE_IN_USE', {
        occupancy: {
          operatorDisplayName: outcome.occupancy.operatorDisplayName,
          acquiredAt: outcome.occupancy.acquiredAt.toISOString(),
          lastActivityAt: outcome.occupancy.lastActivityAt.toISOString(),
        },
      });
    }
    return outcome.view;
  }

  async heartbeat(
    auth: AuthContext,
    meta: Meta,
    input: { grantId: string; userActive: boolean },
  ): Promise<administration.LeaseView> {
    const loaded = await this.actors.load(auth, meta);
    const result = await this.prisma.withContext(USER_CONTEXT(auth.userId), async (tx) => {
      const lease = (await leaseRepository.lockActiveForSession(tx, auth.sessionId)).find(
        (l) => l.grantId === input.grantId,
      );
      if (lease === undefined)
        return {
          kind: 'lost' as const,
          error: new AppError('PRIVILEGED_LEASE_LOST', { internalReason: 'no such grant' }),
        };
      const now = await leaseRepository.now(tx);

      // Standing is re-evaluated on every heartbeat: suspension or MFA loss ends access promptly.
      const standing = this.standing(loaded.actor, lease.workspaceType, lease.schoolId);
      if (!standing.allowed) {
        await this.endLease(tx, lease, 'REVOKED', 'OPERATOR_SUSPENDED', now, null, meta);
        return {
          kind: 'lost' as const,
          error: new AppError('PRIVILEGED_LEASE_LOST', { internalReason: standing.reason }),
        };
      }

      const decision = decideHeartbeat(
        lease,
        auth.sessionId,
        input.grantId,
        now,
        input.userActive,
        this.timing,
      );
      if (decision.kind === 'LOST') {
        await this.expireIfStale(tx, lease, now, meta);
        return {
          kind: 'lost' as const,
          error: new AppError('PRIVILEGED_LEASE_LOST', { internalReason: decision.reason }),
        };
      }
      await leaseRepository.renew(tx, lease.id, {
        now,
        expiresAt: decision.expiresAt,
        idleExpiresAt: decision.idleExpiresAt,
        activity: input.userActive,
      });
      if (input.userActive && lease.grantId !== null)
        await historyRepository.touch(tx, lease.grantId, now);
      const target = this.targetFromLoaded(loaded, lease.workspaceType, lease.schoolId);
      return {
        kind: 'ok' as const,
        view: this.view(
          { ...lease, expiresAt: decision.expiresAt, idleExpiresAt: decision.idleExpiresAt },
          target,
        ),
      };
    });
    if (result.kind === 'lost') throw result.error;
    return result.view;
  }

  async release(auth: AuthContext, meta: Meta, grantId: string): Promise<void> {
    await this.prisma.withContext(USER_CONTEXT(auth.userId), async (tx) => {
      const lease = (await leaseRepository.lockActiveForSession(tx, auth.sessionId)).find(
        (l) => l.grantId === grantId,
      );
      if (lease === undefined) return; // Idempotent: releasing an already-ended grant is a no-op.
      const now = await leaseRepository.now(tx);
      await this.endLease(tx, lease, 'RELEASED', 'RELEASED_BY_OPERATOR', now, auth.userId, meta);
    });
  }

  async takeover(
    auth: AuthContext,
    meta: Meta,
    input: { workspace: WorkspaceSelector; reason: string },
  ): Promise<administration.LeaseView> {
    const loaded = await this.actors.load(auth, meta);
    const target = await this.authorizeAcquisition(loaded, input.workspace, meta);
    const mfaVerifiedAt =
      loaded.session.mfaVerifiedAt === null ? null : new Date(loaded.session.mfaVerifiedAt);

    return this.prisma.withContext(tenantContextFor(target, auth.userId), async (tx) => {
      const lease = await this.lockTarget(tx, target);
      const now = await leaseRepository.now(tx);
      const decision = decideTakeover({
        lease,
        requesterSessionId: auth.sessionId,
        mfaVerifiedAt,
        reason: input.reason,
        now,
        config: this.timing,
      });
      if (decision.kind === 'DENY') throw errorForDenial(decision.reason);
      if (decision.kind === 'ALREADY_OWNER') return this.view(lease, target);

      await this.releaseOtherLeasesOfSession(tx, auth, lease.id, now, meta);
      if (decision.kind === 'GRANT_WITHOUT_TAKEOVER') {
        if (decision.superseded !== null) {
          await this.closeSupersededGrant(
            tx,
            lease,
            decision.superseded.reason === 'IDLE_TIMEOUT' ? 'IDLE_TIMEOUT' : 'HEARTBEAT_EXPIRED',
            now,
            meta,
          );
        }
        return this.grant(tx, lease, target, auth, now, meta, 'GRANTED', null);
      }

      // Emergency takeover: the displaced grant ends, attributed to the operator who took over.
      if (lease.grantId !== null) await historyRepository.close(tx, lease.grantId, 'TAKEOVER', now);
      const view = await this.grant(
        tx,
        lease,
        target,
        auth,
        now,
        meta,
        'TAKEOVER',
        decision.displaced.grantId,
      );
      await journal(
        tx,
        this.journalWorkspace(target),
        this.journalActorFor(auth, target.operatorProfileId, view.grantId, view.fencingToken),
        {
          action: 'PRIVILEGED_LEASE_TAKEOVER',
          targetType: 'PRIVILEGED_LEASE',
          targetId: lease.id,
          outcome: 'SUCCESS',
          before: {
            grantId: decision.displaced.grantId,
            sessionId: decision.displaced.sessionId,
            status: 'ACTIVE',
          },
          after: { grantId: view.grantId, status: 'ACTIVE', reason: input.reason.trim() },
        },
        meta,
      );
      return view;
    });
  }

  async current(auth: AuthContext, meta: Meta): Promise<administration.LeaseView | null> {
    const loaded = await this.actors.load(auth, meta);
    return this.currentFor(loaded, auth);
  }

  async currentFor(
    loaded: LoadedActor,
    auth: AuthContext,
  ): Promise<administration.LeaseView | null> {
    return this.prisma.withContext(USER_CONTEXT(auth.userId), async (tx) => {
      const now = await leaseRepository.now(tx);
      const leases = await leaseRepository.lockActiveForSession(tx, auth.sessionId);
      const live = leases.find((l) => leaseLiveness(l, now) === 'HELD');
      if (live === undefined) return null;
      return this.view(live, this.targetFromLoaded(loaded, live.workspaceType, live.schoolId));
    });
  }

  // ---------------------------------------------------------------- privileged command runner

  /**
   * Runs a privileged command. In one transaction it locks the workspace lease row, validates
   * that this session holds it, re-authorizes with the validated lease, extends the activity
   * window, and executes the mutation. A concurrent takeover waits for the row lock, so a
   * command can never commit after its lease was taken over.
   */
  async runPrivileged<T>(
    auth: AuthContext,
    meta: Meta,
    action: Action,
    schoolId: string | undefined,
    fn: (tx: Tx, context: PrivilegedContext) => Promise<T>,
  ): Promise<T> {
    const loaded = await this.actors.load(auth, meta);
    const workspaceType: WorkspaceType = action.startsWith('platform.') ? 'PLATFORM' : 'SCHOOL';
    const assumedLease =
      workspaceType === 'PLATFORM'
        ? ({ workspaceType: 'PLATFORM' } as const)
        : ({ workspaceType: 'SCHOOL', schoolId: schoolId ?? '' } as const);

    // Authorize everything except lease validity before touching the lease row.
    const standing = authorize({ ...loaded.actor, activeLease: assumedLease }, action, {
      schoolId,
    });
    if (!standing.allowed) {
      await this.recordOutsiderDenial(auth, meta, action, standing.reason, schoolId ?? null);
      throw errorForDenial(standing.reason);
    }
    const target = this.targetFromLoaded(loaded, workspaceType, schoolId ?? null);

    const result = await this.prisma.withContext(
      tenantContextFor(target, auth.userId),
      async (tx) => {
        const lease = await this.lockTarget(tx, target);
        const now = await leaseRepository.now(tx);
        const check = validateLeaseForSession(lease, auth.sessionId, now);
        if (!check.ok) {
          await this.expireIfStale(tx, lease, now, meta);
          await journal(
            tx,
            this.journalWorkspace(target),
            this.journalActorFor(auth, target.operatorProfileId, null, null),
            {
              action: 'COMMAND_DENIED',
              targetType: 'PRIVILEGED_LEASE',
              targetId: lease.id,
              outcome: 'DENIED',
              after: { reason: check.reason },
            },
            meta,
          );
          return { kind: 'denied' as const, error: lossError(check) };
        }

        const actor: ActorContext = { ...loaded.actor, activeLease: assumedLease };
        const decision = authorize(actor, action, { schoolId });
        if (!decision.allowed)
          return { kind: 'denied' as const, error: errorForDenial(decision.reason) };

        const window = activityWindow(now, this.timing);
        await leaseRepository.renew(tx, lease.id, {
          now,
          expiresAt: window.expiresAt,
          idleExpiresAt: window.idleExpiresAt,
          activity: true,
        });
        if (lease.grantId !== null) await historyRepository.touch(tx, lease.grantId, now);

        const workspace = this.journalWorkspace(target);
        const journalActor = this.journalActorFor(
          auth,
          target.operatorProfileId,
          lease.grantId,
          lease.fencingToken,
        );
        const context: PrivilegedContext = {
          loaded,
          actor,
          lease,
          workspace,
          journalActor,
          meta,
          now,
          journal: (record, override) =>
            journal(tx, { ...workspace, ...override }, journalActor, record, meta),
        };
        return { kind: 'ok' as const, value: await fn(tx, context) };
      },
    );

    if (result.kind === 'denied') throw result.error;
    return result.value;
  }

  // ---------------------------------------------------------------- internal validation API

  /** Validates a lease for another service (fail closed). Optionally counts as activity. */
  async validateForService(
    input: { sessionId: string; userId: string; workspace?: WorkspaceSelector; touch: boolean },
    meta: Meta,
  ): Promise<administration.ValidatedLease> {
    const auth: AuthContext = { userId: input.userId, sessionId: input.sessionId, aal: 2 };
    const loaded = await this.actors.load(auth, meta);

    let target: TargetWorkspace;
    if (input.workspace !== undefined) {
      const schoolId = input.workspace.type === 'SCHOOL' ? input.workspace.schoolId : null;
      const standing = this.standing(loaded.actor, input.workspace.type, schoolId);
      if (!standing.allowed) throw errorForDenial(standing.reason);
      target = this.targetFromLoaded(loaded, input.workspace.type, schoolId);
    } else {
      const current = await this.currentFor(loaded, auth);
      if (current === null) throw new AppError('PRIVILEGED_LEASE_REQUIRED');
      const standing = this.standing(
        loaded.actor,
        current.workspace.type,
        current.workspace.schoolId,
      );
      if (!standing.allowed) throw errorForDenial(standing.reason);
      target = this.targetFromLoaded(loaded, current.workspace.type, current.workspace.schoolId);
    }

    const result = await this.prisma.withContext(
      tenantContextFor(target, input.userId),
      async (tx) => {
        const lease = await this.lockTarget(tx, target);
        const now = await leaseRepository.now(tx);
        const check = validateLeaseForSession(lease, input.sessionId, now);
        if (!check.ok) {
          await this.expireIfStale(tx, lease, now, meta);
          return { kind: 'denied' as const, error: lossError(check) };
        }
        let expiresAt = lease.expiresAt ?? now;
        if (input.touch) {
          const window = activityWindow(now, this.timing);
          await leaseRepository.renew(tx, lease.id, {
            now,
            expiresAt: window.expiresAt,
            idleExpiresAt: window.idleExpiresAt,
            activity: true,
          });
          if (lease.grantId !== null) await historyRepository.touch(tx, lease.grantId, now);
          expiresAt = window.expiresAt;
        }
        return {
          kind: 'ok' as const,
          lease: {
            grantId: lease.grantId ?? '',
            fencingToken: lease.fencingToken,
            workspaceType: lease.workspaceType,
            workspaceId: lease.workspaceId,
            schoolId: lease.schoolId,
            operatorProfileId: target.operatorProfileId,
            operatorDisplayName: target.operatorDisplayName,
            expiresAt: expiresAt.toISOString(),
          },
        };
      },
    );
    if (result.kind === 'denied') throw result.error;
    return result.lease;
  }

  // ---------------------------------------------------------------- lifecycle from other events

  /** Ends any lease held by a session that identity-service revoked (logout, reuse, revocation). */
  async endLeasesOfSession(
    tx: Tx,
    session: { sessionId: string; userId: string },
    reason: LeaseEndReason,
    meta: Meta,
  ): Promise<number> {
    const leases = await leaseRepository.lockActiveForSession(tx, session.sessionId);
    const now = await leaseRepository.now(tx);
    for (const lease of leases) {
      await this.endLease(
        tx,
        lease,
        reason === 'LOGOUT' ? 'RELEASED' : 'REVOKED',
        reason,
        now,
        session.userId,
        meta,
      );
    }
    return leases.length;
  }

  /** Ends a workspace's live lease (operator suspension, school suspension, forced revocation). */
  async endWorkspaceLease(
    tx: Tx,
    workspaceType: WorkspaceType,
    workspaceId: string,
    reason: LeaseEndReason,
    byUserId: string | null,
    meta: Meta,
    onlyOperatorProfileId?: string,
  ): Promise<boolean> {
    const lease = await leaseRepository.lock(tx, workspaceType, workspaceId);
    if (lease === null || lease.status !== 'ACTIVE') return false;
    if (onlyOperatorProfileId !== undefined && lease.operatorProfileId !== onlyOperatorProfileId)
      return false;
    const now = await leaseRepository.now(tx);
    await this.endLease(tx, lease, 'REVOKED', reason, now, byUserId, meta);
    return true;
  }

  get timingConfig(): LeaseTimingConfig {
    return this.timing;
  }

  // ---------------------------------------------------------------- helpers

  private standing(actor: ActorContext, workspaceType: WorkspaceType, schoolId: string | null) {
    return workspaceType === 'PLATFORM'
      ? authorize(actor, 'privileged.acquire.platform')
      : authorize(actor, 'privileged.acquire.school', { schoolId: schoolId ?? '' });
  }

  private async authorizeAcquisition(
    loaded: LoadedActor,
    selector: WorkspaceSelector,
    meta: Meta,
  ): Promise<TargetWorkspace> {
    const schoolId = selector.type === 'SCHOOL' ? selector.schoolId : null;
    const decision = this.standing(loaded.actor, selector.type, schoolId);
    if (decision.allowed) return this.targetFromLoaded(loaded, selector.type, schoolId);

    const auth = { userId: loaded.actor.userId, sessionId: loaded.actor.sessionId };
    const isOperatorOfTarget =
      selector.type === 'PLATFORM'
        ? loaded.platformOperator !== null
        : loaded.schoolOperators.some((o) => o.schoolId === schoolId);
    if (isOperatorOfTarget) {
      // A legitimate operator was refused (no MFA, suspended, school suspended): keep it in history.
      const target = this.targetFromLoaded(loaded, selector.type, schoolId);
      await this.prisma.withContext(tenantContextFor(target, auth.userId), async (tx) => {
        await historyRepository.recordDenial(tx, {
          workspaceType: target.type,
          workspaceId: target.workspaceId,
          schoolId: target.schoolId,
          userId: auth.userId,
          operatorProfileId: target.operatorProfileId,
          operatorDisplayName: target.operatorDisplayName,
          sessionId: auth.sessionId,
          outcome: 'DENIED_POLICY',
          reason: decision.reason,
          now: await leaseRepository.now(tx),
          sourceIp: meta.sourceIp,
          userAgent: meta.userAgent,
          correlationId: meta.correlationId,
        });
        await journal(
          tx,
          this.journalWorkspace(target),
          this.journalActorFor(auth, target.operatorProfileId, null, null),
          {
            action: 'PRIVILEGED_LEASE_DENIED',
            targetType: 'PRIVILEGED_LEASE',
            targetId: null,
            outcome: 'DENIED',
            after: { reason: decision.reason },
          },
          meta,
        );
      });
    } else {
      await this.recordOutsiderDenial(auth, meta, 'privileged.acquire', decision.reason, schoolId);
    }
    throw errorForDenial(decision.reason);
  }

  /** Denials by people without standing in the workspace go to the security audit stream only. */
  private async recordOutsiderDenial(
    auth: Pick<AuthContext, 'userId' | 'sessionId'>,
    meta: Meta,
    action: string,
    reason: string,
    schoolId: string | null,
  ): Promise<void> {
    await this.prisma.withContext(USER_CONTEXT(auth.userId), (tx) =>
      securityEvent(
        tx,
        {
          userId: auth.userId,
          sessionId: auth.sessionId,
          // Never attribute an outsider's probe to the probed tenant.
          schoolId: null,
          eventType: 'AUTHORIZATION_DENIED',
          outcome: 'DENIED',
          details: { action, reason, requestedSchoolId: schoolId },
        },
        meta,
      ),
    );
  }

  private targetFromLoaded(
    loaded: LoadedActor,
    type: WorkspaceType,
    schoolId: string | null,
  ): TargetWorkspace {
    if (type === 'PLATFORM') {
      const profile = loaded.platformOperator;
      if (profile === null) throw new AppError('FORBIDDEN');
      return {
        type,
        workspaceId: profile.workspaceId,
        schoolId: null,
        schoolName: null,
        operatorProfileId: profile.profileId,
        operatorDisplayName: profile.displayName,
      };
    }
    const profile = loaded.schoolOperators.find((o) => o.schoolId === schoolId);
    if (profile === undefined) throw new AppError('NOT_FOUND');
    return {
      type,
      workspaceId: profile.workspaceId,
      schoolId: profile.schoolId,
      schoolName: loaded.schools.find((s) => s.schoolId === schoolId)?.schoolName ?? null,
      operatorProfileId: profile.profileId,
      operatorDisplayName: profile.displayName,
    };
  }

  private async lockTarget(tx: Tx, target: TargetWorkspace): Promise<LockedLease> {
    const lease = await leaseRepository.lock(tx, target.type, target.workspaceId);
    if (lease === null)
      throw new AppError('NOT_FOUND', { internalReason: 'lease row missing for workspace' });
    return lease;
  }

  private async grant(
    tx: Tx,
    lease: LockedLease,
    target: TargetWorkspace,
    auth: Pick<AuthContext, 'userId' | 'sessionId'>,
    now: Date,
    meta: Meta,
    outcome: 'GRANTED' | 'TAKEOVER',
    takeoverOfGrantId: string | null,
  ): Promise<administration.LeaseView> {
    const grantId = randomUUID();
    const window = newLeaseWindow(now, this.timing);
    const fencingToken = await leaseRepository.grant(tx, lease.id, {
      grantId,
      ownerUserId: auth.userId,
      operatorProfileId: target.operatorProfileId,
      operatorDisplayName: target.operatorDisplayName,
      sessionId: auth.sessionId,
      now,
      expiresAt: window.expiresAt,
      idleExpiresAt: window.idleExpiresAt,
      takeoverOfGrantId,
    });
    await historyRepository.recordGrant(tx, {
      lease,
      outcome,
      userId: auth.userId,
      operatorProfileId: target.operatorProfileId,
      operatorDisplayName: target.operatorDisplayName,
      sessionId: auth.sessionId,
      grantId,
      fencingToken,
      now,
      sourceIp: meta.sourceIp,
      userAgent: meta.userAgent,
      correlationId: meta.correlationId,
    });
    if (outcome === 'GRANTED') {
      await journal(
        tx,
        this.journalWorkspace(target),
        this.journalActorFor(auth, target.operatorProfileId, grantId, fencingToken),
        {
          action: 'PRIVILEGED_LEASE_ACQUIRED',
          targetType: 'PRIVILEGED_LEASE',
          targetId: lease.id,
          outcome: 'SUCCESS',
          after: { grantId, status: 'ACTIVE' },
        },
        meta,
      );
    }
    await this.publishLeaseChange(
      tx,
      lease,
      { grantId, sessionId: auth.sessionId, fencingToken, status: 'ACTIVE', reason: outcome },
      meta,
    );
    const granted: LockedLease = {
      ...lease,
      status: 'ACTIVE',
      grantId,
      fencingToken,
      sessionId: auth.sessionId,
      ownerUserId: auth.userId,
      operatorProfileId: target.operatorProfileId,
      operatorDisplayName: target.operatorDisplayName,
      acquiredAt: now,
      heartbeatAt: now,
      lastActivityAt: now,
      expiresAt: window.expiresAt,
      idleExpiresAt: window.idleExpiresAt,
    };
    return this.view(granted, target);
  }

  private async endLease(
    tx: Tx,
    lease: LockedLease,
    status: 'RELEASED' | 'EXPIRED' | 'REVOKED',
    reason: LeaseEndReason,
    now: Date,
    byUserId: string | null,
    meta: Meta,
  ): Promise<void> {
    await leaseRepository.end(tx, lease.id, { status, reason, now, byUserId });
    if (lease.grantId !== null) await historyRepository.close(tx, lease.grantId, reason, now);
    const action =
      status === 'RELEASED'
        ? 'PRIVILEGED_LEASE_RELEASED'
        : status === 'EXPIRED'
          ? 'PRIVILEGED_LEASE_EXPIRED'
          : 'PRIVILEGED_LEASE_REVOKED';
    await journal(
      tx,
      { type: lease.workspaceType, workspaceId: lease.workspaceId, schoolId: lease.schoolId },
      {
        // Attributed to the holder whose access ended; the initiator is recorded in `after`.
        userId: lease.ownerUserId,
        operatorProfileId: lease.operatorProfileId,
        sessionId: lease.sessionId,
        grantId: lease.grantId,
        fencingToken: lease.fencingToken,
      },
      {
        action,
        targetType: 'PRIVILEGED_LEASE',
        targetId: lease.id,
        outcome: 'SUCCESS',
        before: { status: 'ACTIVE', grantId: lease.grantId },
        after: {
          status,
          releaseReason: reason,
          reason: byUserId === null ? null : `initiated by ${byUserId}`,
        },
      },
      meta,
    );
    await this.publishLeaseChange(
      tx,
      lease,
      {
        grantId: lease.grantId,
        sessionId: lease.sessionId,
        fencingToken: lease.fencingToken,
        status,
        reason,
      },
      meta,
    );
  }

  private async expireIfStale(tx: Tx, lease: LockedLease, now: Date, meta: Meta): Promise<void> {
    const liveness = leaseLiveness(lease, now);
    if (
      lease.status === 'ACTIVE' &&
      (liveness === 'HEARTBEAT_EXPIRED' || liveness === 'IDLE_EXPIRED')
    ) {
      await this.endLease(
        tx,
        lease,
        'EXPIRED',
        liveness === 'IDLE_EXPIRED' ? 'IDLE_TIMEOUT' : 'HEARTBEAT_EXPIRED',
        now,
        null,
        meta,
      );
    }
  }

  private async closeSupersededGrant(
    tx: Tx,
    lease: LockedLease,
    reason: 'HEARTBEAT_EXPIRED' | 'IDLE_TIMEOUT',
    now: Date,
    meta: Meta,
  ): Promise<void> {
    if (lease.status !== 'ACTIVE') return;
    await this.endLease(tx, lease, 'EXPIRED', reason, now, null, meta);
  }

  /** One session exercises one workspace at a time; switching context releases the previous one. */
  private async releaseOtherLeasesOfSession(
    tx: Tx,
    auth: Pick<AuthContext, 'userId' | 'sessionId'>,
    keepLeaseId: string,
    now: Date,
    meta: Meta,
  ): Promise<void> {
    const leases = await leaseRepository.lockActiveForSession(tx, auth.sessionId);
    for (const other of leases.filter((l) => l.id !== keepLeaseId)) {
      await this.endLease(tx, other, 'RELEASED', 'CONTEXT_SWITCH', now, auth.userId, meta);
    }
  }

  private async publishLeaseChange(
    tx: Tx,
    lease: LockedLease,
    change: {
      grantId: string | null;
      sessionId: string | null;
      fencingToken: number;
      status: 'ACTIVE' | 'RELEASED' | 'EXPIRED' | 'REVOKED';
      reason: string;
    },
    meta: Meta,
  ): Promise<void> {
    await enqueueEvent(
      tx,
      'leaseChanged',
      {
        workspaceType: lease.workspaceType,
        workspaceId: lease.workspaceId,
        grantId: change.grantId,
        sessionId: change.sessionId,
        fencingToken: change.fencingToken,
        status: change.status,
        reason: change.reason,
      },
      {
        producer: SERVICE_NAME,
        schoolId: lease.schoolId,
        correlationId: meta.correlationId,
        traceparent: meta.traceparent,
      },
      OUTBOX_PRIORITY.critical,
    );
  }

  private journalWorkspace(
    target: Pick<TargetWorkspace, 'type' | 'workspaceId' | 'schoolId'>,
  ): JournalWorkspace {
    return { type: target.type, workspaceId: target.workspaceId, schoolId: target.schoolId };
  }

  private journalActorFor(
    auth: Pick<AuthContext, 'userId' | 'sessionId'>,
    operatorProfileId: string | null,
    grantId: string | null,
    fencingToken: number | null,
  ): JournalActor {
    return {
      userId: auth.userId,
      operatorProfileId,
      sessionId: auth.sessionId,
      grantId,
      fencingToken,
    };
  }

  private view(lease: LockedLease, target: TargetWorkspace): administration.LeaseView {
    if (
      lease.grantId === null ||
      lease.acquiredAt === null ||
      lease.expiresAt === null ||
      lease.idleExpiresAt === null
    ) {
      throw new AppError('INTERNAL', { internalReason: 'incomplete active lease' });
    }
    return {
      grantId: lease.grantId,
      fencingToken: lease.fencingToken,
      workspace: {
        type: lease.workspaceType,
        workspaceId: lease.workspaceId,
        schoolId: lease.schoolId,
        schoolName: target.schoolName,
      },
      operator: {
        profileId: lease.operatorProfileId ?? target.operatorProfileId,
        displayName: lease.operatorDisplayName ?? target.operatorDisplayName,
      },
      acquiredAt: lease.acquiredAt.toISOString(),
      expiresAt: lease.expiresAt.toISOString(),
      idleExpiresAt: lease.idleExpiresAt.toISOString(),
      heartbeatIntervalSeconds: this.timing.heartbeatIntervalSeconds,
    };
  }
}
