# Phase 0 and Phase 1 implementation plan (microservice architecture)

**Status:** implemented; verification results and open gaps are in [phase-0-1-status.md](phase-0-1-status.md). Architecture changed to microservices by owner decision on 2026-10-06 (`docs/decisions/ADR-0001-microservice-architecture.md`).

**Sources:** `Aegis_AI_Build_Prompt.md` and `Aegis_Project_Context.md`, both updated for the new architecture.

## 1. Repository state at start (2026-10-06)

| Area                            | State found                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| Source code                     | None. Only the two specification files existed.                                     |
| Version control                 | Not a git repository. `git init` was run locally on `main`, with nothing committed. |
| Build host toolchain            | Node 24.5, pnpm 10.28, Docker 29 (Desktop, started for this work), git 2.54.        |
| Tests, CI, infrastructure, docs | None.                                                                               |

**Work already done:**

- Root workspace configuration.
- `packages/domain`, containing:
  - roles;
  - central authorization policy;
  - privileged-lease policy;
  - OTP, session, MFA, and invitation policies;
  - journal redaction.

## 2. Assumptions (recorded as ADRs)

- **Country, timezone, and language:** stored per school. The seed uses fictional `Africa/Douala` and `fr` values. This is not a deployment decision.
- **Identity:**
  - `identity-service` exposes an `IdentityProvider` port. Its built-in passwordless adapter uses a one-time code over email or SMS, plus TOTP MFA for operators. A managed OIDC adapter is deferred. No passwords are stored.
  - Access tokens are signed with an asymmetric key, and services verify them through the published JWKS.
- **Messaging:** RabbitMQ behind a broker port. Every service uses an outbox and an inbox.
- **Message delivery for OTPs and invitations:** a port with three adapters:
  - Mailpit SMTP for local development;
  - in-memory for tests;
  - a configuration guard that refuses non-production adapters in `production`.
- **Lease timing:**
  - heartbeat: 60 s;
  - lease expiry: 300 s;
  - idle timeout: 900 s;
  - MFA freshness window for takeover and revocation: 300 s.
- **Takeover authority (needs an owner decision):**
  - Any active operator of the same workspace may take over, provided their MFA is fresh and they give a reason of at least 10 characters.
  - A platform operator may revoke a stuck school lease. This grants no access to that school's data.

## 3. First vertical slice: identity, administration, audit, gateway

### Packages

```
packages/config          typed env loading (zod), production-safety refusals
packages/domain          shared pure policies (done; tests in progress)
packages/contracts       zod schemas: public API, internal API, event envelope and event payloads; OpenAPI builders
packages/service-kit     NestJS/Fastify bootstrap, problem-details filter, correlation and trace propagation,
                         JWKS token verification, service-token auth for /internal, Zod pipes,
                         tenant-context Prisma transactions (RLS), outbox writer and relay, inbox dedupe, broker port (RabbitMQ)
packages/observability   pino with central redaction, OpenTelemetry bootstrap
packages/ui              accessible React Native design system
```

### Services

```
services/api-gateway             routing table to services, rate limits, CORS/CSRF, request limits, aggregated OpenAPI
services/identity-service        OTP login, invitations (create on event, redeem), TOTP MFA, sessions, refresh rotation
                                 with reuse detection, JWKS, /me, consents, session revocation events
services/administration-service  school provisioning saga, platform and school operators, memberships, role assignments,
                                 feature flags, privileged leases with fencing tokens, session history,
                                 /internal/v1/privileged-access/validate, /internal/v1/authorization/actor-context
services/audit-service           journal consumer with per-workspace hash chain, security events, scoped journal search
services/realtime-gateway        Socket.IO auth; privileged workspace room requires lease; drops room on lease events
apps/client                      Expo Router universal app: sign-in, MFA, role shells, lease gate, profile and sessions
```

### Migrations (one database per service)

| Database               | Migration             | Contents                                                                                                                                                                                              |
| ---------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aegis_identity`       | `0001_identity`       | users, auth factors, OTP challenges, sessions, refresh tokens, trusted devices, consents, invitations, outbox and inbox                                                                               |
| `aegis_administration` | `0001_administration` | roles, schools, settings, workspaces, operator profiles, memberships, role assignments, feature flags, leases (with fencing sequence), session history, support grants, idempotency, outbox and inbox |
| `aegis_administration` | `0002_security`       | RLS, `aegis_app` role grants, and constraints that forbid a school-scoped `PLATFORM_ADMIN`                                                                                                            |
| `aegis_audit`          | `0001_audit`          | audit events, journal with hash-chain trigger, append-only triggers, chain verifier, inbox                                                                                                            |

### Tests

- **Domain unit tests:** lease exclusivity (property test), expiry, idle timeout, reconnect, takeover; authorization matrix; redaction; auth policies.
- **service-kit tests:** outbox relay retry and dead-letter behavior, inbox dedupe, problem-details mapping, token verification.
- **administration-service integration tests (PostgreSQL):**
  - concurrent acquisition has exactly one winner per workspace;
  - different schools are independent;
  - fencing token increases on every grant;
  - lease loss blocks commands while the access token is still valid;
  - cross-tenant substitution, platform-role injection, and mass assignment are rejected;
  - RLS holds when connected as the application role.
- **identity-service integration tests:**
  - OTP throttling, replay, and non-enumeration;
  - invitation expiry and single use;
  - refresh-token reuse detection;
  - logout and revocation publish events.
- **audit-service integration tests:**
  - the journal rejects UPDATE and DELETE;
  - the hash chain verifies;
  - duplicate deliveries are idempotent.
- **Contract tests:** gateway↔services, administration↔identity internal APIs, and event schemas between producers and consumers.
- **Composed end-to-end tests (Docker Compose stack):**
  - platform provisioning → invitation acceptance → MFA → school lease → driver and guardian invitations;
  - a second operator receives `ADMIN_WORKSPACE_IN_USE`;
  - the journal shows the named operators.
- **Client unit tests:** role-home routing.

### Dependencies

TypeScript 6.0 line, Turborepo, Vitest, NestJS on Fastify, Prisma 7.10 with `@prisma/adapter-pg`, zod 4, `@asteasolutions/zod-to-openapi`, `jose` (JWT and JWKS), `otplib`, `amqplib`, Socket.IO, BullMQ, pino, nodemailer, Expo SDK, Expo Router, TanStack Query, Zustand, React Hook Form, `expo-secure-store`.

### Risks

| Risk                                 | Mitigation                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lease race across services           | Atomic `SELECT … FOR UPDATE` in `administration-service`, fencing tokens downstream, fail-closed validation. Covered by concurrency and fencing tests. |
| Lost journal records                 | Outbox in the same transaction as the mutation, relay with publisher confirms, idempotent consumer, lag alert.                                         |
| Revocation latency                   | Privileged paths introspect synchronously, access-token TTL ≤ 5 min, revocation events feed denylists.                                                 |
| Saga partial failure                 | Idempotent steps, an orphaned-user sweeper, and every outcome journaled.                                                                               |
| RLS bypass                           | Each service connects as a non-owner role that is a member of a NOBYPASSRLS role. Migrations run as the owner.                                         |
| Operational weight on the build host | Compose profiles split `infra` from `services`. Integration tests need only PostgreSQL and RabbitMQ.                                                   |

### Acceptance checks for the slice

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:contract`, and `pnpm test:integration` pass.
- `pnpm infra:up`, `pnpm db:migrate`, and `pnpm db:seed` work on a clean machine.
- `pnpm stack:up` starts all Phase 1 services, and the composed end-to-end journey passes through the gateway.
- `api-gateway` shows that internal routes are unreachable from outside.
