# Runbook: incident response (initial version)

This version covers the Phase 1 scope. Trip, location, and notification incidents are added in Phases 3 to 5. The backup/restore, support, and pilot runbooks are planned for Phase 6.

## Severity

| Severity | Examples                                                                                                                                                       | Response                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| SEV1     | Suspected cross-tenant data exposure. Journal chain verification failure. Compromised signing key. Privileged access granted to two sessions of one workspace. | Immediate. Page the on-call engineer and the security owner. |
| SEV2     | Administration unavailable. Outbox `DEAD` rows. Broker down for more than 10 minutes.                                                                          | Within 1 hour.                                               |
| SEV3     | Degraded latency. A single failed delivery.                                                                                                                    | Next business day.                                           |

## First steps (SEV1)

1. **Contain.**
   - Revoke the affected sessions.
   - Force-revoke the affected leases.
   - Rotate the affected keys (see [key rotation](key-rotation.md)).
   - If needed, scale the affected service to zero.
2. **Preserve evidence.** Snapshot the databases before any repair. Never edit journal or history rows.
3. **Assess scope.** Use the correlation IDs, the journal, and `privileged_session_history`.
4. **Notify.** Inform the school champion and the data controller as the breach-notification policy requires. The deployment-jurisdiction rules are still subject to legal review.
5. **Recover.** Hold a post-incident review with an owner and a due date for each action.

## Useful checks

| Check                | How                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Journal chain intact | `SELECT aegis_verify_journal_chain('<TYPE>:<workspace id>');` in `aegis_audit` returns `NULL` when intact.             |
| Outbox health        | Count `outbox_messages` rows with `status = 'PENDING'`, and find the oldest `created_at`. Investigate any `DEAD` rows. |
