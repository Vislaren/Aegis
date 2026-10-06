# Aegis

Aegis is a school-transport safety platform. It makes each active trip visible and accountable to the school, the driver, and guardians, with strict tenant isolation, child privacy, and an append-only audit trail. It supplements human supervision; it never replaces drivers, attendants, school procedures, printed manifests, or emergency services.

Requirements live in [`Aegis_AI_Build_Prompt.md`](Aegis_AI_Build_Prompt.md) and [`Aegis_Project_Context.md`](Aegis_Project_Context.md). Current delivery status is in [`docs/plans/phase-0-1-status.md`](docs/plans/phase-0-1-status.md).

## Architecture at a glance

One universal Expo client (Android, iOS, web) talks to one public API (`/api/v1`) served by `api-gateway`. Behind it is a set of microservices organized by bounded context. Each service has its own PostgreSQL database and communicates through versioned internal APIs and RabbitMQ events using a transactional outbox. See [`docs/architecture/overview.md`](docs/architecture/overview.md) and the [service catalog](docs/architecture/service-catalog.md).

| Path                                                       | What it is                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/client`                                              | Universal Expo Router app with role-aware shells                              |
| `services/api-gateway`                                     | Public edge: routing, CORS, CSRF, rate limits; no business data               |
| `services/identity-service`                                | Passwordless sign-in, invitations, sessions, MFA, consents                    |
| `services/administration-service`                          | Tenants, administration workspaces, operators, memberships, privileged leases |
| `services/audit-service`                                   | Hash-chained administrative journal and security events                       |
| `services/realtime-gateway`                                | Authenticated Socket.IO; privileged channel revoked on lease loss             |
| `packages/domain`                                          | Pure policies: authorization, lease rules, auth rules, journal redaction      |
| `packages/contracts`                                       | Zod contracts for public APIs, internal APIs, and events; OpenAPI builder     |
| `packages/service-kit`                                     | Shared service foundation: errors, auth guards, tokens, outbox/inbox, broker  |
| `packages/config`, `packages/observability`, `packages/ui` | Typed config, redacted logging and tracing, design system                     |
| `infrastructure/docker`                                    | Local stack (PostgreSQL/PostGIS, RabbitMQ, Valkey, Mailpit, MinIO, services)  |
| `docs/`                                                    | Architecture, ADRs, security, operations, API                                 |

## Prerequisites

- Node.js 22.12 or later (developed on 24.5) and pnpm 10 through Corepack (`corepack enable`).
- Docker with virtualization enabled, for the local stack. Integration tests can also use any disposable PostgreSQL 15+ server.

## Setup

```bash
corepack enable
pnpm install
node scripts/setup-dev-env.mjs
pnpm build
```

`setup-dev-env.mjs` generates development-only signing keys and peppers into git-ignored `.env` files: one per service, plus `infrastructure/docker/services.env`. It never prints secrets.

## Run locally

```bash
pnpm infra:up
pnpm db:migrate
pnpm --filter @aegis/administration-service bootstrap:platform-operator -- --name "Your Name" --contact you@example.org
pnpm stack:up
pnpm dev:client
```

- `pnpm infra:up` starts PostgreSQL (one database per service), RabbitMQ, Valkey, and Mailpit.
- `pnpm db:migrate` applies each service's migrations as that database's owner role.
- The bootstrap command creates the first named platform operator (there is no self-registration).
- `pnpm stack:up` starts every Phase 1 service and worker. The gateway listens on <http://localhost:3000>.
- `pnpm dev:client` starts the Expo app (web on <http://localhost:8081>).

Invitation links and one-time codes appear in Mailpit at <http://localhost:8025>. SMS is captured as email locally.

## Test

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
```

- `pnpm test` runs unit and policy tests across all packages and services.
- `pnpm test:integration` runs integration tests against real PostgreSQL. It needs `TEST_POSTGRES_ADMIN_URL`, a superuser URL for a disposable server. With the compose stack running, use `postgresql://aegis_superuser:aegis_superuser_dev@localhost:5432/postgres`.

Integration tests create and drop their own databases. Never point them at a shared or production server.

## Build and deploy

- `pnpm build` compiles every package and service.
- `docker build -f infrastructure/docker/service.Dockerfile --build-arg SERVICE=<service> .` builds one service image. The same image runs the API process (`node dist/main.js`) or the worker (`node dist/worker.js`).
- `pnpm openapi:export` writes the aggregated public OpenAPI document to `docs/api/openapi.json`.
- Deployment targets and promotion gates: [`docs/decisions/ADR-0014-deployment.md`](docs/decisions/ADR-0014-deployment.md) and [`docs/operations/release-checklist.md`](docs/operations/release-checklist.md).

## Security

- **Synthetic data only.** Use fictional names and data in development, tests, seeds, and screenshots.
- **No secrets in the repository.** The environment variable reference is [`docs/operations/environment-variables.md`](docs/operations/environment-variables.md).
- **Security references.** The threat model and verification checklist are in [`docs/security/`](docs/security/).
