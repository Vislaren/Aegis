# Phase 0 and Phase 1 status

**Date:** 2026-10-06. **Architecture:** microservices (ADR-0001). **Plan:** [phase-0-1-plan.md](phase-0-1-plan.md).

## Verification results (actual runs on the build host)

| Suite                                                                                | Command                                                        | Result                                       |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------- |
| Domain policies (lease, authorization, auth, redaction)                              | `vitest run` in `packages/domain`                              | 85 / 85 passed                               |
| Config refusals                                                                      | `packages/config`                                              | 4 / 4 passed                                 |
| Contracts, OpenAPI, event catalog                                                    | `packages/contracts`                                           | 7 / 7 passed                                 |
| Log redaction                                                                        | `packages/observability`                                       | 3 / 3 passed                                 |
| service-kit (errors, tokens, broker, backoff, cookies)                               | `packages/service-kit`                                         | 10 / 10 passed                               |
| Gateway routing and CSRF                                                             | `services/api-gateway`                                         | 6 / 6 passed                                 |
| Realtime privileged channel (Socket.IO, lease loss, revocation, fail-closed)         | `services/realtime-gateway`                                    | 4 / 4 passed                                 |
| administration-service boot (DI, deny-by-default, strict input)                      | `services/administration-service`                              | 6 / 6 passed                                 |
| Client core (role routing, lease keeper, API client, driver capability)              | `apps/client`                                                  | 10 / 10 passed                               |
| **Integration:** administration-service                                              | `pnpm --filter @aegis/administration-service test:integration` | 11 / 11 passed                               |
| **Integration:** identity-service                                                    | `pnpm --filter @aegis/identity-service test:integration`       | 13 / 13 passed                               |
| **Integration:** audit-service                                                       | `pnpm --filter @aegis/audit-service test:integration`          | 6 / 6 passed                                 |
| **Composed journey** through the gateway, across identity, administration, and audit | `pnpm --filter @aegis/administration-service test:e2e`         | 2 / 2 passed                                 |
| Type-check (all packages and services, including tests)                              | `tsc --noEmit`                                                 | 0 errors                                     |
| Lint                                                                                 | `eslint` (backend packages and services)                       | 0 problems                                   |
| Build                                                                                | `tsc -p tsconfig.build.json` (all packages and services)       | Success; compiled modules load under Node 24 |

Integration and end-to-end tests ran against **real PostgreSQL 18.4**, a native disposable server on the build host, with every service's reviewed migrations applied to fresh databases.

### Additional checks

**Migrations.** `prisma migrate deploy` applied every migration for identity, administration, and audit to fresh databases created by the Docker init script. The `prisma:drift` check found no column-level differences; see [migrations.md](../operations/migrations.md).

**Live process smoke test.** The compiled `main.js` processes for identity, administration, audit, and the gateway ran natively with the generated `.env` files. Results:

- All readiness probes reported their database as healthy.
- Through the gateway:
  - policy documents were served;
  - `/internal/*` returned 404;
  - an unauthenticated `/me` returned a 401 problem response;
  - OTP start returned 202 with correct UTC expiry;
  - a cookie request without a CSRF token returned 403;
  - 30 OpenAPI paths were served.
- CSP, `nosniff`, `no-store`, correlation-ID, and rate-limit headers were present.

**Port conflict on this machine.** Another application already listens on port 3000, so the gateway was run on 3100 with `PORT=3100`.

**Configuration refusal.** Starting a service with `NODE_ENV=production` and unsafe settings fails at startup. The error lists only the violated rules and never secret values.

### Behaviors proven by the integration and end-to-end tests

**Administration workspaces and leases**

- Exactly one of eight concurrent independent sessions acquires the platform lease. The rest receive `ADMIN_WORKSPACE_IN_USE` with only the approved holder fields. The same session reconnects to the same grant.
- Administrators of different schools hold their own schools' leases concurrently. A second session of the same school is denied.
- When a lease expires, the next command is refused with `PRIVILEGED_LEASE_LOST` even though the access token is still valid.
- Takeover needs fresh MFA and a reason. It raises the fencing token, and the displaced holder is refused.
- Logout ends the lease through the event path, and redelivered events are no-ops.
- Privileged access fails closed when identity-service is unavailable.

**Provisioning, invitations, and tenant isolation**

- Provisioning a school is idempotent. Reusing an idempotency key with a different body is refused (422), and a missing key is refused (400).
- Journal entries carry the named operator, session, grant, and fencing token, and never contain clear-text contacts.
- Cross-tenant invitation attempts return 404. Smuggling `schoolId` in a request body is rejected. Inviting `PLATFORM_ADMIN` or `SCHOOL_ADMIN` is refused, and roles behind feature flags stay disabled.
- The runtime role sees only its own tenant under RLS and sees nothing without a context. It cannot write the platform role. Even the owner role cannot bind the platform role to a school.
- Privileged session history and lease rows are append-only or guarded. Fencing tokens never decrease.

**Internal API**

- The internal validation API requires an allowlisted service token. End-user tokens are rejected there.

**Identity**

- Sign-in does not reveal whether an account exists, is throttled, and its codes are single-use and exhaust after 5 attempts.
- Invited-but-unredeemed identities cannot sign in.
- Invitations are single-use and can expire.
- Web sign-in sets HttpOnly cookies and returns no tokens in the body.
- MFA enrollment raises the session to AAL2. Replayed TOTP codes are rejected, and repeated failures revoke the session.
- A reused refresh token revokes the session.
- Users can revoke only their own sessions. Logout takes effect immediately.
- Session introspection is restricted to allowlisted services.
- Consent records are append-only and accept only the current policy version.

**Audit journal**

- Concurrent ingestion produces an unforked chain, and redelivery is idempotent.
- UPDATE, DELETE, and TRUNCATE are refused for both the runtime and owner roles.
- Tampering is detected by `aegis_verify_journal_chain`.
- Journal search is scoped to the leased workspace. The platform cannot read school journals, and the reverse also holds.

**Composed journey through the gateway**

1. Bootstrap the platform operator.
2. Redeem the invitation, enroll MFA, and acquire the platform lease.
3. Provision a school.
4. The school administrator redeems their invitation, enrolls MFA, and opens the school workspace.
5. Invite a driver and a guardian.
6. The driver redeems their invitation. They see only their driver context and cannot reach school administration.
7. Both journals verify and are scoped correctly.
8. Logout releases the lease.
9. A second device session is denied while the lease is held, and granted after release.

### Defects found and fixed by the test suites

- **Timezone shift on raw timestamps.** The PostgreSQL driver adapter shifted `timestamptz` values from raw queries by the server's UTC offset (+1 h on this host). The effects were:
  - fresh MFA was judged stale;
  - OTP and lease times were wrong by one hour.

  Fixed by running every service's database sessions in UTC. A regression assertion was added.

- **Harness races.** Concurrent requests against an unstarted test server raced. Fixed in the harness.

## What is not yet verified, and why

| Item                                                                     | Status                                                                                                                                                                                     | Reason or next step                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker Compose stack, service Dockerfile, container scan                 | Written, **not run**                                                                                                                                                                       | Virtualization is disabled on the build host: WSL2 reports `HCS_E_HYPERV_NOT_INSTALLED`. Enable virtualization, then run `pnpm infra:up` and `pnpm stack:up`.                                                                                                                                                              |
| RabbitMQ adapter (`RabbitMqBroker`)                                      | Written, **not run against a broker**                                                                                                                                                      | Needs Docker. Cross-service events were verified through the same broker port using the in-memory implementation.                                                                                                                                                                                                          |
| Client screens (Expo Router)                                             | Type-checked (0 errors). **Production web export succeeds** (Metro, 964 modules). It renders in a browser: the entry gate routes to sign-in, and API failure shows a plain-language error. | Dependencies were aligned to Expo SDK 57 with `expo install --check` ("Dependencies are up to date"). Native builds (EAS), React Native Testing Library, and Playwright tests are not done yet. Two transitive peer warnings remain (`@react-native/metro-config`, `react-native-worklets`); they did not affect bundling. |
| CI workflow                                                              | Written, **not run**                                                                                                                                                                       | No git remote. Actions are pinned to version tags; pin to commit SHAs before production.                                                                                                                                                                                                                                   |
| Consumer-driven contract tests (Pact)                                    | **Not implemented**                                                                                                                                                                        | Shared zod contracts plus the composed journey cover Phase 1. Add Pact before services are deployed independently.                                                                                                                                                                                                         |
| Downstream fencing-token store (`lease_fences`)                          | **Not implemented**                                                                                                                                                                        | No service other than administration-service performs privileged writes until Phase 2.                                                                                                                                                                                                                                     |
| Redis-backed rate limits; OpenTelemetry SDK install                      | **Deferred**                                                                                                                                                                               | Rate limits use an in-memory store per instance. Tracing is wired and starts when the SDK is installed and `OTEL_EXPORTER_OTLP_ENDPOINT` is set.                                                                                                                                                                           |
| Terraform; backup/restore, support, and pilot runbooks                   | **Deferred to Phase 6**                                                                                                                                                                    | The intended module layout is in `infrastructure/terraform/README.md`.                                                                                                                                                                                                                                                     |
| Support-access grant workflow, managed OIDC, passkeys, invitation resend | **Deferred**                                                                                                                                                                               | Tables and ADR directions exist.                                                                                                                                                                                                                                                                                           |

## Known design limits

These are documented and accepted for Phase 1:

- The lease sweeper closes expired rows in SQL without emitting lease events. Realtime clients learn of expiry through 30-second revalidation, and every command already rechecks expiry.
- Platform provisioning entries live in the platform journal. The school's journal starts at its first administrator's invitation acceptance.
- Non-privileged reads in services other than identity rely on the 5-minute access-token lifetime to take effect after session revocation.

## Owner decisions still needed

- Takeover and forced-revocation authority.
- Lease timings after the pilot.
- Deployment country and legal review.
- Identity provider.
- SMS, WhatsApp, email, and tile providers.
- Broker hosting.
- Retention periods.

These are listed in `Aegis_Project_Context.md` under "Decisions still requiring owner input".
