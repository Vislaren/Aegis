# Threat model (Phase 0 and Phase 1 scope)

**Method:** STRIDE per trust boundary, plus abuse cases. **Baselines:** OWASP ASVS 5.0, MASVS, API Security Top 10 (2023), NIST SSDF.

**Review triggers:** any change to authentication, authorization, tenancy, the event model, location handling, or the service topology.

## Assets

- **Child and guardian identity and relationships.** Phase 2+, highest sensitivity.
- **Live and historical bus location.** Phase 4+.
- **Operator identities, sessions, and MFA secrets.**
- **Privileged leases and administrative authority.**
- **The administrative journal and security audit stream.** These are evidence.
- **Service signing keys, access-token signing keys, and peppers.**

## Trust boundaries

1. **Internet → ALB → api-gateway.** Untrusted clients.
2. **api-gateway → services.** Forwarded user requests. The gateway is not trusted to authorize.
3. **Service ↔ service internal APIs.** Mutually authenticated through service tokens.
4. **Services ↔ RabbitMQ.** Messages are validated and deduplicated on receipt.
5. **Services ↔ their own PostgreSQL databases.** The runtime role is restricted and RLS applies.
6. **Device ↔ platform keystore.** Native refresh tokens.

## Threats and mitigations

| #   | Threat (STRIDE)                                                                        | Mitigation                                                                                                                                                 | Evidence                                               |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| T1  | Shared or borrowed administrator credentials (Repudiation)                             | Workspaces have no login. Every operator is an individual identity with MFA. Every journal entry carries user, profile, session, grant, and fencing token. | Provisioning journal test (administration integration) |
| T2  | Two operators of one workspace acquire concurrently (Elevation)                        | Row lock on a single lease row; database clock; domain rules                                                                                               | Concurrent acquisition test; property test             |
| T3  | A crashed client locks a workspace forever (DoS)                                       | Heartbeat TTL and idle timeout computed on every use; expiry recovery                                                                                      | Expiry tests (unit and integration)                    |
| T4  | Replayed or forged heartbeat or release (Spoofing)                                     | Requires the bearer token for the owning session, plus `grantId` match; old grants rejected                                                                | `decideHeartbeat` replay test                          |
| T5  | Abusive takeover (Elevation, Repudiation)                                              | Same-workspace operator only; MFA within 300 s; reason of at least 10 characters; journaled with before and after                                          | Takeover integration test                              |
| T6  | Journal tampering or deletion (Tampering)                                              | No UPDATE or DELETE grants; triggers block UPDATE, DELETE, and TRUNCATE even for the owner; SHA-256 chain per workspace; verifier                          | audit-service integration tests                        |
| T7  | School admin creates a user in another tenant or assigns the platform role (Elevation) | Tenant comes from the path and is checked against the validated lease; strict body; role enum; RLS; database FK and CHECK                                  | Cross-tenant and injection tests                       |
| T8  | Cross-tenant reads through guessed IDs (Information disclosure)                        | Object denials return 404; RLS deny-by-default without context                                                                                             | RLS tests                                              |
| T9  | User enumeration through sign-in (Information disclosure)                              | Identical OTP-start responses, asynchronous delivery, per-destination and per-IP throttles                                                                 | Identity tests                                         |
| T10 | OTP brute force or replay (Spoofing)                                                   | 6 digits, 300 s, 5 attempts, peppered HMAC, single consume                                                                                                 | Identity tests                                         |
| T11 | Stolen refresh token (Spoofing)                                                        | Rotation with reuse detection that revokes the session; HttpOnly or keystore storage; absolute lifetime                                                    | Reuse test                                             |
| T12 | Revoked session keeps acting (Elevation)                                               | identity checks session status per request; privileged paths introspect synchronously; events end leases and sockets                                       | Logout and revocation tests                            |
| T13 | Internal API reached from the internet or by the wrong service (Elevation)             | Gateway blocks `/internal`; ES256 service tokens with an audience; per-endpoint caller allowlist                                                           | Gateway routing and internal API tests                 |
| T14 | CSRF against cookie sessions (Tampering)                                               | SameSite cookies; double-submit token checked at the gateway for every unsafe cookie request                                                               | Gateway CSRF tests                                     |
| T15 | Secrets or PII in logs, events, or the journal (Information disclosure)                | Central log redaction; journal field allowlist with contact masking; events carry IDs, not contacts                                                        | Redaction tests                                        |
| T16 | Lost event means a privileged change without a journal entry (Repudiation)             | Outbox in the same transaction as the change; publisher confirms; DEAD alerting; idempotent consumer                                                       | Outbox and inbox tests                                 |
| T17 | Broker or identity outage silently allows privileged actions (Elevation)               | Fail closed on introspection or validation failure; realtime revalidation drops subscriptions                                                              | Fail-closed test                                       |
| T18 | Denial of service through OTP or API floods                                            | Gateway and identity rate limits; body limits (64 KiB); bounded pages                                                                                      | Configuration; rate-limit settings                     |
| T19 | Stale lease holder's delayed command in another service (Elevation)                    | Fencing tokens, rejected below the maximum seen (Phase 2 services)                                                                                         | Planned with school-setup-service                      |
| T20 | Malicious or compromised dependency (Tampering)                                        | Lockfile pinning, exact versions, `onlyBuiltDependencies` allowlist, audit and scanning in CI                                                              | CI                                                     |

## Abuse cases

- **AC1:** A former school administrator uses an old token after suspension. Blocked: the actor loader sees `SUSPENDED`, heartbeat ends the lease, and commands are denied.
- **AC2:** An operator of School A opens School B's console by editing the URL. The result is 404, recorded as `AUTHORIZATION_DENIED` in the security stream only, never in School B's journal.
- **AC3:** A platform operator tries to read school memberships. The result is 404, because the platform has no routine school access. Support access needs a future time-limited grant.
- **AC4:** An attacker replays the same invitation link. The result is `INVITATION_INVALID`.
- **AC5:** Two tabs of the same browser session. The lease is reused, with no denial.
- **AC6:** The same person signs in on a second device. That session is denied with `ADMIN_WORKSPACE_IN_USE` until takeover or release.

## Residual risks

These are tracked in `docs/plans/phase-0-1-status.md`.

- Rate limits use an in-memory store per instance until Redis-backed limits are configured.
- No managed OIDC provider yet, and passkeys are deferred.
- Non-privileged reads in services other than identity rely on access-token lifetime (5 min) for revocation.
- Platform forced revocation and same-workspace takeover authority still need owner sign-off.
