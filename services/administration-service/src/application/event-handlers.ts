import { Inject, Injectable } from '@nestjs/common';
import { parseEventPayload, type EventEnvelope } from '@aegis/contracts';
import type { RoleKey } from '@aegis/domain';
import { USER_CONTEXT, claimInbox, type TenantContext } from '@aegis/service-kit';
import { PrismaService } from '../infrastructure/prisma.service';
import { journal } from './journal';
import { publishMembershipChange } from './invitations';
import { PrivilegedAccessService } from './privileged-access.service';

const CONSUMER = 'administration-service';

/**
 * Consumers of other services' events. Each runs in one transaction that first claims the event
 * in the inbox, so redelivery never applies an effect twice.
 */
@Injectable()
export class AdministrationEventHandlers {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PrivilegedAccessService) private readonly privileged: PrivilegedAccessService,
  ) {}

  /** An invitee proved control of their contact: activate the pending profile and/or membership. */
  async onInvitationAccepted(envelope: EventEnvelope): Promise<void> {
    const payload = parseEventPayload('invitationAccepted', envelope);
    const context: TenantContext =
      envelope.schoolId === null
        ? { kind: 'platform', schoolId: null, userId: payload.userId }
        : { kind: 'school', schoolId: envelope.schoolId, userId: payload.userId };
    const meta = {
      correlationId: envelope.correlationId,
      traceparent: envelope.traceparent,
      sourceIp: null,
      userAgent: null,
    };

    await this.prisma.withContext(context, async (tx) => {
      if (!(await claimInbox(tx, envelope, CONSUMER))) return;
      const now = new Date(payload.acceptedAt);
      const actor = {
        userId: payload.userId,
        operatorProfileId: null,
        sessionId: payload.sessionId,
        grantId: null,
        fencingToken: null,
      };

      const platformProfile = await tx.platformAdminOperatorProfile.findFirst({
        where: {
          invitationRequestId: payload.invitationRequestId,
          userId: payload.userId,
          status: 'INVITED',
        },
      });
      if (platformProfile !== null) {
        await tx.platformAdminOperatorProfile.update({
          where: { id: platformProfile.id },
          data: { status: 'ACTIVE', activatedAt: now },
        });
        await journal(
          tx,
          { type: 'PLATFORM', workspaceId: platformProfile.workspaceId, schoolId: null },
          { ...actor, operatorProfileId: platformProfile.id },
          {
            action: 'INVITATION_ACCEPTED',
            targetType: 'PLATFORM_OPERATOR',
            targetId: platformProfile.id,
            outcome: 'SUCCESS',
            before: { status: 'INVITED' },
            after: { status: 'ACTIVE' },
          },
          meta,
        );
        return;
      }

      if (envelope.schoolId === null) return;
      const schoolId = envelope.schoolId;
      const workspace = await tx.schoolAdministrationWorkspace.findUnique({ where: { schoolId } });
      if (workspace === null) return;

      const schoolProfile = await tx.schoolAdminOperatorProfile.findFirst({
        where: {
          invitationRequestId: payload.invitationRequestId,
          userId: payload.userId,
          schoolId,
          status: 'INVITED',
        },
      });
      if (schoolProfile !== null) {
        await tx.schoolAdminOperatorProfile.update({
          where: { id: schoolProfile.id },
          data: { status: 'ACTIVE', activatedAt: now },
        });
      }

      const membership = await tx.schoolMembership.findFirst({
        where:
          schoolProfile !== null
            ? { schoolId, userId: payload.userId }
            : {
                schoolId,
                userId: payload.userId,
                invitationRequestId: payload.invitationRequestId,
              },
        include: { roleAssignments: { where: { status: 'ACTIVE' } } },
      });
      if (membership !== null && membership.status === 'INVITED') {
        await tx.schoolMembership.update({
          where: { id: membership.id },
          data: { status: 'ACTIVE', activatedAt: now },
        });
        await publishMembershipChange(
          tx,
          {
            membershipId: membership.id,
            userId: payload.userId,
            schoolId,
            status: 'ACTIVE',
            roles: membership.roleAssignments.map((r) => r.roleKey as RoleKey),
          },
          meta,
        );
      }

      if (schoolProfile !== null || membership !== null) {
        await journal(
          tx,
          { type: 'SCHOOL', workspaceId: workspace.id, schoolId },
          { ...actor, operatorProfileId: schoolProfile?.id ?? null },
          {
            action: 'INVITATION_ACCEPTED',
            targetType: schoolProfile !== null ? 'SCHOOL_OPERATOR' : 'MEMBERSHIP',
            targetId: schoolProfile?.id ?? membership?.id ?? null,
            outcome: 'SUCCESS',
            before: { status: 'INVITED' },
            after: { status: 'ACTIVE' },
          },
          meta,
        );
      }
    });
  }

  /** identity-service revoked a session (logout, revocation, refresh-token reuse): end its leases. */
  async onSessionRevoked(envelope: EventEnvelope): Promise<void> {
    const payload = parseEventPayload('sessionRevoked', envelope);
    const meta = {
      correlationId: envelope.correlationId,
      traceparent: envelope.traceparent,
      sourceIp: null,
      userAgent: null,
    };
    await this.prisma.withContext(USER_CONTEXT(payload.userId), async (tx) => {
      if (!(await claimInbox(tx, envelope, CONSUMER))) return;
      await this.privileged.endLeasesOfSession(
        tx,
        { sessionId: payload.sessionId, userId: payload.userId },
        payload.reason === 'LOGOUT' ? 'LOGOUT' : 'SESSION_REVOKED',
        meta,
      );
    });
  }
}
