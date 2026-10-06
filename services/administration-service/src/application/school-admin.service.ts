import { Inject, Injectable } from '@nestjs/common';
import { canSchoolOperatorAssignRole, type RoleKey } from '@aegis/domain';
import { decodeCursor, encodeCursor, type administration } from '@aegis/contracts';
import { AppError, errorForDenial, type AuthContext, type RequestMeta } from '@aegis/service-kit';
import { IDENTITY_CLIENT, type IdentityPort } from '../infrastructure/identity.client';
import type { Tx } from '../infrastructure/prisma.service';
import { idempotent, type IdempotentResult } from './idempotency';
import { cancelInvitation, publishMembershipChange, requestInvitation } from './invitations';
import { applyOperatorStatusChange, operatorView, requireContact } from './platform.service';
import { PrivilegedAccessService, type PrivilegedContext } from './privileged-access.service';

type Meta = Pick<
  RequestMeta,
  'correlationId' | 'sourceIp' | 'userAgent' | 'traceparent' | 'idempotencyKey'
>;

type MembershipWithRoles = {
  id: string;
  userId: string;
  displayName: string;
  contactMasked: string;
  status: string;
  createdAt: Date;
  roleAssignments: Array<{ roleKey: string }>;
};

function membershipView(m: MembershipWithRoles): administration.MembershipView {
  return {
    membershipId: m.id,
    userId: m.userId,
    displayName: m.displayName,
    contactMasked: m.contactMasked,
    status: m.status as administration.MembershipView['status'],
    roles: m.roleAssignments.map((r) => r.roleKey as RoleKey),
    createdAt: m.createdAt.toISOString(),
  };
}

/**
 * School administration. Every method runs under that school's lease; the school comes from the
 * path, is checked against the validated lease, and every write is bound to it. Request bodies
 * never carry a school_id.
 */
@Injectable()
export class SchoolAdminService {
  constructor(
    @Inject(PrivilegedAccessService) private readonly privileged: PrivilegedAccessService,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityPort,
  ) {}

  async inviteUser(
    auth: AuthContext,
    meta: Meta,
    schoolId: string,
    input: { displayName: string; contact: string; role: RoleKey },
  ): Promise<IdempotentResult<administration.MembershipView>> {
    const contact = requireContact(input.contact);
    return this.privileged.runPrivileged(auth, meta, 'school.user.invite', schoolId, (tx, ctx) =>
      idempotent(
        tx,
        {
          actorUserId: auth.userId,
          key: meta.idempotencyKey,
          operation: `school.user.invite:${schoolId}`,
          body: input,
          status: 201,
        },
        async () => {
          const flags = await tx.featureFlag.findMany({ where: { schoolId, enabled: true } });
          const roleDecision = canSchoolOperatorAssignRole(
            input.role,
            new Set(flags.map((f) => f.key)),
          );
          if (!roleDecision.allowed) throw errorForDenial(roleDecision.reason);

          const school = await tx.school.findUnique({ where: { id: schoolId } });
          if (school === null) throw new AppError('NOT_FOUND');
          const user = await this.identity.provisionUser(
            { displayName: input.displayName, contact },
            meta,
          );

          const existing = await tx.schoolMembership.findUnique({
            where: { schoolId_userId: { schoolId, userId: user.userId } },
            include: { roleAssignments: { where: { status: 'ACTIVE' } } },
          });
          if (
            existing !== null &&
            (existing.status === 'SUSPENDED' || existing.status === 'REVOKED')
          ) {
            throw new AppError('CONFLICT', {
              detail: 'This person has a suspended membership. Reactivate it instead.',
            });
          }
          if (existing?.roleAssignments.some((r) => r.roleKey === input.role)) {
            throw new AppError('CONFLICT', {
              detail: 'This person already has this role in your school.',
            });
          }

          let membershipId: string;
          if (existing === null) {
            const invitationRequestId = await requestInvitation(
              tx,
              {
                userId: user.userId,
                schoolId,
                schoolName: school.name,
                kind: 'SCHOOL_MEMBER',
                role: input.role,
              },
              meta,
            );
            const created = await tx.schoolMembership.create({
              data: {
                schoolId,
                userId: user.userId,
                displayName: input.displayName,
                contactMasked: user.contactMasked,
                status: 'INVITED',
                invitationRequestId,
                createdByUserId: auth.userId,
              },
            });
            membershipId = created.id;
          } else {
            membershipId = existing.id;
          }
          await tx.roleAssignment.create({
            data: {
              userId: user.userId,
              schoolId,
              membershipId,
              roleKey: input.role,
              roleScope: 'SCHOOL',
              status: 'ACTIVE',
              grantedByUserId: auth.userId,
            },
          });

          const membership = await this.loadMembership(tx, membershipId);
          await publishMembershipChange(
            tx,
            {
              membershipId,
              userId: user.userId,
              schoolId,
              status: membership.status as 'INVITED' | 'ACTIVE',
              roles: membership.roleAssignments.map((r) => r.roleKey as RoleKey),
            },
            meta,
          );
          await ctx.journal({
            action: 'SCHOOL_USER_INVITED',
            targetType: 'MEMBERSHIP',
            targetId: membershipId,
            outcome: 'SUCCESS',
            before:
              existing === null
                ? null
                : {
                    status: existing.status,
                    roles: existing.roleAssignments.map((r) => r.roleKey),
                  },
            after: {
              userId: user.userId,
              status: membership.status,
              roles: membership.roleAssignments.map((r) => r.roleKey),
              role: input.role,
            },
          });
          return membershipView(membership);
        },
      ),
    );
  }

  async listMemberships(
    auth: AuthContext,
    meta: Meta,
    schoolId: string,
    query: { cursor?: string; limit: number; role?: RoleKey },
  ): Promise<{ items: administration.MembershipView[]; nextCursor: string | null }> {
    return this.privileged.runPrivileged(
      auth,
      meta,
      'school.membership.list',
      schoolId,
      async (tx) => {
        const cursor = decodeCursor(query.cursor);
        const rows = await tx.schoolMembership.findMany({
          where: {
            schoolId,
            ...(query.role === undefined
              ? {}
              : { roleAssignments: { some: { roleKey: query.role, status: 'ACTIVE' } } }),
            ...(cursor === null
              ? {}
              : {
                  OR: [
                    { createdAt: { lt: cursor.at } },
                    { createdAt: cursor.at, id: { lt: cursor.id } },
                  ],
                }),
          },
          include: { roleAssignments: { where: { status: 'ACTIVE' } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
        });
        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        return {
          items: page.map(membershipView),
          nextCursor:
            rows.length > query.limit && last !== undefined
              ? encodeCursor({ at: last.createdAt, id: last.id })
              : null,
        };
      },
    );
  }

  async setMembershipStatus(
    auth: AuthContext,
    meta: Meta,
    schoolId: string,
    membershipId: string,
    target: 'ACTIVE' | 'SUSPENDED',
    reason: string,
  ): Promise<administration.MembershipView> {
    const action =
      target === 'SUSPENDED' ? 'school.membership.suspend' : 'school.membership.reactivate';
    return this.privileged.runPrivileged(auth, meta, action, schoolId, async (tx, ctx) => {
      const before = await tx.schoolMembership.findFirst({
        where: { id: membershipId, schoolId },
        include: { roleAssignments: { where: { status: 'ACTIVE' } } },
      });
      if (before === null) throw new AppError('NOT_FOUND');
      if (before.roleAssignments.some((r) => r.roleKey === 'SCHOOL_ADMIN')) {
        throw new AppError('CONFLICT', {
          detail: 'Use the administrator operator endpoints for school administrators.',
        });
      }

      let status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
      if (target === 'SUSPENDED') {
        if (before.status === 'SUSPENDED' || before.status === 'REVOKED')
          return membershipView(before);
        // An unaccepted invitation is revoked outright and its token cancelled in identity-service.
        status = before.status === 'INVITED' ? 'REVOKED' : 'SUSPENDED';
        if (status === 'REVOKED' && before.invitationRequestId !== null) {
          await cancelInvitation(
            tx,
            { invitationRequestId: before.invitationRequestId, userId: before.userId, schoolId },
            meta,
          );
        }
      } else {
        if (before.status !== 'SUSPENDED') return membershipView(before);
        status = before.activatedAt === null ? 'INVITED' : 'ACTIVE';
      }
      await tx.schoolMembership.update({
        where: { id: membershipId },
        data: { status, statusReason: reason },
      });
      const after = await this.loadMembership(tx, membershipId);
      await publishMembershipChange(
        tx,
        {
          membershipId,
          userId: before.userId,
          schoolId,
          status,
          roles: after.roleAssignments.map((r) => r.roleKey as RoleKey),
        },
        meta,
      );
      await ctx.journal({
        action: target === 'SUSPENDED' ? 'MEMBERSHIP_SUSPENDED' : 'MEMBERSHIP_REACTIVATED',
        targetType: 'MEMBERSHIP',
        targetId: membershipId,
        outcome: 'SUCCESS',
        before: { status: before.status, userId: before.userId },
        after: { status, userId: before.userId },
      });
      return membershipView(after);
    });
  }

  // ---------------------------------------------------------------- school administrator operators

  async createOperator(
    auth: AuthContext,
    meta: Meta,
    schoolId: string,
    input: { displayName: string; contact: string },
  ): Promise<administration.OperatorView> {
    const contact = requireContact(input.contact);
    return this.privileged.runPrivileged(
      auth,
      meta,
      'school.operator.create',
      schoolId,
      async (tx, ctx) => {
        const school = await tx.school.findUnique({ where: { id: schoolId } });
        if (school === null) throw new AppError('NOT_FOUND');
        const user = await this.identity.provisionUser(
          { displayName: input.displayName, contact },
          meta,
        );
        const existingProfile = await tx.schoolAdminOperatorProfile.findFirst({
          where: { schoolId, userId: user.userId },
        });
        if (existingProfile !== null)
          throw new AppError('CONFLICT', {
            detail: 'This person is already an administrator of your school.',
          });

        const invitationRequestId = await requestInvitation(
          tx,
          {
            userId: user.userId,
            schoolId,
            schoolName: school.name,
            kind: 'SCHOOL_OPERATOR',
            role: 'SCHOOL_ADMIN',
          },
          meta,
        );
        const profile = await tx.schoolAdminOperatorProfile.create({
          data: {
            workspaceId: ctx.workspace.workspaceId,
            schoolId,
            userId: user.userId,
            displayName: input.displayName,
            contactMasked: user.contactMasked,
            status: 'INVITED',
            invitationRequestId,
            createdByUserId: auth.userId,
          },
        });
        const membership =
          (await tx.schoolMembership.findUnique({
            where: { schoolId_userId: { schoolId, userId: user.userId } },
          })) ??
          (await tx.schoolMembership.create({
            data: {
              schoolId,
              userId: user.userId,
              displayName: input.displayName,
              contactMasked: user.contactMasked,
              status: 'INVITED',
              createdByUserId: auth.userId,
            },
          }));
        await tx.roleAssignment.create({
          data: {
            userId: user.userId,
            schoolId,
            membershipId: membership.id,
            roleKey: 'SCHOOL_ADMIN',
            roleScope: 'SCHOOL',
            status: 'ACTIVE',
            grantedByUserId: auth.userId,
          },
        });
        await ctx.journal({
          action: 'SCHOOL_OPERATOR_CREATED',
          targetType: 'SCHOOL_OPERATOR',
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
    schoolId: string,
    query: { cursor?: string; limit: number },
  ): Promise<{ items: administration.OperatorView[]; nextCursor: string | null }> {
    return this.privileged.runPrivileged(
      auth,
      meta,
      'school.operator.list',
      schoolId,
      async (tx) => {
        const cursor = decodeCursor(query.cursor);
        const rows = await tx.schoolAdminOperatorProfile.findMany({
          where: {
            schoolId,
            ...(cursor === null
              ? {}
              : {
                  OR: [
                    { createdAt: { lt: cursor.at } },
                    { createdAt: cursor.at, id: { lt: cursor.id } },
                  ],
                }),
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
    schoolId: string,
    profileId: string,
    target: 'ACTIVE' | 'SUSPENDED',
    reason: string,
  ): Promise<administration.OperatorView> {
    const action =
      target === 'SUSPENDED' ? 'school.operator.suspend' : 'school.operator.reactivate';
    return this.privileged.runPrivileged(
      auth,
      meta,
      action,
      schoolId,
      async (tx: Tx, ctx: PrivilegedContext) => {
        const before = await tx.schoolAdminOperatorProfile.findFirst({
          where: { id: profileId, schoolId },
        });
        if (before === null) throw new AppError('NOT_FOUND');
        return applyOperatorStatusChange(tx, ctx, this.privileged, {
          kind: 'SCHOOL',
          before,
          target,
          reason,
          actorUserId: auth.userId,
          meta,
          countActive: () =>
            tx.schoolAdminOperatorProfile.count({ where: { schoolId, status: 'ACTIVE' } }),
          update: (data) =>
            tx.schoolAdminOperatorProfile.update({ where: { id: profileId }, data }),
        });
      },
    );
  }

  private async loadMembership(
    tx: Tx,
    membershipId: string,
  ): Promise<MembershipWithRoles & { activatedAt: Date | null }> {
    const membership = await tx.schoolMembership.findUnique({
      where: { id: membershipId },
      include: { roleAssignments: { where: { status: 'ACTIVE' } } },
    });
    if (membership === null) throw new AppError('NOT_FOUND');
    return membership;
  }
}
