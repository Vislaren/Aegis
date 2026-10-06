import { randomUUID } from 'node:crypto';
import {
  EVENTS,
  eventRoutingKey,
  type EventEnvelope,
  type EventName,
  type EventPayload,
} from '@aegis/contracts';
import type { RawSqlClient } from '../db/raw-sql';

export interface EnvelopeMeta {
  producer: string;
  schoolId: string | null;
  correlationId: string;
  traceparent?: string | null;
}

export function createEnvelope<N extends EventName>(
  name: N,
  payload: EventPayload<N>,
  meta: EnvelopeMeta,
  now: Date = new Date(),
): EventEnvelope {
  const definition = EVENTS[name];
  // Validate on the way out so a producer cannot publish a contract-violating event.
  definition.payload.parse(payload);
  return {
    eventId: randomUUID(),
    type: definition.type,
    version: definition.version,
    occurredAt: now.toISOString(),
    producer: meta.producer,
    schoolId: meta.schoolId,
    correlationId: meta.correlationId,
    traceparent: meta.traceparent ?? null,
    payload,
  };
}

/** Lower numbers publish first: safety and security events must not queue behind routine ones. */
export const OUTBOX_PRIORITY = { critical: 1, security: 2, normal: 5, bulk: 9 } as const;

/**
 * Stages an event in the service's outbox. Call inside the same transaction as the state change
 * so the change and its event commit (or roll back) together.
 */
export async function enqueueEvent<N extends EventName>(
  tx: RawSqlClient,
  name: N,
  payload: EventPayload<N>,
  meta: EnvelopeMeta,
  priority: number = OUTBOX_PRIORITY.normal,
): Promise<EventEnvelope> {
  const envelope = createEnvelope(name, payload, meta);
  await tx.$executeRawUnsafe(
    `INSERT INTO outbox_messages (id, routing_key, envelope, priority) VALUES ($1::uuid, $2, $3::jsonb, $4)`,
    envelope.eventId,
    eventRoutingKey(name),
    JSON.stringify(envelope),
    priority,
  );
  return envelope;
}

/**
 * Records that this consumer has processed an event. Returns false when it was already
 * processed, in which case the handler must do nothing (idempotent consumption).
 * Call first inside the transaction that applies the event's effects.
 */
export async function claimInbox(
  tx: RawSqlClient,
  envelope: EventEnvelope,
  consumer: string,
): Promise<boolean> {
  const inserted = await tx.$executeRawUnsafe(
    `INSERT INTO inbox_messages (event_id, consumer, event_type) VALUES ($1::uuid, $2, $3)
     ON CONFLICT (event_id, consumer) DO NOTHING`,
    envelope.eventId,
    consumer,
    `${envelope.type}.v${envelope.version}`,
  );
  return inserted === 1;
}

/** Shared DDL for every service database. Each service's first migration includes it verbatim. */
export const OUTBOX_INBOX_DDL = `
CREATE TABLE outbox_messages (
  id              uuid PRIMARY KEY,
  routing_key     text NOT NULL,
  envelope        jsonb NOT NULL,
  priority        smallint NOT NULL DEFAULT 5,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'DEAD')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);
CREATE INDEX outbox_messages_pending_idx ON outbox_messages (priority, created_at) WHERE status = 'PENDING';
CREATE TABLE inbox_messages (
  event_id    uuid NOT NULL,
  consumer    text NOT NULL,
  event_type  text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);
`;
