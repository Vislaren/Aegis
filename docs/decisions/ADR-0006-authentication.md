# ADR-0006: Authentication (passwordless, invitation-only, MFA for operators)

- **Status:** Accepted for local, test, and pilot use; a managed OIDC adapter is to be decided before production (owner input).

## Decision

- **No passwords, no self-registration.**
  - Identities are created only by administration workflows, through `POST /internal/v1/users/provision`.
  - A new identity stays `INVITED` until its single-use invitation is redeemed. Redeeming needs the URL-fragment token plus a one-time code sent to the invited contact.
- **One-time codes.**
  - Codes are 6 digits, expire after 300 s, and allow at most 5 attempts.
  - They are stored as HMAC-SHA-256 hashes with a server pepper.
  - Each destination may receive at most 5 codes per 15 minutes. Per-IP limits apply at the gateway and in identity-service.
  - Unknown, invited, or suspended identifiers get the same response, but nothing is delivered and the challenge can never verify. Delivery is asynchronous, so response timing is the same too.
- **Sessions.**
  - Sessions are server-side records.
  - Access tokens are ES256 JWTs (`sub`, `sid`, `aal`) that live 300 s. The JWKS is published internally for the other services.
  - Refresh tokens rotate on every use. Reusing a rotated token revokes the whole session (`REFRESH_REUSE`).
  - Absolute session lifetime is 30 days, or 12 hours for identities that require MFA.
  - identity-service checks session status on every request. Other services introspect it synchronously for privileged actions.
- **MFA.**
  - TOTP (RFC 6238, through `otplib`) is required for administration operators. The `requires_mfa` flag is set when an operator invitation is issued.
  - TOTP secrets are encrypted with AES-256-GCM.
  - Replay is blocked by recording the last used time step.
  - After 5 consecutive failures the session is revoked.
  - Verifying MFA raises the session to AAL2, records `mfa_verified_at` (the proof of freshness for takeover and forced revocation), and rotates the tokens.
- **Web and native clients.** Web clients receive HttpOnly `aegis_at` and `aegis_rt` cookies plus an `aegis_csrf` double-submit cookie. Native clients receive tokens in the response body.

## Open items

- A managed OIDC provider (Cognito, Auth0, or Zitadel) behind the same session model.
- Passkeys for operators.
- Production SMS and WhatsApp providers.
- A resend-invitation workflow.
