import { z } from 'zod';
import { IsoDateTime, Uuid, WorkspaceTypeSchema } from './common';

/**
 * Event envelope for every message on the broker. Producers publish only through their
 * transactional outbox; consumers deduplicate on `eventId`.
 */
export const EventEnvelope = z.object({
  eventId: Uuid,
  type: z.string().regex(/^[a-z_]+\.[a-z_]+\.[a-z_.]+$/),
  version: z.number().int().positive(),
  occurredAt: IsoDateTime,
  producer: z.string().min(1),
  schoolId: Uuid.nullable(),
  correlationId: z.string().min(1).max(100),
  traceparent: z.string().max(100).nullable(),
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** Routing key on the topic exchange: `<type>.v<version>`. */
export function routingKey(type: string, version: number): string {
  return `${type}.v${version}`;
}

const RoleKeySchema = z.enum([
  'PLATFORM_ADMIN',
  'SCHOOL_ADMIN',
  'DRIVER',
  'GUARDIAN',
  'TRANSPORT_MANAGER',
  'DISPATCHER',
  'BUS_ATTENDANT',
]);

const LeaseStatusSchema = z.enum(['VACANT', 'ACTIVE', 'RELEASED', 'EXPIRED', 'REVOKED']);

/** Catalog of Phase 1 events: name, version, and payload schema. */
export const EVENTS = {
  invitationRequested: {
    type: 'administration.invitation.requested',
    version: 1,
    payload: z.object({
      invitationRequestId: Uuid,
      userId: Uuid,
      schoolId: Uuid.nullable(),
      schoolName: z.string().nullable(),
      kind: z.enum(['PLATFORM_OPERATOR', 'SCHOOL_OPERATOR', 'SCHOOL_MEMBER']),
      role: RoleKeySchema,
    }),
  },
  invitationCancelled: {
    type: 'administration.invitation.cancelled',
    version: 1,
    payload: z.object({ invitationRequestId: Uuid, userId: Uuid }),
  },
  invitationAccepted: {
    type: 'identity.invitation.accepted',
    version: 1,
    payload: z.object({
      invitationRequestId: Uuid,
      userId: Uuid,
      sessionId: Uuid,
      acceptedAt: IsoDateTime,
    }),
  },
  sessionRevoked: {
    type: 'identity.session.revoked',
    version: 1,
    payload: z.object({
      sessionId: Uuid,
      userId: Uuid,
      reason: z.enum(['LOGOUT', 'USER_REVOKED', 'REFRESH_REUSE', 'EXPIRED', 'USER_SUSPENDED']),
    }),
  },
  leaseChanged: {
    type: 'administration.lease.changed',
    version: 1,
    payload: z.object({
      workspaceType: WorkspaceTypeSchema,
      workspaceId: Uuid,
      grantId: Uuid.nullable(),
      sessionId: Uuid.nullable(),
      fencingToken: z.number().int().nonnegative(),
      status: LeaseStatusSchema,
      reason: z.string().nullable(),
    }),
  },
  schoolStatusChanged: {
    type: 'administration.school.status_changed',
    version: 1,
    payload: z.object({ schoolId: Uuid, status: z.enum(['ACTIVE', 'SUSPENDED']) }),
  },
  membershipChanged: {
    type: 'administration.membership.changed',
    version: 1,
    payload: z.object({
      membershipId: Uuid,
      userId: Uuid,
      status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED']),
      roles: z.array(RoleKeySchema),
    }),
  },
  journalEntry: {
    type: 'audit.journal.entry',
    version: 1,
    payload: z.object({
      workspaceType: WorkspaceTypeSchema,
      workspaceId: Uuid,
      actorUserId: Uuid.nullable(),
      operatorProfileId: Uuid.nullable(),
      sessionId: Uuid.nullable(),
      grantId: Uuid.nullable(),
      fencingToken: z.number().int().nonnegative().nullable(),
      originService: z.string(),
      action: z.string().min(3).max(80),
      targetType: z.string().min(2).max(60),
      targetId: z.string().max(100).nullable(),
      outcome: z.enum(['SUCCESS', 'DENIED', 'FAILED']),
      sourceIp: z.string().max(64).nullable(),
      userAgent: z.string().max(256).nullable(),
      changes: z.object({
        before: z.record(z.string(), z.unknown()).nullable(),
        after: z.record(z.string(), z.unknown()).nullable(),
      }),
    }),
  },
  securityEvent: {
    type: 'audit.security_event.recorded',
    version: 1,
    payload: z.object({
      userId: Uuid.nullable(),
      sessionId: Uuid.nullable(),
      eventType: z.string().min(3).max(80),
      outcome: z.enum(['SUCCESS', 'DENIED', 'FAILED']),
      sourceIp: z.string().max(64).nullable(),
      userAgent: z.string().max(256).nullable(),
      details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    }),
  },
} as const;

export type EventName = keyof typeof EVENTS;
export type EventPayload<N extends EventName> = z.infer<(typeof EVENTS)[N]['payload']>;

export function eventRoutingKey(name: EventName): string {
  const definition = EVENTS[name];
  return routingKey(definition.type, definition.version);
}

/** Parses an envelope's payload against the catalog entry; throws on contract violation. */
export function parseEventPayload<N extends EventName>(
  name: N,
  envelope: EventEnvelope,
): EventPayload<N> {
  const definition = EVENTS[name];
  if (envelope.type !== definition.type || envelope.version !== definition.version) {
    throw new Error(
      `Envelope ${envelope.type}.v${envelope.version} is not ${definition.type}.v${definition.version}`,
    );
  }
  return definition.payload.parse(envelope.payload) as EventPayload<N>;
}
