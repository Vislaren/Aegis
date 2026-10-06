import {
  journalChanges,
  type JournalAction,
  type JournalTargetType,
  type WorkspaceType,
} from '@aegis/domain';
import { OUTBOX_PRIORITY, enqueueEvent, type RequestMeta } from '@aegis/service-kit';
import { SERVICE_NAME } from '../config';
import type { Tx } from '../infrastructure/prisma.service';

export interface JournalActor {
  userId: string | null;
  operatorProfileId: string | null;
  sessionId: string | null;
  grantId: string | null;
  fencingToken: number | null;
}

export interface JournalWorkspace {
  type: WorkspaceType;
  workspaceId: string;
  /** The tenant the entry concerns (target school for platform provisioning). */
  schoolId: string | null;
}

export interface JournalRecord {
  action: JournalAction;
  targetType: JournalTargetType;
  targetId: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILED';
  before?: Readonly<Record<string, unknown>> | null;
  after?: Readonly<Record<string, unknown>> | null;
}

/**
 * Stages a journal entry in the outbox inside the caller's transaction. The privileged mutation
 * and its journal record therefore commit together; audit-service appends it to the hash chain.
 */
export async function journal(
  tx: Tx,
  workspace: JournalWorkspace,
  actor: JournalActor,
  record: JournalRecord,
  meta: Pick<RequestMeta, 'correlationId' | 'sourceIp' | 'userAgent' | 'traceparent'>,
): Promise<void> {
  await enqueueEvent(
    tx,
    'journalEntry',
    {
      workspaceType: workspace.type,
      workspaceId: workspace.workspaceId,
      actorUserId: actor.userId,
      operatorProfileId: actor.operatorProfileId,
      sessionId: actor.sessionId,
      grantId: actor.grantId,
      fencingToken: actor.fencingToken,
      originService: SERVICE_NAME,
      action: record.action,
      targetType: record.targetType,
      targetId: record.targetId,
      outcome: record.outcome,
      sourceIp: meta.sourceIp,
      userAgent: meta.userAgent,
      changes: journalChanges(record.targetType, record.before ?? null, record.after ?? null),
    },
    {
      producer: SERVICE_NAME,
      schoolId: workspace.schoolId,
      correlationId: meta.correlationId,
      traceparent: meta.traceparent,
    },
    OUTBOX_PRIORITY.security,
  );
}

export async function securityEvent(
  tx: Tx,
  input: {
    userId: string | null;
    sessionId: string | null;
    schoolId: string | null;
    eventType: string;
    outcome: 'SUCCESS' | 'DENIED' | 'FAILED';
    details?: Record<string, string | number | boolean | null>;
  },
  meta: Pick<RequestMeta, 'correlationId' | 'sourceIp' | 'userAgent' | 'traceparent'>,
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
      schoolId: input.schoolId,
      correlationId: meta.correlationId,
      traceparent: meta.traceparent,
    },
    OUTBOX_PRIORITY.security,
  );
}
