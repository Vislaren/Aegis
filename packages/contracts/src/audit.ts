import { z } from 'zod';
import { IsoDateTime, PageQuery, Uuid, WorkspaceTypeSchema, page } from './common';

export const JournalQuery = PageQuery.extend({
  action: z
    .string()
    .regex(/^[A-Z_]{3,80}$/)
    .optional(),
  actorUserId: Uuid.optional(),
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
});

export const JournalEntryView = z.object({
  id: Uuid,
  sequence: z.string(),
  occurredAt: IsoDateTime,
  recordedAt: IsoDateTime,
  workspaceType: WorkspaceTypeSchema,
  schoolId: Uuid.nullable(),
  actorUserId: Uuid.nullable(),
  operatorProfileId: Uuid.nullable(),
  sessionId: Uuid.nullable(),
  grantId: Uuid.nullable(),
  fencingToken: z.number().nullable(),
  originService: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  outcome: z.string(),
  correlationId: z.string(),
  changes: z.object({
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
  }),
  entryHash: z.string(),
});
export const JournalResponse = page(JournalEntryView).extend({
  chainVerified: z.boolean(),
});

export const SecurityEventView = z.object({
  id: Uuid,
  occurredAt: IsoDateTime,
  eventType: z.string(),
  outcome: z.string(),
  sourceIp: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export const SecurityEventQuery = PageQuery;
export const SecurityEventListResponse = page(SecurityEventView);
