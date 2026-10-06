import { OUTBOX_PRIORITY, enqueueEvent, type RequestMeta } from '@aegis/service-kit';
import { SERVICE_NAME } from '../config';
import type { Tx } from '../infrastructure/prisma.service';

type Meta = Pick<RequestMeta, 'correlationId' | 'sourceIp' | 'userAgent' | 'traceparent'>;

/** Security audit event for audit-service (never contains codes, tokens, or full contacts). */
export async function recordSecurityEvent(
  tx: Tx,
  input: {
    userId: string | null;
    sessionId: string | null;
    eventType: string;
    outcome: 'SUCCESS' | 'DENIED' | 'FAILED';
    details?: Record<string, string | number | boolean | null>;
  },
  meta: Meta,
): Promise<void> {
  await enqueueEvent(
    tx,
    'securityEvent',
    {
      userId: input.userId,
      sessionId: input.sessionId,
      eventType: input.eventType,
      outcome: input.outcome,
      sourceIp: meta.sourceIp,
      userAgent: meta.userAgent,
      details: input.details ?? {},
    },
    {
      producer: SERVICE_NAME,
      schoolId: null,
      correlationId: meta.correlationId,
      traceparent: meta.traceparent,
    },
    OUTBOX_PRIORITY.security,
  );
}

export async function publishSessionRevoked(
  tx: Tx,
  input: {
    sessionId: string;
    userId: string;
    reason: 'LOGOUT' | 'USER_REVOKED' | 'REFRESH_REUSE' | 'EXPIRED' | 'USER_SUSPENDED';
  },
  meta: Meta,
): Promise<void> {
  await enqueueEvent(
    tx,
    'sessionRevoked',
    input,
    {
      producer: SERVICE_NAME,
      schoolId: null,
      correlationId: meta.correlationId,
      traceparent: meta.traceparent,
    },
    OUTBOX_PRIORITY.critical,
  );
}
