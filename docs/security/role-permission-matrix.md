# Role and permission matrix (current implementation)

The source of truth is `packages/domain/src/authorization/policy.ts` and `roles.ts`. "Lease" means a validated privileged lease on that exact workspace. "AAL2" means the session has completed MFA.

## Administrative actions (Phase 1, implemented)

| Action (`authorize` key)                                        | Platform operator                               | School administrator                                                           | Driver | Guardian |
| --------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ | ------ | -------- |
| `privileged.acquire.platform`                                   | AAL2                                            | 403                                                                            | 403    | 403      |
| `privileged.acquire.school`                                     | 404                                             | Own school, AAL2                                                               | 404    | 404      |
| `platform.school.provision` / `list` / `suspend` / `reactivate` | Lease + AAL2                                    | 403                                                                            | 403    | 403      |
| `platform.school_lease.revoke`                                  | Lease + AAL2 + MFA within 300 s + reason        | 403                                                                            | 403    | 403      |
| `platform.operator.create` / `list` / `suspend` / `reactivate`  | Lease + AAL2                                    | 403                                                                            | 403    | 403      |
| `platform.journal.read` / `session_history.read`                | Platform workspace only                         | 403                                                                            | 403    | 403      |
| `school.operator.create` / `list` / `suspend` / `reactivate`    | 404                                             | Own school + lease                                                             | 404    | 404      |
| `school.user.invite`                                            | 404                                             | Own school + lease; roles DRIVER, GUARDIAN, and flag-enabled future roles only | 404    | 404      |
| `school.membership.list` / `suspend` / `reactivate`             | 404                                             | Own school + lease                                                             | 404    | 404      |
| `school.journal.read` / `session_history.read`                  | 404                                             | Own school workspace only                                                      | 404    | 404      |
| Emergency takeover (same workspace)                             | Lease holder's peer + MFA within 300 s + reason | Same                                                                           | n/a    | n/a      |

## Common capabilities (every authenticated role, own data only)

`GET`/`PATCH /me`, own sessions (list and revoke your own; another user's session returns 404), consents, own security events, logout, and current policy versions.

## Structural rules enforced in the database

| Rule                                                         | Mechanism                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| The platform role is never school-bound                      | `role_assignments` composite FK `(role_key, role_scope)` and CHECK `(role_scope='PLATFORM') = (school_id IS NULL)` |
| A school context cannot write the platform role              | RLS `role_assignments_insert`                                                                                      |
| Exactly one workspace per school, and one platform workspace | `UNIQUE (school_id)`; singleton CHECK                                                                              |
| Only the platform context creates schools                    | RLS `schools_platform_insert`                                                                                      |
| One lease row per workspace; fencing tokens never decrease   | `UNIQUE (workspace_type, workspace_id)`; trigger                                                                   |

## Rules for operators

- An operator cannot suspend themselves.
- The last active operator of a workspace cannot be suspended.
- Suspending an operator ends their lease.
- Reactivating an operator who never accepted their invitation returns them to `INVITED`.

## Future roles

`TRANSPORT_MANAGER`, `DISPATCHER`, and `BUS_ATTENDANT` exist in the role catalog. They can be invited only when the school feature flag `role.<name>` is enabled, and they have no capabilities until their phase adds policy entries.

## Driver and guardian capabilities

The driver and guardian columns follow `Aegis_Project_Context.md`. They are implemented in Phases 3 to 5 and will be added here as they land.
