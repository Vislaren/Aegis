# ADR-0003: Privileged access leases and fencing tokens

- **Status:** Accepted (2026-10-06)
- **Context:** Each administration workspace allows only one independently authenticated operator session at a time. This applies to the global platform workspace and to each school's workspace. The rule must survive concurrency, crashes, restarts, and the service boundaries introduced by ADR-0001.

## Decision

- **One lock row per workspace.** `administration-service` owns `privileged_access_leases`, with one row per workspace (`UNIQUE (workspace_type, workspace_id)`). The platform row is created by migration; each school's row is created at provisioning.
- **Atomic acquisition.** Acquisition, heartbeat, release, takeover, revocation, and every privileged command lock that row with `SELECT … FOR UPDATE`. They read `clock_timestamp()` after the lock is granted and apply the pure rules in `packages/domain/src/privileged-access/lease-policy.ts`. The decisions are:
  - **Same session:** reuse. This covers reconnecting and opening another tab.
  - **Another live session:** `409 ADMIN_WORKSPACE_IN_USE`, disclosing only the holder's display name, acquired time, and last-activity time.
  - **Expired lease:** recover it, and close the stale grant as `HEARTBEAT_EXPIRED` or `IDLE_TIMEOUT`.
- **Two independent timeouts.** Heartbeats extend `expires_at` (TTL 300 s). Operator activity, meaning privileged commands or heartbeats with `userActive`, extends `idle_expires_at` (900 s). A crashed browser therefore frees the workspace within the TTL, and an unattended tab frees it within the idle timeout. Correctness never depends on the sweeper.
- **Commands hold the lock.** A privileged command validates and touches the lease inside its own transaction while holding the row lock. A takeover waits for any in-flight command, so a command never commits after its lease was taken over.
- **Fencing tokens.** Each new grant increments `fencing_token`, and a trigger forbids it from ever decreasing. Services other than administration validate through `POST /internal/v1/privileged-access/validate` on every privileged command and fail closed. They keep a `lease_fences(workspace, max_token)` row (Phase 2+) and reject lower tokens.
- **Takeover and forced revocation.** Both need a reason of at least 10 characters and MFA verified within 300 s.
  - Takeover is allowed to an active operator of the same workspace.
  - Forced revocation is allowed to a platform operator. It touches only the school's lease row and history; it does not grant access to the school.
- **Context switching.** One session exercises one workspace at a time. Acquiring a second workspace releases the first (`CONTEXT_SWITCH`).
- **Lease ends.** Logout, session revocation, operator suspension, and school suspension end leases. Each lifecycle step writes `privileged_session_history`, which can only close a row once. Each step is also journaled and published as `administration.lease.changed`.

## Consequences

- Privileged commands on one workspace are serialized. This is acceptable because only one operator holds the workspace.
- A downstream service still has a residual window. A takeover can occur between its validation call and its commit. Fencing bounds this to that service's in-flight command, which is journaled with its grant and token.
- The timing defaults need pilot validation, and so does the takeover authority. The owner decision is still open; see `Aegis_Project_Context.md`, "Decisions still requiring owner input".
