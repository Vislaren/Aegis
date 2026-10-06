# ADR-0007: Authorization policy and PostgreSQL row-level security

- **Status:** Accepted (2026-10-06)

## Decision

- **Central, deny-by-default policy.** `authorize(actor, action, resource)` in `packages/domain` is pure and needs no framework. The actor context is loaded server-side: the session (AAL, status) comes from identity-service, and operator profiles, memberships, roles, school status, and the validated lease come from administration-service's database.
- **Object-level denials look like absence.** Denials that concern another tenant or object map to `404 NOT_FOUND`. Function-level denials map to `403`. Problem details never include the policy's reasoning.
- **Allowlisted request contracts.** Request bodies use strict zod objects: unknown keys such as `schoolId` or `role` are rejected (mass-assignment protection). Responses are parsed through declared schemas, so undeclared fields never leave the service.
- **Row-level security as defense in depth.**
  - Each service connects as `<service>_app`. That role is not the owner, has no BYPASSRLS, and has no DELETE on safety or audit tables.
  - Every transaction first sets `aegis.context`, `aegis.school_id`, and `aegis.user_id` with `set_config(..., true)`.
  - School-owned tables match `school_id`. Users see their own memberships. Only the `platform` context may create schools or the platform role.
- **Database constraints.**
  - Composite foreign keys tie roles to scopes, so a platform role can never be bound to a school.
  - A school workspace's profiles must belong to that school.
  - Active lease rows must be complete.
- **Narrow privileged paths.** Two `SECURITY DEFINER` functions exist: the lease sweeper and the journal chain trigger and verifier. There is no general tenant bypass.

## Consequences

- Policy logic is unit-tested exhaustively and is not duplicated in clients.
- Every write passes through both the application policy and RLS.
