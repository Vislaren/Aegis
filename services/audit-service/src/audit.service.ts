import { Inject, Injectable } from '@nestjs/common';
import {
  audit,
  decodeCursor,
  encodeCursor,
  parseEventPayload,
  type EventEnvelope,
} from '@aegis/contracts';
import { redactForLog } from '@aegis/observability';
import {
  AppError,
  PLATFORM_CONTEXT,
  USER_CONTEXT,
  claimInbox,
  type AuthContext,
  type RequestMeta,
  type TenantContext,
} from '@aegis/service-kit';
import type { z } from 'zod';
import { Prisma } from './generated/prisma/client';
import { LEASE_VALIDATION, PrismaService, type LeaseValidationPort } from './infrastructure';

const CONSUMER = 'audit-service';
const SYSTEM_CONTEXT: TenantContext = { kind: 'system', schoolId: null, userId: null };

type JournalQuery = z.infer<typeof audit.JournalQuery>;

@Injectable()
export class AuditService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LEASE_VALIDATION) private readonly leases: LeaseValidationPort,
  ) {}

  // ---------------------------------------------------------------- ingestion

  /** Appends a journal entry. The event ID is the primary key, so redelivery is a no-op. */
  async onJournalEntry(envelope: EventEnvelope): Promise<void> {
    const entry = parseEventPayload('journalEntry', envelope);
    if (entry.workspaceType === 'SCHOOL' && envelope.schoolId === null) {
      throw new Error('school journal entry without school_id');
    }
    await this.prisma.withContext(SYSTEM_CONTEXT, async (tx) => {
      if (!(await claimInbox(tx, envelope, CONSUMER))) return;
      // createMany avoids RETURNING: the insert-only system context has no read access by design.
      await tx.activityJournal.createMany({
        data: {
          id: envelope.eventId,
          // chain_key, chain_position, prev_hash, entry_hash are set by the database trigger.
          chainKey: '',
          chainPosition: BigInt(0),
          prevHash: '',
          entryHash: '',
          occurredAt: new Date(envelope.occurredAt),
          workspaceType: entry.workspaceType,
          workspaceId: entry.workspaceId,
          schoolId: envelope.schoolId,
          actorUserId: entry.actorUserId,
          operatorProfileId: entry.operatorProfileId,
          sessionId: entry.sessionId,
          grantId: entry.grantId,
          fencingToken: entry.fencingToken === null ? null : BigInt(entry.fencingToken),
          originService: entry.originService,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          outcome: entry.outcome,
          correlationId: envelope.correlationId,
          sourceIp: entry.sourceIp,
          userAgent: entry.userAgent,
          // Producers redact through the domain allowlist (journalChanges) before publishing.
          changes: entry.changes as Prisma.InputJsonValue,
        },
      });
    });
  }

  async onSecurityEvent(envelope: EventEnvelope): Promise<void> {
    const event = parseEventPayload('securityEvent', envelope);
    await this.prisma.withContext(SYSTEM_CONTEXT, async (tx) => {
      if (!(await claimInbox(tx, envelope, CONSUMER))) return;
      await tx.auditEvent.createMany({
        data: {
          id: envelope.eventId,
          occurredAt: new Date(envelope.occurredAt),
          originService: envelope.producer,
          userId: event.userId,
          sessionId: event.sessionId,
          schoolId: envelope.schoolId,
          eventType: event.eventType,
          outcome: event.outcome,
          sourceIp: event.sourceIp,
          userAgent: event.userAgent,
          correlationId: envelope.correlationId,
          details: redactForLog(event.details) as Prisma.InputJsonValue,
        },
      });
    });
  }

  // ---------------------------------------------------------------- queries

  /**
   * Journal search for the workspace whose lease the caller currently holds. The lease is
   * validated synchronously with administration-service on every request (fail closed); the
   * workspace scope comes from that validation, never from the query.
   */
  async searchJournal(
    auth: AuthContext,
    meta: RequestMeta,
    query: JournalQuery,
  ): Promise<z.infer<typeof audit.JournalResponse>> {
    const lease = await this.leases.validate(
      { sessionId: auth.sessionId, userId: auth.userId, touch: true },
      meta,
    );
    const context: TenantContext =
      lease.workspaceType === 'PLATFORM'
        ? PLATFORM_CONTEXT(auth.userId)
        : { kind: 'school', schoolId: lease.schoolId, userId: auth.userId };
    const chainKey = `${lease.workspaceType}:${lease.workspaceId}`;
    const cursor = decodeCursor(query.cursor);

    return this.prisma.withContext(context, async (tx) => {
      const rows = await tx.activityJournal.findMany({
        where: {
          chainKey,
          ...(query.action === undefined ? {} : { action: query.action }),
          ...(query.actorUserId === undefined ? {} : { actorUserId: query.actorUserId }),
          ...(query.from === undefined && query.to === undefined
            ? {}
            : {
                occurredAt: {
                  ...(query.from === undefined ? {} : { gte: new Date(query.from) }),
                  ...(query.to === undefined ? {} : { lte: new Date(query.to) }),
                },
              }),
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { occurredAt: { lt: cursor.at } },
                  { occurredAt: cursor.at, id: { lt: cursor.id } },
                ],
              }),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      });
      const verification = await tx.$queryRawUnsafe<Array<{ broken: bigint | null }>>(
        'SELECT aegis_verify_journal_chain($1) AS broken',
        chainKey,
      );
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          id: row.id,
          sequence: row.chainPosition.toString(),
          occurredAt: row.occurredAt.toISOString(),
          recordedAt: row.recordedAt.toISOString(),
          workspaceType: row.workspaceType as 'PLATFORM' | 'SCHOOL',
          schoolId: row.schoolId,
          actorUserId: row.actorUserId,
          operatorProfileId: row.operatorProfileId,
          sessionId: row.sessionId,
          grantId: row.grantId,
          fencingToken: row.fencingToken === null ? null : Number(row.fencingToken),
          originService: row.originService,
          action: row.action,
          targetType: row.targetType,
          targetId: row.targetId,
          outcome: row.outcome,
          correlationId: row.correlationId,
          changes: row.changes as {
            before: Record<string, unknown> | null;
            after: Record<string, unknown> | null;
          },
          entryHash: row.entryHash,
        })),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor({ at: last.occurredAt, id: last.id })
            : null,
        chainVerified: verification[0]?.broken === null,
      };
    });
  }

  /** The caller's own security events only. */
  async mySecurityEvents(
    auth: AuthContext,
    query: { cursor?: string; limit: number },
  ): Promise<z.infer<typeof audit.SecurityEventListResponse>> {
    const cursor = decodeCursor(query.cursor);
    return this.prisma.withContext(USER_CONTEXT(auth.userId), async (tx) => {
      const rows = await tx.auditEvent.findMany({
        where: {
          userId: auth.userId,
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { occurredAt: { lt: cursor.at } },
                  { occurredAt: cursor.at, id: { lt: cursor.id } },
                ],
              }),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          id: row.id,
          occurredAt: row.occurredAt.toISOString(),
          eventType: row.eventType,
          outcome: row.outcome,
          sourceIp: row.sourceIp,
          userAgent: row.userAgent,
        })),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor({ at: last.occurredAt, id: last.id })
            : null,
      };
    });
  }

  async verifyChain(chainKey: string): Promise<bigint | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ broken: bigint | null }>>(
      'SELECT aegis_verify_journal_chain($1) AS broken',
      chainKey,
    );
    const row = rows[0];
    if (row === undefined) throw new AppError('INTERNAL');
    return row.broken;
  }
}
