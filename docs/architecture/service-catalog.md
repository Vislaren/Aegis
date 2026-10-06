# Service catalog

Source of truth for service boundaries. Decision record: `docs/decisions/ADR-0001-microservice-architecture.md`.

## Services

| Service                  | Phase | Owns (system of record)                                                                                                                                                                                                                                                    | Public API (via gateway)                                                                                                                                                 | Depends on (sync)                                                            | Publishes                                                                                                                                                                     | Consumes                                                                             |
| ------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `api-gateway`            | 0     | Nothing                                                                                                                                                                                                                                                                    | Routes `/api/v1/*` to services                                                                                                                                           | identity JWKS                                                                | none                                                                                                                                                                          | none                                                                                 |
| `identity-service`       | 1     | User, OtpChallenge, UserSession, RefreshToken, AuthFactor (MFA), TrustedDevice, ConsentRecord, Invitation (delivery, redemption)                                                                                                                                           | `/auth/*`, `/me`, `/me/sessions`, `/me/consents`, `/me/security-events`                                                                                                  | `administration-service` (actor context for `/me` role summary)              | `identity.user.provisioned`, `identity.invitation.accepted`, `identity.session.revoked`, `identity.mfa.verified`, `audit.security_event.recorded`                             | `administration.invitation.requested`, `administration.operator.suspended`           |
| `administration-service` | 1     | School, SchoolSettings, PlatformAdministrationWorkspace, SchoolAdministrationWorkspace, PlatformAdminOperatorProfile, SchoolAdminOperatorProfile, SchoolMembership, Role, RoleAssignment, FeatureFlag, PrivilegedAccessLease, PrivilegedSessionHistory, SupportAccessGrant | `/platform/*`, `/schools/{id}/admin-operators`, `/schools/{id}/user-invitations`, `/schools/{id}/memberships`, `/privileged-access/*`, `/administration/session-history` | `identity-service` (user provisioning, session introspection)                | `administration.school.*`, `administration.membership.*`, `administration.operator.*`, `administration.lease.*`, `administration.invitation.requested`, `audit.journal.entry` | `identity.invitation.accepted`, `identity.session.revoked`                           |
| `audit-service`          | 1     | AuditEvent, AdministrativeActivityJournal (hash chained)                                                                                                                                                                                                                   | `/administration/activity-journal`, `/me/security-events` (read side)                                                                                                    | `administration-service` (lease validation for journal search)               | none                                                                                                                                                                          | `audit.journal.entry`, `audit.security_event.recorded`                               |
| `realtime-gateway`       | 1 / 4 | Nothing (connection state only)                                                                                                                                                                                                                                            | Socket.IO at `/realtime`                                                                                                                                                 | `administration-service` (lease validation), owning services for room checks | none                                                                                                                                                                          | `administration.lease.*`, `identity.session.revoked`; later trip and tracking events |
| `school-setup-service`   | 2     | Student, GuardianProfile, StudentGuardian, DriverProfile, Bus, Route, Stop, RouteStop, StudentStop, Schedule                                                                                                                                                               | `/schools/{id}/students`, `.../guardians`, `.../buses`, `.../routes`, `.../schedules`                                                                                    | `administration-service` (lease validation)                                  | `school_setup.*`                                                                                                                                                              | `administration.membership.*`                                                        |
| `trip-service`           | 3     | Trip, TripAssignment, TripStudent, TransportEvent, Incident, AbsenceDeclaration                                                                                                                                                                                            | `/trips/*`, `/students/{id}/absence-declarations`, `/guardian/children/{id}/active-trip`                                                                                 | none on the driver hot path                                                  | `trip.*`                                                                                                                                                                      | `school_setup.*` (local manifest read model)                                         |
| `tracking-service`       | 4     | PositionPoint, LatestPosition (Redis), stale and geofence state                                                                                                                                                                                                            | `/trips/{id}/positions/batch`                                                                                                                                            | none on the hot path                                                         | `tracking.position.accepted`, `tracking.bus.stale`, `tracking.stop.approaching`                                                                                               | `trip.started`, `trip.completed`                                                     |
| `notification-service`   | 5     | Notification, NotificationAttempt, templates                                                                                                                                                                                                                               | `/me/notification-preferences`                                                                                                                                           | `school-setup-service` (send-time recipient and restriction check)           | `notification.*`                                                                                                                                                              | `trip.*`, `tracking.*`                                                               |

Every service database also has `outbox_messages` and `inbox_messages` tables.

## Phase 1 key flows

### School provisioning saga

The saga runs from `administration-service` with the platform lease held.

1. A platform operator calls `POST /api/v1/platform/schools` with an `Idempotency-Key`.
2. `administration-service` validates the platform lease, then calls `identity-service` `POST /internal/v1/users:provision` with the first administrator's name and contact. This call is idempotent by contact and returns the `userId`.
3. In one transaction, `administration-service` creates:
   - the school and its settings;
   - the school workspace;
   - the operator profile (status `INVITED`);
   - the membership and the role assignment `SCHOOL_ADMIN`;
   - the outbox events `administration.school.provisioned.v1`, `administration.invitation.requested.v1`, and `audit.journal.entry.v1` (×3).
4. `identity-service` consumes `invitation.requested`, creates the single-use invitation, and delivers it.
5. On acceptance, `identity-service` publishes `identity.invitation.accepted.v1`. `administration-service` then activates the profile and membership, and journals the activation.

If step 2 succeeds but step 3 fails, the provisioned user stays `INVITED`, with no memberships and no authority. A worker deactivates orphaned users after the invitation TTL.

### Privileged command in a service other than administration

1. The service verifies the access token (JWKS).
2. It calls `administration-service` `POST /internal/v1/privileged-access/validate` with the session, the workspace, and the expected school. The response contains the operator, the grant, and the fencing token.
3. In one local transaction, the service:
   - checks the fencing token against its `lease_fences` row (`SELECT … FOR UPDATE`);
   - applies the mutation;
   - writes `audit.journal.entry.v1` to its outbox.
4. If `administration-service` is unreachable, the command is denied.

## Event envelope (`packages/contracts`)

```json
{
  "eventId": "uuid",
  "type": "administration.lease.revoked",
  "version": 1,
  "occurredAt": "ISO-8601 UTC",
  "producer": "administration-service",
  "schoolId": "uuid | null",
  "correlationId": "uuid",
  "traceparent": "W3C trace context",
  "payload": {}
}
```

Ordering key: the aggregate ID (for example, the workspace ID for lease events). Consumers tolerate redelivery and deduplicate by `eventId`.
