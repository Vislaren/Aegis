# Runbook: administration workspace access

## "Another operator is currently using this workspace"

This is expected behavior: only one operator session may hold a workspace.

1. The denied screen shows the holder's name and last activity. Contact that person through school channels.
2. If the holder has finished, they press **Leave administration** (release). Access is then available immediately.
3. If the holder's browser crashed, wait. The lease frees itself within the lease TTL (default 5 minutes) after heartbeats stop, or within the idle timeout (default 15 minutes) of inactivity.
4. Emergency takeover: an active operator of the same workspace can take over at any time. It needs:
   - multi-factor verification within the last 5 minutes;
   - a written reason of at least 10 characters.

   Everything is journaled. Use takeover only when the holder cannot be reached and the work cannot wait.

## A school's workspace is stuck and no school operator can act

A platform operator can revoke the school's lease. This needs the platform lease, fresh MFA, and a reason:

```text
POST /api/v1/platform/schools/{schoolId}/privileged-access/revoke   { "reason": "..." }
```

This ends the school's lease only. It gives the platform operator no access to the school's data. It is journaled in the platform journal with the school ID.

## A school operator was suspended while working

Suspension ends their lease immediately (`OPERATOR_SUSPENDED`). Their next command receives `PRIVILEGED_LEASE_REQUIRED`, and the realtime channel drops within the revalidation interval.

## Checks

| Question                    | Where to look                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Who holds a workspace now?  | The `privileged_access_leases` row for the workspace: status, operator display name, `last_activity_at`.                                               |
| Who accessed or was denied? | `GET /api/v1/administration/session-history` (needs that workspace's lease), or `privileged_session_history`.                                          |
| What did they do?           | `GET /api/v1/administration/activity-journal`. `chainVerified: false` is a security incident: follow `incident-response.md` and preserve the database. |
