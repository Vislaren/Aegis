# ADR-0004: Service-to-service authentication

- **Status:** Accepted (2026-10-06)
- **Context:** Internal APIs (`/internal/v1`) expose sensitive capabilities: identity provisioning, session introspection, and lease validation. Network isolation alone is not enough.

## Decision

- **Signed service tokens.** Each service has its own ES256 key pair. Callers sign short-lived JWTs: `iss` = caller service, `aud` = callee service, 60-second lifetime, unique `jti`. The token is sent in `x-service-token`.
- **Per-endpoint allowlists.** Callees trust an explicit map of caller public keys (`TRUSTED_SERVICE_KEYS`). Each endpoint declares which callers it accepts (`@InternalRoute('audit-service', ...)`). End-user tokens are never accepted on internal routes, and service tokens never authorize public routes.
- **Gateway isolation.** The gateway never routes `/internal/*` and strips any `x-service-token` sent by callers.
- **Deployment.** Private keys live in the secret store, one per service. In ECS, Service Connect provides discovery, and security groups allow only the declared call paths. mTLS through a service mesh may be added later without changing application code.

## Consequences

- Compromising one service does not let it impersonate another service to a third.
- Key rotation needs a deployment step: publish the new public key to callees, then switch the signer. It is documented in `docs/operations/runbooks/key-rotation.md`.
