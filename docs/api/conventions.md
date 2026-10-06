# API conventions

## Routes

- **Public routes** are under `/api/v1`, served only through `api-gateway`. The aggregated OpenAPI document is at `/api/v1/openapi.json` outside production, and `pnpm openapi:export` writes it to `docs/api/openapi.json`.
- **Internal routes** are under `/internal/v1`. They require a service token and are never routed publicly.
- **State transitions** are explicit commands, for example `/privileged-access/acquire` and `/platform/schools/{id}/suspend`.

## Formats

- Timestamps are UTC ISO 8601. Identifiers are UUIDs. Identifiers are never authorization.
- Pagination uses `?limit` (default 25, maximum 100) and an opaque `?cursor`. Responses return `{ items, nextCursor }`.

## Validation

- Request bodies are strict: unknown fields are rejected with `400 VALIDATION_FAILED`.
- Responses are validated against their contracts before they are sent.

## Idempotency

The `Idempotency-Key` header is required for school provisioning and user invitations. It must be 16 to 128 characters from `[A-Za-z0-9_-]`. A retry with the same key and body returns the original result with `idempotent-replayed: true`. The same key with a different body returns `422 IDEMPOTENCY_KEY_REUSED`.

## Correlation

`x-correlation-id` is accepted, propagated to every service and event, and echoed in responses and problem details.

## Errors

Errors use RFC 9457 `application/problem+json`:

```json
{
  "type": "https://docs.aegis.invalid/problems/admin-workspace-in-use",
  "title": "...",
  "status": 409,
  "code": "ADMIN_WORKSPACE_IN_USE",
  "correlationId": "…",
  "occupancy": { "operatorDisplayName": "…", "acquiredAt": "…", "lastActivityAt": "…" }
}
```

Error codes are listed in `packages/contracts/src/common.ts` (`ERROR_CODES`). Responses never include stack traces, SQL, policy reasoning, or whether another tenant's object exists.

## Authentication

- **Native clients** send `Authorization: Bearer <access token>`.
- **Web clients** rely on HttpOnly cookies. They must send `x-csrf-token` with the value of the `aegis_csrf` cookie on every unsafe method.
