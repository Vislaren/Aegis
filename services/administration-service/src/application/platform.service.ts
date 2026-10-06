import { Inject, Injectable } from '@nestjs/common';
import { decideForcedRevocation, parseContactIdentifier } from '@aegis/domain';
import { decodeCursor, encodeCursor, type administration } from '@aegis/contracts';
import {
  AppError,
  OUTBOX_PRIORITY,
  applyTenantContext,
  enqueueEvent,
  errorForDenial,
  type AuthContext,
  type RequestMeta,
} from '@aegis/service-kit';
import type { z } from 'zod';
import { SERVICE_NAME } from '../config';
import { IDENTITY_CLIENT, type IdentityPort } from '../infrastructure/identity.client';
import type { Tx } from '../infrastructure/prisma.service';
import { idempotent, type IdempotentResult } from './idempotency';
import { requestInvitation } from './invitations';
import { leaseRepository } from './lease.repository';
import { PrivilegedAccessService, type PrivilegedContext } from './privileged-access.service';

type Meta = Pick<
  RequestMeta,
  'correlationId' | 'sourceIp' | 'userAgent' | 'traceparent' | 'idempotencyKey'
>;
type ProvisionInput = z.infer<typeof administration.ProvisionSchoolRequest>;
type SchoolRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
  countryCode: string;
  defaultLanguage: string;
  createdAt: Date;
};

function schoolView(school: SchoolRow): administration.SchoolView {
  return {
    schoolId: school.id,
    name: school.name,
    slug: school.slug,
    status: school.status as 'ACTIVE' | 'SUSPENDED',
    timezone: school.timezone,
    countryCode: school.countryCode,
    defaultLanguage: school.defaultLanguage,
    createdAt: school.createdAt.toISOString(),
  };
}

export function requireContact(raw: string): string {
  const contact = parseContactIdentifier(raw);
  if (contact === null) {
    throw new AppError('VALIDATION_FAILED', {
      errors: [
        {
          path: 'contact',
          message: 'Enter a valid email address or an international phone number (+...).',
        },
      ],
    });
  }
  return contact.value;
}

/** Platform administration: tenant provisioning and platform operators. No school child data. */
@Injectable()
export class PlatformService {
  constructor(
    @Inject(PrivilegedAccessService) private readonly privileged: PrivilegedAccessService,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityPort,
  ) {}

  /**
   * Manually provisions a school tenant, its single administration workspace, its lease row, and
   * its first named administrator (invited). Runs under the platform lease and is idempotent.
   */
  async provisionSchool(
    auth: AuthContext,
    meta: Meta,
    input: ProvisionInput,
  ): Promise<IdempotentResult<administration.ProvisionSchoolResponse>> {
    const contact = requireContact(input.firstAdministrator.contact);
    return this.privileged.runPrivileged(
      auth,
      meta,
      'platform.school.provision',
      undefined,
      (tx, ctx) =>
        idempotent(
          tx,
          {
            actorUserId: auth.userId,
            key: meta.idempotencyKey,
            operation: 'platform.school.provision',
            body: input,
            status: 201,
          },
          async () => {
            const existingSlug = await tx.school.findUnique({ where: { slug: input.slug } });
            if (existingSlug !== null) {
              throw new AppError('CONFLICT', {
                errors: [{ path: 'slug', message: 'This school identifier is already in use.' }],
              });
            }

            const user = await this.identity.provisionUser(
              { displayName: input.firstAdministrator.displayName, contact },
              meta,
            );

            const school = await tx.school.create({
              data: {
                name: input.name,
                slug: input.slug,
                status: 'ACTIVE',
                timezone: input.timezone,
                countryCode: input.countryCode,
                defaultLanguage: input.defaultLanguage,
                createdByUserId: auth.userId,
              },
            });
            // Narrow the tenant context to the new school for its school-owned rows.
            await applyTenantContext(tx, {
              kind: 'platform',
              schoolId: school.id,
              userId: auth.userId,
            });

            await tx.schoolSettings.create({ data: { schoolId: school.id } });
            const workspace = await tx.schoolAdministrationWorkspace.create({
              data: { schoolId: school.id },
            });
            await leaseRepository.createVacant(tx, 'SCHOOL', workspace.id, school.id);

            const invitationRequestId = await requestInvitation(
              tx,
              {
                userId: user.userId,
                schoolId: school.id,
                schoolName: school.name,
                kind: 'SCHOOL_OPERATOR',
                role: 'SCHOOL_ADMIN',
              },
              meta,
            );
            const profile = await tx.schoolAdminOperatorProfile.create({
              data: {
                workspaceId: workspace.id,
                schoolId: school.id,
                userId: user.userId,
                displayName: input.firstAdministrator.displayName,
                contactMasked: user.contactMasked,
                status: 'INVITED',
                invitationRequestId,
                createdByUserId: auth.userId,
              },
            });
            const membership = await tx.schoolMembership.create({
              data: {
                schoolId: school.id,
                userId: user.userId,
                displayName: input.firstAdministrator.displayName,
                contactMasked: user.contactMasked,
                status: 'INVITED',
                invitationRequestId: null,
                createdByUserId: auth.userId,
              },
            });
            await tx.roleAssignment.create({
              data: {
                userId: user.userId,
                schoolId: school.id,
                membershipId: membership.id,
                roleKey: 'SCHOOL_ADMIN',
                roleScope: 'SCHOOL',
                status: 'ACTIVE',
                grantedByUserId: auth.userId,
              },
            });
            await enqueueEvent(
              tx,
              'schoolStatusChanged',
              { schoolId: school.id, status: 'ACTIVE' },
              {
                producer: SERVICE_NAME,
                schoolId: school.id,
                correlationId: meta.correlationId,
                traceparent: meta.traceparent,
              },
              OUTBOX_PRIORITY.normal,
            );

            await ctx.journal(
              {
                action: 'SCHOOL_PROVISIONED',
                targetType: 'SCHOOL',
                targetId: school.id,
                outcome: 'SUCCESS',
                after: school,
              },
              { schoolId: school.id },
            );
            await ctx.journal(
              {
                action: 'SCHOOL_OPERATOR_CREATED',
                targetType: 'SCHOOL_OPERATOR',
                targetId: profile.id,
                outcome: 'SUCCESS',
                after: {
                  displayName: profile.displayName,
                  status: profile.status,
                  userId: profile.userId,
                },
              },
              { schoolId: school.id },
            );

            return {
              school: schoolView(school),
              firstAdministrator: {
                userId: user.userId,
                operatorProfileId: profile.id,
                status: 'INVITED' as const,
                contactMasked: user.contactMasked,
              },
            };
          },
        ),
    );
  }

  async listSchools(
    auth: AuthContext,
    meta: Meta,
    query: { cursor?: string; limit: number },
  ): Promise<{ items: administration.SchoolView[]; nextCursor: string | null }> {
    return this.privileged.runPrivileged(
      auth,
      meta,
      'platform.school.list',
      undefined,
      async (tx) => {
        const cursor = decodeCursor(query.cursor);
        const rows = await tx.school.findMany({
          where:
            cursor === null
              ? {}
              : {
                  OR: [
                    { createdAt: { lt: cursor.at } },
                    { createdAt: cursor.at, id: { lt: cursor.id } },
                  ],
                },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
        });
        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        return {
          items: page.map(schoolView),
          nextCursor:
            rows.length > query.limit && last !== undefined
              ? encodeCursor({ at: last.createdAt, id: last.id })
              : null,
        };
      },
    );
  }

  async setSchoolStatus(
    auth: AuthContext,
    meta: Meta,
    schoolId: string,
    status: 'ACTIVE' | 'SUSPENDED',
    reason: string,
  ): Promise<administration.SchoolView> {
    const action =
      status === 'SUSPENDED' ? 'platform.school.suspend' : 'platform.school.reactivate';
    return this.privileged.runPrivileged(auth, meta, action, undefined, async (tx, ctx) => {
      const before = await tx.school.findUnique({ where: { id: schoolId } });
      if (before === null) throw new AppError('NOT_FOUND');
      if (before.status === status) return schoolView(before);
      const after = await tx.school.update({
        where: { id: schoolId },
        data: { status, statusReason: reason },
      });

      if (status === 'SUSPENDED') {
        await applyTenantContext(tx, { kind: 'platform', schoolId, userId: auth.userId });
        const workspace = await tx.schoolAdministrationWorkspace.findUnique({
          where: { schoolId },
        });
        if (workspace !== null) {
          await this.privileged.endWorkspaceLease(
            tx,
            'SCHOOL',
            workspace.id,
            'SCHOOL_SUSPENDED',
            auth.userId,
            meta,
          );
        }
      }
      await enqueueEvent(
        tx,
        'schoolStatusChanged',
        { schoolId, status },
        {
          producer: SERVICE_NAME,
          schoolId,
          correlationId: meta.correlationId,
          traceparent: meta.traceparent,
        },
        OUTBOX_PRIORITY.security,
      );
      await ctx.journal(
        {
          action: status === 'SUSPENDED' ? 'SCHOOL_SUSPENDED' : 'SCHOOL_REACTIVATED',
          targetType: 'SCHOOL',
          targetId: schoolId,
          outcome: 'SUCCESS',
          before,
          after,
        },
        { schoolId },
      );
      return schoolView(after);
    });
  }

  /**
   * Unlocks a stuck school administration workspace. Requires fresh MFA and a reason. The platform
   * operator gains no access to the school's data: only the lease row and its history are touched.
   */
  async revokeSchoolLease(
    auth: AuthContext,
    meta: Meta,
    schoolId: string,
    reason: string,
  ): Promise<{ revoked: boolean }> {
    return this.privileged.runPrivileged(
      auth,
      meta,
      'platform.school_lease.revoke',
      undefined,
      async (tx, ctx) => {
        const school = await tx.school.findUnique({ where: { id: schoolId } });
        if (school === null) throw new AppError('NOT_FOUND');
        await applyTenantContext(tx, { kind: 'platform', schoolId, userId: auth.userId });
        const workspace = await tx.schoolAdministrationWorkspace.findUnique({
          where: { schoolId },
        });
        if (workspace === null) throw new AppError('NOT_FOUND');
        const lease = await leaseRepository.lock(tx, 'SCHOOL', workspace.id);
        if (lease === null) throw new AppError('NOT_FOUND');

        const now = await leaseRepository.now(tx);
        const mfaVerifiedAt =
          ctx.loaded.session.mfaVerifiedAt === null
            ? null
            : new Date(ctx.loaded.session.mfaVerifiedAt);
        const decision = decideForcedRevocation({
          lease,
          mfaVerifiedAt,
          reason,
          now,
          config: this.privileged.timingConfig,
        });
        if (decision.kind === 'DENY') throw errorForDenial(decision.reason);
        if (decision.kind === 'NOTHING_TO_REVOKE') return { revoked: false };

        await this.privileged.endWorkspaceLease(
          tx,
          'SCHOOL',
          workspace.id,
          'FORCED_REVOCATION',
          auth.userId,
          meta,
        );
        await ctx.journal(
          {
            action: 'PRIVILEGED_LEASE_REVOKED',
            targetType: 'PRIVILEGED_LEASE',
            targetId: lease.id,
            outcome: 'SUCCESS',
            before: { status: 'ACTIVE', grantId: decision.displaced.grantId },
            after: { status: 'REVOKED', releaseReason: 'FORCED_REVOCATION', reason },
          },
          { schoolId },
        );
        return { revoked: true };
      },
    );
  }

  // ---------------------------------------------------------------- platform operators

  async createOperator(
    auth: AuthContext,
    meta: Meta,
    input: { displayName: string; contact: string },
  ): Promise<administration.OperatorView> {
    const contact = requireContact(input.contact);
    return this.privileged.runPrivileged(
      auth,
      meta,
      'platform.operator.create',
      undefined,
      async (tx, ctx) => {
        const user = await this.identity.provisionUser(
          { displayName: input.displayName, contact },
          meta,
        );
        const existing = await tx.platformAdminOperatorProfile.findFirst({
          where: { userId: user.userId },
        });
        if (existing !== null)
          throw new AppError('CONFLICT', { detail: 'This person is already a platform operator.' });

        const invitationRequestId = await requestInvitation(
          tx,
          {
            userId: user.userId,
            schoolId: null,
            schoolName: null,
            kind: 'PLATFORM_OPERATOR',
            role: 'PLATFORM_ADMIN',
          },
          meta,
        );
        const profile = await tx.platformAdminOperatorProfile.create({
          data: {
            workspaceId: ctx.workspace.workspaceId,
            userId: user.userId,
            displayName: input.displayName,
            contactMasked: user.contactMasked,
            status: 'INVITED',
            invitationRequestId,
            createdByUserId: auth.userId,
          },
        });
        await tx.roleAssignment.create({
          data: {
            userId: user.userId,
            roleKey: 'PLATFORM_ADMIN',
            roleScope: 'PLATFORM',
            status: 'ACTIVE',
            grantedByUserId: auth.userId,
          },
        });
        await ctx.journal({
          action: 'PLATFORM_OPERATOR_CREATED',
          targetType: 'PLATFORM_OPERATOR',
          targetId: profile.id,
          outcome: 'SUCCESS',
          after: profile,
        });
        return operatorView(profile);
      },
    );
  }

  async listOperators(
    auth: AuthContext,
    meta: Meta,
    query: { cursor?: string; limit: number },
  ): Promise<{ items: administration.OperatorView[]; nextCursor: string | null }> {
    return this.privileged.runPrivileged(
      auth,
      meta,
      'platform.operator.list',
      undefined,
      async (tx) => {
        const cursor = decodeCursor(query.cursor);
        const rows = await tx.platformAdminOperatorProfile.findMany({
          where:
            cursor === null
              ? {}
              : {
                  OR: [
                    { createdAt: { lt: cursor.at } },
                    { createdAt: cursor.at, id: { lt: cursor.id } },
                  ],
                },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
        });
        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        return {
          items: page.map(operatorView),
          nextCursor:
            rows.length > query.limit && last !== undefined
              ? encodeCursor({ at: last.createdAt, id: last.id })
              : null,
        };
      },
    );
  }

  async setOperatorStatus(
    auth: AuthContext,
    meta: Meta,
    profileId: string,
    target: 'ACTIVE' | 'SUSPENDED',
    reason: string,
  ): Promise<administration.OperatorView> {
    const action =
      target === 'SUSPENDED' ? 'platform.operator.suspend' : 'platform.operator.reactivate';
    return this.privileged.runPrivileged(auth, meta, action, undefined, async (tx, ctx) => {
      const before = await tx.platformAdminOperatorProfile.findUnique({ where: { id: profileId } });
      if (before === null) throw new AppError('NOT_FOUND');
      return applyOperatorStatusChange(tx, ctx, this.privileged, {
        kind: 'PLATFORM',
        before,
        target,
        reason,
        actorUserId: auth.userId,
        meta,
        countActive: () => tx.platformAdminOperatorProfile.count({ where: { status: 'ACTIVE' } }),
        update: (data) =>
          tx.platformAdminOperatorProfile.update({ where: { id: profileId }, data }),
      });
    });
  }
}

export type OperatorRow = {
  id: string;
  userId: string;
  displayName: string;
  contactMasked: string;
  status: string;
  activatedAt: Date | null;
  createdAt: Date;
  workspaceId: string;
};

export function operatorView(profile: OperatorRow): administration.OperatorView {
  return {
    profileId: profile.id,
    userId: profile.userId,
    displayName: profile.displayName,
    contactMasked: profile.contactMasked,
    status: profile.status as 'INVITED' | 'ACTIVE' | 'SUSPENDED',
    createdAt: profile.createdAt.toISOString(),
  };
}

/**
 * Shared suspend/reactivate rules for platform and school operators:
 *  - an operator cannot suspend themselves;
 *  - the last active operator of a workspace cannot be suspended (no lock-out);
 *  - suspension ends any lease that operator holds on this workspace;
 *  - reactivation of a never-activated operator returns to INVITED, not ACTIVE.
 */
export async function applyOperatorStatusChange(
  tx: Tx,
  ctx: PrivilegedContext,
  privileged: PrivilegedAccessService,
  input: {
    kind: 'PLATFORM' | 'SCHOOL';
    before: OperatorRow;
    target: 'ACTIVE' | 'SUSPENDED';
    reason: string;
    actorUserId: string;
    meta: Pick<RequestMeta, 'correlationId' | 'sourceIp' | 'userAgent' | 'traceparent'>;
    countActive: () => Promise<number>;
    update: (data: { status: string; statusReason: string }) => Promise<OperatorRow>;
  },
): Promise<administration.OperatorView> {
  const { before, target } = input;
  if (target === 'SUSPENDED') {
    if (before.status === 'SUSPENDED') return operatorView(before);
    if (before.userId === input.actorUserId) {
      throw new AppError('CONFLICT', { detail: 'You cannot suspend your own operator profile.' });
    }
    if (before.status === 'ACTIVE' && (await input.countActive()) <= 1) {
      throw new AppError('CONFLICT', {
        detail: 'The last active operator of a workspace cannot be suspended.',
      });
    }
    const after = await input.update({ status: 'SUSPENDED', statusReason: input.reason });
    await privileged.endWorkspaceLease(
      tx,
      input.kind,
      before.workspaceId,
      'OPERATOR_SUSPENDED',
      input.actorUserId,
      input.meta,
      before.id,
    );
    await ctx.journal({
      action:
        input.kind === 'PLATFORM' ? 'PLATFORM_OPERATOR_SUSPENDED' : 'SCHOOL_OPERATOR_SUSPENDED',
      targetType: input.kind === 'PLATFORM' ? 'PLATFORM_OPERATOR' : 'SCHOOL_OPERATOR',
      targetId: before.id,
      outcome: 'SUCCESS',
      before,
      after,
    });
    return operatorView(after);
  }

  if (before.status !== 'SUSPENDED') return operatorView(before);
  const after = await input.update({
    status: before.activatedAt === null ? 'INVITED' : 'ACTIVE',
    statusReason: input.reason,
  });
  await ctx.journal({
    action:
      input.kind === 'PLATFORM' ? 'PLATFORM_OPERATOR_REACTIVATED' : 'SCHOOL_OPERATOR_REACTIVATED',
    targetType: input.kind === 'PLATFORM' ? 'PLATFORM_OPERATOR' : 'SCHOOL_OPERATOR',
    targetId: before.id,
    outcome: 'SUCCESS',
    before,
    after,
  });
  return operatorView(after);
}
