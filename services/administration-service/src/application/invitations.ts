import { randomUUID } from 'node:crypto';
import type { RoleKey } from '@aegis/domain';
import { OUTBOX_PRIORITY, enqueueEvent, type RequestMeta } from '@aegis/service-kit';
import { SERVICE_NAME } from '../config';
import type { Tx } from '../infrastructure/prisma.service';

/**
 * Asks identity-service (asynchronously, through the outbox) to issue and deliver a single-use
 * invitation. The request ID links the invitation back to the pending profile or membership,
 * which identity-service's `invitation.accepted` event later activates.
 */
export async function requestInvitation(
  tx: Tx,
  input: {
    userId: string;
    schoolId: string | null;
    schoolName: string | null;
    kind: 'PLATFORM_OPERATOR' | 'SCHOOL_OPERATOR' | 'SCHOOL_MEMBER';
    role: RoleKey;
  },
  meta: Pick<RequestMeta, 'correlationId' | 'traceparent'>,
): Promise<string> {
  const invitationRequestId = randomUUID();
  await enqueueEvent(
    tx,
    'invitationRequested',
    { invitationRequestId, ...input },
    {
      producer: SERVICE_NAME,
      schoolId: input.schoolId,
      correlationId: meta.correlationId,
      traceparent: meta.traceparent,
    },
    OUTBOX_PRIORITY.normal,
  );
  return invitationRequestId;
}

export async function cancelInvitation(
  tx: Tx,
  input: { invitationRequestId: string; userId: string; schoolId: string | null },
  meta: Pick<RequestMeta, 'correlationId' | 'traceparent'>,
): Promise<void> {
  await enqueueEvent(
    tx,
    'invitationCancelled',
    { invitationRequestId: input.invitationRequestId, userId: input.userId },
    {
      producer: SERVICE_NAME,
      schoolId: input.schoolId,
      correlationId: meta.correlationId,
      traceparent: meta.traceparent,
    },
    OUTBOX_PRIORITY.normal,
  );
}

export async function publishMembershipChange(
  tx: Tx,
  input: {
    membershipId: string;
    userId: string;
    schoolId: string;
    status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
    roles: RoleKey[];
  },
  meta: Pick<RequestMeta, 'correlationId' | 'traceparent'>,
): Promise<void> {
  await enqueueEvent(
    tx,
    'membershipChanged',
    {
      membershipId: input.membershipId,
      userId: input.userId,
      status: input.status,
      roles: input.roles,
    },
    {
      producer: SERVICE_NAME,
      schoolId: input.schoolId,
      correlationId: meta.correlationId,
      traceparent: meta.traceparent,
    },
    OUTBOX_PRIORITY.security,
  );
}
