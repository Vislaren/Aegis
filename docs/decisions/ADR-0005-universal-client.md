# ADR-0005: One universal Expo client

- **Status:** Accepted (2026-10-06)

## Decision

- **One app for all roles.** Android, iOS, and web share one Expo Router app (`apps/client`) with one sign-in entry point. After authentication, the client asks `GET /api/v1/access/contexts` for the role contexts and builds the matching navigation shell: platform console, school console, driver, or guardian. This drives navigation only; every action is authorized by the server.
- **Shared code.** The design system is in `packages/ui`, and the contracts are in `packages/contracts`. Pure client logic (routing, API client, lease keeper, capability checks) lives in `apps/client/src/core` and is unit-tested without React Native.
- **Credentials.**
  - Web sessions use HttpOnly cookies, with CSRF double-submit through the gateway.
  - Native refresh tokens are stored in SecureStore (OS keystore), and access tokens are kept in memory only.
  - Tokens never go to AsyncStorage or logs.
- **Driver background location.** It needs a development or production native build. Web and Expo Go show an explicit unsupported-capability message, and trips cannot start there (Phase 3).
- **Package layout.** The workspace uses pnpm's default isolated layout, which Expo SDK 54+ supports. Fall back to targeted `public-hoist-pattern` entries only if a native module fails to resolve. The hoisted layout was abandoned because it downloaded native binaries for every platform.

## Consequences

One codebase and one API keep authorization consistent. Platform-specific behavior, such as background location, stays behind explicit capability checks.
