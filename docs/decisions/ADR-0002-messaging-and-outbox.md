# ADR-0002: Messaging, transactional outbox, and idempotent inbox

- **Status:** Accepted (2026-10-06)
- **Context:** Microservices (ADR-0001) must publish facts reliably without distributed transactions. A safety or privileged mutation must never commit without its event, and an event must never be applied twice.

## Decision

- **Broker.** RabbitMQ: Amazon MQ in production, Docker locally. Producers publish to one durable topic exchange, `aegis.events`. Routing keys are `<service>.<entity>.<fact>.v<n>`. The broker sits behind the `MessageBroker` port in `packages/service-kit`, so NATS JetStream or SNS/SQS can replace it.
- **Outbox.** Each producer writes the event to `outbox_messages` in the same transaction as the state change (`enqueueEvent`). The worker's `OutboxRelay` claims rows with `FOR UPDATE SKIP LOCKED`, publishes with publisher confirms, then marks them `PUBLISHED`. Failures retry with capped exponential backoff and full jitter. After `maxAttempts` a row becomes `DEAD`, which raises an alert and needs manual replay. Rows have a priority: critical (lease and session changes) before security (journal) before normal.
- **Inbox.** Each consumer claims `(event_id, consumer)` in `inbox_messages` inside the same transaction as the event's effect (`claimInbox`). A redelivered event is a no-op.
- **Consumer queues.** Each durable consumer queue `Q` is a quorum queue with `Q.retry` (a TTL dead-letter back to `Q`) and `Q.dead`. Ephemeral fan-out consumers, such as realtime-gateway, use exclusive auto-delete queues and rely on periodic revalidation for correctness.
- **Envelope.** The envelope schema is in `packages/contracts/src/events.ts`. Producers validate payloads before staging them; consumers validate on receipt.

## Consequences

- Delivery is at least once, and order is guaranteed only per producer and partition key. Consumers must therefore be idempotent and must tolerate reordering. For example, lease events carry fencing tokens.
- Event visibility is eventually consistent. Outbox lag and dead-letter counts are monitored (`outboxStats`).
- Tests use `InMemoryBroker`, which delivers synchronously, retries, and dead-letters.
