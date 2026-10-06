# ADR-0001: Microservice backend architecture

- Status: Accepted (product owner decision, 2026-10-06)
- Supersedes: the modular-monolith baseline in the original build prompt and project context
- Related: ADR-0002 (messaging and outbox), ADR-0003 (cross-service privileged lease fencing), ADR-0004 (service-to-service authentication)

## Context

The original requirements specified a modular monolith for the MVP, and said to split services only when measured scale justified it. The product owner decided that the backend will be built as microservices from the start. `Aegis_AI_Build_Prompt.md` and `Aegis_Project_Context.md` were updated to match.

Several Aegis invariants were previously single-database transactions:

- the one-active-operator lease, checked in the same transaction as each privileged command;
- the journal record committed with each privileged mutation;
- notifications tied to accepted events.

A microservice design must keep these guarantees without distributed transactions.

## Decision

1. **Bounded-context services.** The backend is split into these services, each in `services/<name>`:
   - `api-gateway` and `realtime-gateway` (no business data);
   - `identity-service`;
   - `administration-service`;
   - `audit-service`;
   - `school-setup-service`;
   - `trip-service`;
   - `tracking-service`;
   - `notification-service`.

   Ownership is listed in `docs/architecture/service-catalog.md`. The catalog is kept deliberately coarse. Further splits need a new ADR.

2. **Database per service.** Each service has its own PostgreSQL database, roles, migrations, and RLS policies. For the pilot, the databases may share one cluster. Cross-service references are plain UUIDs without foreign keys. No service reads another service's database.
3. **Communication.** Public traffic enters only through `api-gateway` (`/api/v1`). Synchronous internal calls use `/internal/v1` with service tokens. Asynchronous facts flow as versioned events over RabbitMQ through a transactional outbox (producer side) and an idempotent inbox (consumer side).
4. **Authorization in every service.** Each service verifies the end-user access token against the identity JWKS and applies `packages/domain` policies to its own data. The gateway never grants access.
5. **Invariant preservation:**
   - **Lease.** `administration-service` alone mutates leases. Other services validate synchronously on every privileged command, fail closed, and enforce fencing tokens (ADR-0003).
   - **Journal.** The journal record is written to the producer's outbox in the same transaction as the mutation, then appended by `audit-service`. No privileged mutation can commit without a durable journal record.
   - **Revocation.** Session revocation and guardian restriction changes are published as events, and immediacy-critical paths re-check synchronously.
   - **Multi-service workflows.** Provisioning and invitation acceptance run as idempotent sagas with compensation.
6. **Shared code.** Shared code is limited to `packages/contracts`, `domain`, `service-kit`, `config`, `observability`, and `ui`.

## Consequences

**Benefits:**

- Independent deployment, scaling, and failure isolation per bounded context. For example, a `notification-service` failure cannot stop trip event ingestion.
- Clear data ownership, and least-privilege database access per service.

**Costs and risks (accepted by the owner):**

- **More moving parts for a one-school pilot.** There are more containers, databases, and pipelines to operate, plus a broker to run and monitor, so hosting and operating cost is higher.
- **Eventual consistency for journal visibility and read models.** Mitigated by the outbox, lag monitoring, and synchronous checks where immediacy is a security requirement.
- **A residual race window for privileged commands outside `administration-service`.** A takeover can occur between lease validation and commit in a downstream service. Fencing tokens bound this window: once the new holder issues any command to that service, older tokens are rejected. Residual exposure is limited to a single in-flight command, which is still journaled with its grant and token.
- **More test layers.** Contract tests and composed end-to-end tests are required.
- **Schedule risk.** The platform scaffolding (service-kit, gateway, broker, outbox/inbox) adds work in weeks 3–4 of the roadmap.

## Alternatives considered

- **Modular monolith with independently deployable processes.** This was the original baseline. It is simpler and keeps invariants transactional. It was rejected by owner decision.
- **Fine-grained services, such as separate privileged-access, journal-write, and invitation services.** Rejected. These would split tightly coupled invariants across network boundaries for no pilot benefit.
