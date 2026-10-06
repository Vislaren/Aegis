# Data inventory (Phase 1)

Every personal field is listed with its purpose. Retention periods are proposed defaults that need legal review in the deployment jurisdiction before production.

| Service        | Data                       | Fields                                                                 | Purpose                                       | Proposed retention                         | Notes                                                                            |
| -------------- | -------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| identity       | Identity                   | display name, email, E.164 phone, verification times, status, language | Sign-in and contact for invitations and codes | While the account is active plus 12 months | Contacts are never sent to other services; administration stores masked contacts |
| identity       | OTP challenges             | destination HMAC, code HMAC, attempts, IP                              | Sign-in security and throttling               | 30 days                                    | No raw codes are stored                                                          |
| identity       | Sessions and devices       | device-ID HMAC, platform, device name, user agent, IP, times           | Session management and revocation             | 90 days after end                          | Users see and revoke their own                                                   |
| identity       | MFA factors                | encrypted TOTP secret                                                  | Operator authentication                       | Until revoked                              | AES-256-GCM                                                                      |
| identity       | Consents                   | document type and version, time, IP, user agent                        | Evidence of acknowledgement                   | Account life plus legal period             | Append-only                                                                      |
| identity       | Invitations                | token hash, school ID and name, role, status                           | Invitation-only onboarding                    | 12 months                                  | Token is in the URL fragment, which is never logged                              |
| administration | Tenants and workspaces     | school name, slug, timezone, country, settings                         | Tenant configuration                          | Contract life                              |                                                                                  |
| administration | Operators and memberships  | user ID, display name, masked contact, status, reasons                 | Authorization and attribution                 | Contract life plus 12 months               |                                                                                  |
| administration | Privileged session history | user, profile, session, grant, IP, user agent, times, outcome          | Accountability                                | 24 months (proposed)                       | Append-only except closing a row                                                 |
| audit          | Activity journal           | actor IDs, action, target, redacted before and after, IP, user agent   | Tamper-evident accountability                 | 24 months minimum (proposed)               | Hash-chained; never edited                                                       |
| audit          | Security events            | user, session, event type, outcome, IP, user agent                     | Security monitoring                           | 12 months                                  |                                                                                  |

Child, guardian-relationship, and location data arrive in Phases 2 to 4 and must be added here first.

## Subprocessors and providers (to be confirmed)

| Purpose           | Provider                           |
| ----------------- | ---------------------------------- |
| Cloud hosting     | TBD                                |
| Email             | TBD                                |
| SMS / WhatsApp    | TBD                                |
| Push              | Firebase Cloud Messaging (planned) |
| Map tiles         | TBD                                |
| Error tracking    | TBD                                |
| Uptime monitoring | TBD                                |

None is contracted yet. Locally, only Mailpit is used.
