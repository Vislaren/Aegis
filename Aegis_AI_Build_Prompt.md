# Aegis Production MVP Build Prompt

## How to use this prompt

Give this entire file to the AI coding assistant that will build Aegis. Keep `Aegis_Project_Context.md` in the repository root and instruct the assistant to read it before every substantial implementation phase.

Replace bracketed deployment variables when the information is available. If a variable is unknown, the assistant must implement a provider-neutral adapter, choose a safe local-development default, record the decision, and continue without weakening security.

## Your role

Act as the lead product engineer, security engineer, mobile engineer, backend engineer, QA engineer, and DevOps engineer for Aegis. Build a production-oriented MVP that can be piloted by a real school. Do not produce only mockups, pseudocode, or disconnected screens. Implement complete vertical workflows with migrations, authorization, validation, error handling, tests, observability, and deployment documentation.

Treat this prompt and `Aegis_Project_Context.md` as the product requirements. If an existing repository conflicts with them, preserve working code where safe, document the conflict, and make the smallest coherent change that satisfies the requirements. Never weaken tenant isolation, child privacy, auditability, or trip-safety invariants to save time.

## Project variables

- Product name: `Aegis`
- Initial deployment country: `[TARGET_COUNTRY]`
- Default timezone: `[SCHOOL_TIMEZONE]`
- Default language: `[DEFAULT_LANGUAGE]`
- Additional languages: `[SUPPORTED_LANGUAGES]`
- Primary cloud region: `[DATA_REGION]`
- SMS provider: `[SMS_PROVIDER]`
- WhatsApp provider: `[WHATSAPP_PROVIDER]`
- Email provider: `[EMAIL_PROVIDER]`
- Push provider: Firebase Cloud Messaging through a provider adapter
- Map tile provider: `[MAP_TILE_PROVIDER]`; never depend on public OpenStreetMap tiles for production traffic
- Object storage: `[S3_COMPATIBLE_PROVIDER]`
- Error tracking: `[ERROR_TRACKING_PROVIDER]`
- Uptime monitoring: `[UPTIME_PROVIDER]`

## Product objective

Build a school-transport safety platform that makes each active trip visible and accountable. The MVP must let a school know which children are assigned, onboard, absent, arrived, or dropped off; let a driver operate a trip with unreliable connectivity; and let a guardian see only their own child's relevant transport status and assigned active bus.

The first proof target is one school, one bus, approximately twenty students, and one real morning trip completed from first stop to school. The product must also support the equivalent afternoon drop-off flow.

Aegis supplements human supervision. It never replaces a driver, attendant, school safety procedure, printed manifest, or emergency service.

## Mandatory architecture

### One client application

Build one universal client application with:

- one application identity and deployment pipeline;
- one sign-in entry point;
- one shared component and design system;
- role-aware navigation and dashboards;
- responsive web layouts for school administration and guardian access;
- native Android and iOS capability for the driver workflow;
- a shared API and shared domain contracts.

Use a universal Expo and React Native application with React Native Web and Expo Router. A user's authenticated school membership and role determine the navigation tree and allowed actions. Do not create separate parent, driver, and school-admin products for the MVP.

Background driver location is a native capability. It must use a development or production build, not Expo Go. If the app is opened on a platform that cannot provide required driver background-location guarantees, show an explicit unsupported-capability message and do not allow a trip to start.

### Backend: microservice architecture

The backend is a set of independently deployable microservices, organized by bounded context, in one monorepo. Each service has its own process, container image, deployment pipeline stage, database, migrations, and background workers. Services never read or write another service's database; they communicate only through versioned APIs and versioned events.

Service catalog:

| Service | Owns (system of record) | First phase |
|---|---|---|
| `api-gateway` | No business data. Public edge for `/api/v1`: routing, TLS termination behind the load balancer, request-size limits, rate limits, CORS, CSRF, correlation IDs, and coarse access-token verification. | 0 |
| `identity-service` | `User`, `OtpChallenge`, `UserSession`, refresh tokens, MFA factors, `TrustedDevice`, `ConsentRecord`, `Invitation` delivery and redemption. Issues signed access tokens and publishes the JWKS. | 1 |
| `administration-service` | `School` tenant registry, `SchoolSettings`, `PlatformAdministrationWorkspace`, `SchoolAdministrationWorkspace`, operator profiles, `SchoolMembership`, `Role`, `RoleAssignment`, `FeatureFlag`, `PrivilegedAccessLease`, `PrivilegedSessionHistory`, `SupportAccessGrant`. Authoritative for authorization context and privileged leases. | 1 |
| `audit-service` | `AuditEvent` and the append-only, hash-chained `AdministrativeActivityJournal`. Provides scoped journal search. | 1 |
| `school-setup-service` | `Student`, `GuardianProfile`, `StudentGuardian`, `DriverProfile`, `Bus`, `Route`, `Stop`, `RouteStop`, `StudentStop`, `Schedule`. | 2 |
| `trip-service` | `Trip`, `TripAssignment`, `TripStudent`, `TransportEvent`, `Incident`, absence declarations, offline sync ingestion, and projections. | 3 |
| `tracking-service` | `PositionPoint`, `LatestPosition` (Redis), PostGIS history, stale detection, geofence events. | 4 |
| `realtime-gateway` | No business data. Authenticated Socket.IO connections, room authorization by asking the owning services, and fan-out of broker events. | 1 (privileged lease channel), 4 (trips) |
| `notification-service` | `Notification`, `NotificationAttempt`, templates, provider adapters, send-time recipient resolution. | 5 |

Mandatory microservice rules:

- **Database per service.** For the pilot, one PostgreSQL/PostGIS cluster may host one logical database per service. Each service gets its own database roles, and no cross-database grants are allowed. Row-level security still applies inside every service that stores school-owned data.
- **Every service enforces authorization itself.** The gateway is not an authorization boundary. Every service verifies the end-user access token against the identity JWKS and evaluates policy for its own objects.
- **Internal calls are authenticated.** Synchronous service-to-service calls use internal APIs under `/internal/v1`. They are never routed by the public gateway, they are authenticated with short-lived service credentials, and they are restricted by network policy. mTLS through a service mesh may be added later.
- **Events go through the transactional outbox.** A service writes the state change and the event to its own database in one transaction, and a relay publishes the event to the message broker. Consumers are idempotent through an inbox table keyed by event ID. Events are versioned contracts in `packages/contracts`.
- **No synchronous call chains on the trip-critical path.** Drivers' event ingestion must not depend on more than the owning service and its database. Use local read models built from events wherever immediacy is not a security requirement.
- **Shared code is limited.** Only shared libraries for cross-cutting concerns (`contracts`, `domain`, `service-kit`, `config`, `observability`, `ui`) are allowed. Shared libraries must not hide database access to another service's data.
- **Each service owns its workers.** Background jobs and its outbox relay ship in the same image as the service, run with a separate command, and scale independently.

### Cross-service consistency for safety and administration invariants

Some invariants used to be single-transaction guarantees. They must stay correct across service boundaries:

- **Privileged leases.** `administration-service` is the only authority for acquiring, renewing, releasing, revoking, and taking over a lease, all done atomically in its PostgreSQL. Every lease grant carries a monotonically increasing **fencing token** per workspace. Any other service handling a privileged command:
  - validates the lease synchronously through `administration-service`, with no caching longer than a single request;
  - records the highest fencing token it has seen per workspace;
  - rejects commands whose token is lower than that highest token.

  A lease that cannot be validated means the command is denied (fail closed).
- **Administrative journal.** Every privileged mutation stages its journal record in the producing service's outbox, in the same transaction as the mutation. `audit-service` consumes these records idempotently and appends them to the hash chain. A privileged mutation can therefore never commit without a guaranteed journal record. Journal visibility is eventually consistent, and outbox lag is monitored and alerted.
- **Session revocation and restrictions.**
  - Session revocation and guardian restriction changes are published as high-priority events.
  - Privileged commands, realtime subscriptions, and notification recipient resolution re-check the owning service synchronously.
  - Non-privileged reads may rely on access tokens no older than 5 minutes plus an event-fed revocation denylist.
- **Cross-service workflows.** Workflows such as school provisioning and invitation acceptance run as explicit sagas, with idempotent steps, compensating actions, and journaled outcomes. Never use distributed two-phase commit.

### Security boundary

The UI is not a security boundary. Hiding a menu item is only a usability measure. The API gateway is not one either: it may reject obviously invalid traffic, but it never grants access. Every API request, internal service call, event consumer, realtime subscription, job, database query, file URL, and notification recipient must be authorized by the service that owns the data. Use deny by default.

## Technology baseline

Use current stable, mutually compatible versions and pin them in lockfiles.

- Monorepo: pnpm workspaces with Turborepo
- Language: TypeScript with strict mode and no unchecked `any`
- Client: Expo, React Native, React Native Web, Expo Router, TanStack Query, Zustand for small client-only state, React Hook Form, Zod, `expo-sqlite` with SQLCipher-enabled encrypted databases in production builds, `expo-secure-store`, `expo-location`, and `expo-task-manager`
- Services: NestJS using the Fastify adapter for every microservice, with a shared `service-kit` package for bootstrap, problem-details errors, correlation IDs, token verification, tenant-context transactions, outbox, and inbox. Public REST uses OpenAPI and Zod-backed request and response contracts.
- API gateway: a thin NestJS/Fastify edge service. A managed gateway such as AWS API Gateway or an ALB with WAF may sit in front of it. All routes are under `/api/v1`, and internal routes are never exposed.
- Messaging: RabbitMQ (Amazon MQ in production) with quorum queues, dead-letter exchanges, and publisher confirms, behind a broker port so NATS JetStream or SNS/SQS can replace it. Every service uses a transactional outbox and an idempotent inbox.
- Service-to-service: internal REST over the private network, with short-lived service tokens; mTLS through a service mesh is optional later. Inter-service contracts are versioned in `packages/contracts` and verified with consumer-driven contract tests.
- Database: PostgreSQL with PostGIS, with one logical database and separate roles per service. Migrations are mandatory and owned by each service.
- ORM/data access: Prisma for ordinary data access within each service, with explicit transaction boundaries. Use reviewed SQL migrations and narrowly scoped raw SQL for PostgreSQL row-level security, PostGIS, constraints, indexes, and privileged-access lease acquisition.
- Cache and queue: managed Redis or Valkey with BullMQ for in-service jobs and scheduling, using per-service key prefixes. PostgreSQL remains authoritative for permissions, events, and privileged-access leases. The message broker carries cross-service events.
- Realtime: a dedicated `realtime-gateway` service using Socket.IO with authenticated, school-scoped and trip-scoped rooms, and a Redis adapter when horizontally scaled. It authorizes rooms by asking the owning services and fans out broker events.
- Identity: a managed OpenID Connect provider such as Amazon Cognito, Auth0, or self-hosted Zitadel, fronted by `identity-service`. Application roles, school memberships, operator profiles, and authorization policy live in `administration-service`'s PostgreSQL database.
- Maps: MapLibre with a production tile provider
- Notifications: push plus adapter-based SMS and WhatsApp fallbacks
- Files: private S3-compatible object storage with short-lived signed URLs
- Observability: OpenTelemetry for traces and metrics, structured redacted logs, and Sentry or an equivalent error-tracking service
- Testing: Vitest or Jest, React Native Testing Library, Supertest, Pact or an equivalent for consumer-driven contract tests between services, and Playwright for web end-to-end tests through the gateway. Add native-device tests for driver-critical flows.
- Local infrastructure: Docker Compose for PostgreSQL/PostGIS (one database per service), Redis, RabbitMQ, mail capture, an S3-compatible development service, and every service container. A single command starts the whole system.
- Delivery: Docker with one image per service, Terraform, GitHub Actions with per-service affected builds through Turborepo, and Expo Application Services for signed mobile builds and store delivery.
- Recommended production target:
  - one AWS ECS Fargate service per microservice, using ECS Service Connect for private service discovery;
  - an Application Load Balancer and WAF in front of `api-gateway` and `realtime-gateway`;
  - RDS PostgreSQL with PostGIS, with one database per service on a shared instance for the pilot and separable later;
  - ElastiCache Redis or Valkey;
  - Amazon MQ for RabbitMQ;
  - S3 and CloudFront, Route 53 and ACM, and ECR;
  - Secrets Manager with KMS, using per-service secrets and IAM task roles;
  - CloudWatch.

  Keep infrastructure modules and provider adapters portable enough for a lower-cost pilot host, such as a single VM running Docker Compose or k3s with the same service images.
- CI/CD: lint, type-check, and unit tests; contract tests; per-service migration checks; dependency and secret scanning; container and mobile builds; staging deployment; cross-service smoke tests; and gated production promotion. Services deploy independently, with backward-compatible API and event versions.

If the existing repository already has a coherent equivalent stack, do not rewrite it solely to match a library preference. Preserve the architectural and security requirements.

## User types and authorization model

Implement four MVP authorization roles: Platform Administrator, School Administrator, Driver, and Guardian. Store school roles as school-scoped memberships; the platform role is global. Administrative workspaces may contain multiple named operator profiles, but this does not create shared identities or weaken role boundaries. Do not infer a role from the email domain, route, client platform, or UI state.

This administration model is additive. Preserve every existing school setup, trip, offline sync, tracking, incident, guardian, notification, reporting, and common-profile capability specified below; change only who may reach each capability and how privileged use is attributed and serialized.

### Administrative workspaces and named operators

Interpret the business terms `Super Admin account` and `school main administration account` as administrative workspaces, not as usernames or shared passwords:

- Create one global `PlatformAdministrationWorkspace` for the Aegis operator.
- Create exactly one `SchoolAdministrationWorkspace` for each school tenant.
- A workspace may contain several individually named, active or suspended operator profiles.
- Every operator has an individual `User` identity, verified contact, authentication factors, operator profile, status, and immutable identifier.
- Never share credentials, MFA factors, refresh tokens, or recovery methods between operators.
- Every request and journal event records the real operator identity as well as the administrative workspace and active role context.
- Display the active operator's name in the privileged UI so staff can verify which subprofile is in use.

The global workspace is the scope commonly called the super admin profile. A school's workspace is the scope commonly called its main administration account. The workspace owns the privilege; the named operator proves who is exercising it.

### Exclusive privileged access rule

Although a workspace can have multiple operator profiles, only one independently authenticated operator session may hold privileged access to that workspace at a time:

- enforce one active `PrivilegedAccessLease` for the global platform workspace;
- enforce one active `PrivilegedAccessLease` per school administration workspace;
- a school administrator in School A does not block an administrator in School B;
- driver and guardian sessions are not subject to this single-operator rule;
- the same browser session may reconnect or open another tab using the same lease, but a second device or independently authenticated session cannot acquire another lease;
- acquire, renew, and release the lease atomically in `administration-service`'s PostgreSQL database. Use a unique scope record plus a transaction, compare-and-swap version, or transaction-scoped advisory lock. Do not use Redis or the message broker as the source of truth for exclusivity;
- issue a monotonically increasing fencing token with every new grant. Every service that executes privileged commands rejects tokens lower than the highest it has seen for that workspace;
- use a short renewable lease heartbeat and a separate configurable idle timeout so a crashed browser cannot lock the workspace indefinitely;
- validate the current lease on every privileged API command and privileged realtime subscription, not only at login. Services other than `administration-service` validate synchronously through its internal lease-validation API and fail closed when it is unreachable;
- release or expire the lease on logout, timeout, revocation, operator suspension, or session invalidation;
- when access is occupied, return a safe `ADMIN_WORKSPACE_IN_USE` response with only policy-approved operator identity and start or last-active time;
- permit recovery from an expired lease. Any forced revocation or emergency takeover must require MFA or reauthentication, a reason, appropriate authority, and a complete journal trail. A platform operator may revoke a stuck school lease without gaining access to the school's child or trip data.

Suggested configurable starting values are a 60-second heartbeat, a 5-minute lease expiry after missed heartbeats, and a 15-minute privileged idle timeout. Confirm them through pilot testing and record changes in configuration and audit history.

### Administrative session history and journal

For every privileged access attempt and session, persist:

- operator user and operator-profile identifiers;
- platform or school administration workspace and, when applicable, `school_id`;
- authentication session and privileged lease identifiers;
- login or lease-acquired time, last-active time, logout or release time, and release reason;
- success, denial, timeout, revocation, or forced-takeover outcome;
- source IP, coarse location only if legally approved, device identifier, browser or app metadata, and user agent;
- correlation ID and security-relevant risk signals.

Journal every privileged action with actor, workspace, session, lease grant and fencing token, action, target type and ID, outcome, server timestamp, request or correlation ID, originating service, and redacted before-and-after fields where appropriate. The producing service stages each journal record in its outbox in the same transaction as the mutation, and `audit-service` appends it idempotently. The journal is append-only and cannot be edited by platform or school operators, or by any service other than `audit-service`'s append path. Never journal passwords, OTPs, tokens, secrets, full request bodies, or unnecessary child and precise-location data.

### Platform Administrator

Purpose: act as a named operator within the global platform administration workspace, operate the SaaS platform, and manually provision school tenants.

Allowed:

- manually create, suspend, reactivate, and configure school tenant profiles;
- create the school's administration workspace and its first named school administrator operator;
- invite, activate, suspend, and review other platform administrator operator profiles under a separately authorized policy;
- view platform health, usage, billing metadata, and aggregated operational metrics;
- manage platform-level feature flags and provider configuration without exposing secrets;
- view platform audit events;
- provide time-limited support access only through an explicit, reasoned, approved, and fully audited workflow.

Forbidden by default:

- browsing students, guardians, routes, or live bus locations;
- joining school or trip realtime channels;
- silently impersonating a school user;
- editing trip events or audit history.

### School Administrator

Purpose: act as a named operator within exactly one school's administration workspace and configure and monitor transport for that school.

Allowed within the assigned school only:

- create or invite the school's drivers, guardians, and future enabled roles, and manage their school-scoped memberships;
- invite, activate, suspend, and review other named school administrator operators under school policy;
- manage school settings, transport staff, guardians, students, buses, routes, stops, schedules, and assignments;
- create temporary one-day assignments and record approved transport exceptions;
- monitor active trips, bus freshness, occupancy, student states, incidents, and GPS-silence alerts;
- correct operational mistakes by appending correction events;
- view authorized trip history, reports, and school-scoped audit logs;
- manage authorized pickup persons and restricted guardian records under school policy;
- cancel or administratively close a trip only through the defined exception workflow.

Forbidden:

- accessing another school;
- assigning a platform role or creating a membership in another school;
- deleting or silently editing historical safety events;
- reading secrets or raw authentication credentials;
- overriding a restricted-contact rule without a separately authorized and audited process.

### Driver

Purpose: operate only assigned trips safely from a mobile device.

Allowed:

- see the current assigned bus, route, ordered stops, and minimum necessary student manifest;
- start an assigned morning or afternoon trip after required pre-trip checks;
- publish GPS only during an active trip;
- mark a child boarded, not present, arrived at school, or dropped off as allowed by the trip direction;
- flag an unlisted child or other exception without granting access to unrelated records;
- report an incident or SOS with time and location;
- perform the end-of-trip child sweep and confirm the bus is empty;
- work offline and synchronize queued events when connectivity returns.

Forbidden:

- viewing students outside current assignments;
- accessing full guardian profiles, custody notes, or unrelated phone numbers;
- changing routes, schedules, buses, users, or school configuration;
- ending a trip with unresolved onboard children;
- editing or deleting previously synchronized events;
- tracking location outside an active trip.

Driver interactions that affect student status must be optimized for use while the vehicle is stopped. Do not design workflows that encourage tapping while driving.

### Guardian

Purpose: see transport information for children linked to that guardian with active permissions.

Allowed:

- see only linked children for whom the guardian is not restricted;
- see the child's current trip status and assigned bus during the relevant active trip;
- see an honest last-updated timestamp and stale or offline state;
- receive bus-started, boarded, arrived, approaching-stop, dropped-off, incident, and critical fallback notifications according to policy;
- mark a linked child as not riding for an eligible upcoming trip;
- view limited, policy-approved trip history;
- manage personal profile, language, safe notification preferences, and devices;
- contact the school through approved channels.

Forbidden:

- browsing other students, guardians, buses, routes, or stops;
- tracking a bus when no linked child has an eligible active transport context;
- seeing another guardian's private details;
- changing a child's school, route, or pickup authorization;
- receiving transport data when marked restricted.

### Future roles

Design permissions so a transport manager, dispatcher, or bus attendant can be added later without changing the core authorization model. Do not expose these roles in the MVP unless explicitly enabled by a feature flag and fully tested.

## Common authenticated functionality

Every authenticated role may access only these common capabilities plus its role-specific capabilities:

- own profile and verified contact details;
- language, accessibility, and non-critical notification preferences;
- active-session and trusted-device management;
- secure sign-out and account recovery;
- current app version, network state, sync state, and maintenance notices;
- privacy notice, consent records relevant to the user, terms, and support information;
- support request submission without exposing child or trip data unnecessarily.

Critical safety notifications cannot be disabled where school policy or law requires them. Explain this clearly in the UI.

## Permission enforcement requirements

Implement RBAC plus attribute- and relationship-based checks:

- role: what type of action is allowed;
- `school_id`: which tenant the action belongs to;
- relationship: which child, trip, route, or assignment the user may access;
- trip state: whether the action is valid now;
- restriction status: whether a guardian is currently allowed access;
- platform capability: whether native GPS/background execution is supported;
- feature flag: whether a deferred capability is enabled for the school.

Required layers:

1. route and screen guards for user experience;
2. gateway-level token verification and rate limiting (coarse filtering only, never a grant);
3. API policy guards for every operation in the owning service;
4. object-level authorization in domain services;
5. service-to-service authentication and per-endpoint authorization of internal APIs and event consumers;
6. PostgreSQL row-level security as defense in depth for school-owned data in every service database;
7. school- and trip-scoped realtime channel authorization, evaluated by the owning services;
8. recipient authorization immediately before every notification is sent;
9. short-lived signed file access with ownership checks.

All authorization failures return a safe, consistent response and are recorded when security-relevant. Never disclose whether an unauthorized object exists.

## Required product workflows

### Invitation and onboarding

- No public self-registration.
- A named platform administrator operator manually creates the school tenant profile, its school administration workspace, and its first named school administrator operator.
- Only an authorized platform operator can create a school tenant or initial school administration workspace. Record the complete provisioning journal.
- A named school administrator operator creates or invites drivers, guardians, and other enabled school roles using short-lived, single-use invitations tied to a verified phone number or email.
- Every created membership is bound to the administrator's own `school_id`. The server ignores or rejects client-supplied tenant substitutions.
- Drivers and guardians cannot create users, assign roles, or move identities between schools.
- OTP and invitation attempts are rate-limited, replay-resistant, expire quickly, and are audited.
- Require MFA or passkeys for platform administrators and school administrators. Support stronger authentication for other roles when feasible.
- Capture required consent and policy acknowledgments with document version and timestamp.

### School setup

- Configure school identity, timezone, trip windows, stale-location threshold, notification policy, data-retention policy, and support contacts.
- Add buses and capacity.
- Invite drivers.
- Add students and guardian relationships.
- Mark pickup authorization and restrictions without exposing sensitive notes to drivers.
- Create ordered routes and stops using captured coordinates.
- Assign morning and afternoon stops independently.
- Create schedules that generate expected trips.

### Morning trip

1. Driver signs in on a supported native device.
2. App verifies assignment, permissions, GPS, time synchronization, battery state, network state, and local database readiness.
3. Driver reviews the manifest and starts the assigned trip.
4. Server creates or activates one trip instance idempotently.
5. Native background location begins only after trip activation and displays the required persistent system indicator.
6. School sees the bus as active. Eligible guardians receive the bus-started event.
7. At each stop, the driver sees only assigned children and marks boarded or no-show.
8. Each action is written locally first with a client UUID, monotonic sequence, device timestamp, actor, and trip ID, then synchronized.
9. Guardians receive notifications only after the server accepts the authoritative event.
10. Approaching-stop logic uses a simple configurable geofence and deduplicates alerts.
11. At school, onboard students transition to arrived-at-school through an explicit action or approved bulk flow.
12. The driver completes the end-of-trip sweep. The trip cannot complete while a child remains onboard or an exception is unresolved.
13. Location tracking stops, the native task is unregistered, and the completed trip becomes immutable except for append-only corrections.

### Afternoon trip

Use the same trip engine with the direction set to afternoon. Expected students board at school and transition to dropped-off at their authorized stop. If no authorized recipient is present where one is required, keep the child onboard and trigger the school-defined exception procedure. Never auto-complete the drop-off.

### Parent-declared absence

- A guardian may mark a linked child as not riding for an eligible upcoming trip until the school's cutoff time.
- The server validates relationship, restriction, trip, cutoff, and existing boarding state.
- The driver and school receive the updated manifest.
- A not-riding declaration never overwrites an already-boarded event; it creates a conflict that requires school resolution.

### Offline operation and synchronization

- Write driver events and GPS points to a local SQLite outbox before network transmission.
- Encrypt or minimize sensitive local data and purge it according to the retention policy.
- Use a client-generated UUID and server-side unique constraint for idempotency.
- Preserve event order per trip and device with sequence numbers.
- Store device time and authoritative server time.
- Retry with exponential backoff and jitter.
- Batch GPS points; do not delay safety events behind location batches.
- Detect conflicts explicitly. Never use blind last-write-wins for boarding, drop-off, restrictions, or trip completion.
- Display pending, synchronized, rejected, and conflict states clearly to the driver.
- Allow safe resume after app restart or device reboot.

### Stale location

- Publish GPS at a configurable starting interval of approximately 5 to 10 seconds while the trip is active.
- Keep the latest accepted position in Redis and persist batched history in PostgreSQL.
- Display `last updated` everywhere a position is shown.
- After the configured threshold, mark the bus stale or offline; never animate or present old data as live.
- Alert the school when an active bus remains silent beyond the threshold.
- Do not expose a stale position to a guardian without the stale label and timestamp.

### Incident and SOS

- One tap creates a high-priority incident containing trip, actor, server time, device time, last known location, and optional structured category.
- The action must work offline and synchronize ahead of routine GPS data.
- Notify the school through at least two configured channels for severe incidents.
- Show confirmation and the school's emergency contact procedure.
- Do not claim to contact public emergency services unless such an integration is explicitly implemented and legally approved.

### Correction events

Safety-relevant history is append-only. A correction references the original event, records the new interpretation, reason, actor, and timestamps, and recomputes the current projection. Do not update or delete the original event.

## Domain states and invariants

### Trip state

Use an explicit state machine:

- `SCHEDULED`
- `ACTIVE`
- `COMPLETION_PENDING`
- `COMPLETED`
- `CANCELLED`

Only defined transitions are accepted. A completed or cancelled trip cannot return to active. An incident is an event and status flag, not a reason to erase the trip state.

### Per-student trip state

Use direction-aware projections derived from append-only events:

- `EXPECTED`
- `NOT_RIDING`
- `WAITING`
- `BOARDED`
- `NO_SHOW`
- `ARRIVED_SCHOOL`
- `DROPPED_OFF`
- `EXCEPTION`

Do not permit invalid transitions such as dropped off before boarded. Corrections must remain auditable.

### Critical invariants

- The global platform administration workspace has at most one active privileged operator lease.
- Each school administration workspace has at most one active privileged operator lease for that school.
- Every privileged command is attributable to one named operator, one authenticated session, and one valid privileged lease.
- Platform operators alone create school tenants; school operators create memberships only for their own school and never assign the platform role.
- At most one active trip per bus and per driver unless a documented emergency override is used.
- A bus may not exceed configured capacity without an explicit school incident and override.
- Only active trips accept new GPS points.
- Only currently assigned drivers can mutate trip operations.
- A guardian sees a trip only through an eligible child relationship.
- A restricted guardian sees no transport context.
- A trip cannot complete while any child is projected as onboard.
- Location collection stops when the trip stops.
- Every externally visible notification is tied to an accepted server event.

## Core data model

Use UUID primary keys, UTC timestamps, explicit school timezone conversion, soft deletion only where justified, and audit fields. School-owned tables must include `school_id` directly where practical, even when derivable, to make tenant enforcement and RLS reviewable.

Implement at least:

- `PlatformAdministrationWorkspace`
- `PlatformAdminOperatorProfile`
- `School`
- `SchoolSettings`
- `SchoolAdministrationWorkspace`
- `SchoolAdminOperatorProfile`
- `User`
- `SchoolMembership`
- `Role`
- `RoleAssignment`
- `Invitation`
- `OtpChallenge`
- `UserSession`
- `TrustedDevice`
- `PrivilegedAccessLease` with unique workspace scope, owner session, version, acquired time, heartbeat time, expiry, and release metadata
- `PrivilegedSessionHistory`
- `AdministrativeActivityJournal` as an append-only privileged-action ledger
- `Student`
- `GuardianProfile`
- `StudentGuardian` with relationship, permissions, pickup authorization, restriction state, and effective dates
- `DriverProfile`
- `Bus`
- `Route`
- `Stop`
- `RouteStop`
- `StudentStop` with morning or afternoon direction
- `Schedule`
- `Trip`
- `TripStudent`
- `TripAssignment`
- `TransportEvent` append-only with `client_uuid`, sequence, device time, server time, actor, type, payload version, and correction reference
- `PositionPoint`
- `LatestPosition` cache projection
- `Incident`
- `Notification`
- `NotificationAttempt`
- `ConsentRecord`
- `AuditEvent`
- `FeatureFlag`
- `SupportAccessGrant`

Use database constraints for uniqueness, idempotency, valid ranges, positive capacity, and referential integrity. Avoid putting permissions only in JSON. Version event payloads.

Each entity belongs to exactly one service, as listed in the service catalog. References across service boundaries are stored as plain UUIDs, without database foreign keys, and are validated by the owning service's API or by event-fed local read models. Every service database also has `OutboxMessage` and `InboxMessage` tables. Read models copied from another service are labelled as such, rebuilt from events, and never treated as the system of record.

## API and realtime requirements

- Version the public API under `/api/v1`, exposed only through `api-gateway`. Internal service APIs live under `/internal/v1`, are unreachable from the internet, and require service authentication.
- Provide explicit commands for manual platform school provisioning, administration operator management, school-scoped user invitations, privileged lease acquisition, heartbeat, release, session history, and authorized journal search.
- Generate OpenAPI per service and publish one aggregated public document at the gateway. Do not expose internal-only operations in production.
- Maintain an event catalog, with names such as `identity.session.revoked.v1` and `administration.lease.revoked.v1`. Each entry lists the producer, consumers, schema, ordering key, and retention. Events never carry secrets or more child data than consumers need.
- Propagate the correlation ID and W3C trace context through HTTP calls and broker messages.
- Validate every request and response contract.
- Use pagination with bounded page sizes.
- Use opaque UUIDs, but never treat unguessable IDs as authorization.
- Use idempotency keys for trip start, trip end, attendance events, absence declarations, incidents, and provider callbacks.
- Apply strict rate limits by IP, user, device, school, and operation sensitivity.
- Verify webhook signatures, timestamps, and replay protection.
- Use an outbox pattern so accepted safety events and their notifications cannot diverge.
- Authenticate socket connections and reauthorize every subscription.
- Use rooms such as `school:{schoolId}` and `trip:{tripId}` only after server policy evaluation.
- Remove subscriptions immediately when a role, restriction, assignment, or session changes.
- Never include full student records in location broadcasts.

## Notification rules

- Drive notifications from accepted domain events, never directly from client button taps.
- Resolve recipients at send time so restriction changes take effect immediately.
- Deduplicate by event, recipient, channel, and template version.
- Record queued, sent, delivered, failed, retried, and permanently failed states.
- Retry transient failures with bounded exponential backoff.
- Push is primary. SMS or WhatsApp is the configured fallback for critical events.
- Do not put sensitive child or precise location details on lock-screen notification text. Use generic text and require authenticated app access for details.
- Respect school timezone and quiet-hour policy while exempting defined critical safety alerts.

## User experience requirements

- After login, route the user directly to the correct role home screen.
- Never render unauthorized navigation items or preload unauthorized data.
- Use large touch targets, plain labels, and minimal steps for driver actions.
- Provide visible offline, syncing, conflict, GPS-permission, and stale-location states.
- Use accessible color contrast and never rely on color alone.
- Support dynamic text, screen readers, keyboard navigation on web, and reduced motion.
- Keep safety language unambiguous. Distinguish `live`, `last seen`, `offline`, `pending sync`, and `confirmed by server`.
- Confirm destructive administrative actions and require reasons for sensitive overrides.
- Use synthetic data and fictional names in demos, tests, screenshots, and seeds.

## Security and privacy requirements

Use OWASP ASVS 5.0 as the web and API verification baseline, OWASP MASVS for the mobile client, the OWASP API Security Top 10 for threat coverage, and NIST SSDF for the development lifecycle. Maintain a project-specific threat model and security test matrix.

### Authentication and sessions

- Use a proven identity library or managed identity provider rather than custom cryptography.
- Authenticate every administrator as an individual operator. A workspace name is never a login identity and no shared administrator password is permitted.
- Require the operator to select or receive an authorized administration context, then atomically acquire its privileged lease before privileged routes or subscriptions are enabled.
- Recheck lease ownership and expiry on every privileged command and close privileged realtime subscriptions immediately when the lease is lost.
- Hash any passwords with Argon2id using reviewed parameters.
- Store mobile refresh credentials in the platform secure keystore through SecureStore; never in AsyncStorage or logs.
- Use short-lived access tokens, rotating refresh tokens, reuse detection, device-bound session metadata, and server-side revocation.
- For the web, prefer secure, `HttpOnly`, `SameSite` cookies and CSRF protection over browser local storage.
- Rate-limit OTP, recovery, invitation, and login flows and prevent user enumeration.
- Require reauthentication for sensitive role, restriction, support-access, export, and deletion actions.

### Data protection

- Minimize the collection of child, guardian, identity, and location data.
- Encrypt all transport with modern TLS and encrypt databases, backups, object storage, and secrets at rest.
- Use application-level encryption for particularly sensitive notes if they must exist; prefer not storing them.
- Do not store raw OTP values, access tokens, refresh tokens, or provider secrets.
- Redact tokens, exact coordinates, phone numbers, child names, and sensitive payloads from logs.
- Make GPS and notification retention configurable. Implement scheduled deletion and verifiable deletion reports.
- Separate operational analytics from identifiable child data.
- Provide school-scoped export and deletion workflows subject to legal retention and safety audit needs.
- Obtain qualified legal review for consent, children's data, location tracking, employment monitoring, data residency, breach notification, and cross-border transfers in the deployment jurisdiction.

### Application and infrastructure security

- Parameterize database access and prevent mass assignment with allowlisted DTOs.
- Protect against broken object and function authorization on every endpoint.
- Apply secure headers, CSP on web, origin validation, CORS allowlists, CSRF protection, and safe deep-link handling.
- Validate uploaded type, size, signature, ownership, and malware status; keep files private.
- Use least-privilege cloud IAM, separate environments and accounts, short-lived deployment credentials, and a managed secrets store.
- Run containers as non-root with read-only filesystems where practical, health checks, resource limits, and minimal images.
- Pin dependencies and actions, generate an SBOM, sign release artifacts where supported, and scan source, dependencies, containers, IaC, and secrets in CI.
- Back up encrypted data, test restores, define RPO and RTO, and document disaster-recovery procedures.
- Maintain a vulnerability disclosure and patch process.

### Audit requirements

Audit authentication events; privileged lease acquisition, denial, heartbeat loss, release, timeout, revocation, and takeover; operator-profile changes; school provisioning; role and membership changes; invitations; support access; student/guardian relationship changes; restriction changes; route and assignment changes; trip lifecycle; boarding/drop-off/correction events; incidents; sensitive exports; retention jobs; and administrative overrides.

Audit logs and the administrative activity journal must be append-only, access-controlled, tamper-evident where practical, time-synchronized, searchable by authorized users within scope, exported only through an audited process, and protected from secrets and unnecessary sensitive data. An operator may not alter or delete their own history.

## Testing requirements

### Unit and property tests

- privileged lease state, exclusivity, expiry, heartbeat, reconnect, and takeover policies;
- administrative journal field redaction and append-only rules;
- state-machine transitions and invariants;
- authorization policies;
- geofence and stale-location logic;
- event projection and corrections;
- idempotency and sequence handling;
- recipient resolution and notification deduplication;
- retention calculations and timezone boundaries.

### Integration tests

- concurrent lease acquisition against PostgreSQL proves that exactly one operator wins for each administration workspace;
- lease loss blocks later privileged API and realtime operations even if an access token remains valid;
- platform school provisioning and school user creation persist the correct actor and tenant journal entries;
- database constraints, transactions, RLS, and tenant context;
- authentication, session rotation, revocation, OTP throttling, and invitation expiry;
- API validation and standardized errors;
- outbox, queue retries, dead-letter handling, and provider webhooks;
- websocket authentication and subscription revocation;
- PostGIS distance queries and GPS batching;
- consumer-driven contract tests for every internal API and event between services;
- fencing-token rejection of a stale lease holder's delayed command in a downstream service;
- privileged commands fail closed when `administration-service` or `identity-service` is unavailable;
- broker outage and redelivery: outbox backlog drains after recovery and duplicate deliveries produce no duplicate effects;
- saga steps for school provisioning and invitation acceptance, including compensation on partial failure.

### End-to-end tests

- a second platform operator is denied while the global workspace is occupied, then succeeds after safe release or expiry;
- a second administrator of the same school is denied while that school's workspace is occupied, while administrators of different schools can work concurrently;
- every privileged login, logout, timeout, denied access, and administrative mutation is attributable to the named operator and session;
- a school administrator cannot create a platform administrator, choose another `school_id`, or create a user in another tenant;
- each role sees only its navigation and permitted records;
- cross-school IDs never return data or allow mutation;
- a guardian cannot access an unlinked child or bus;
- a restricted guardian loses REST, realtime, and notification access;
- a driver cannot access another route or operate an unassigned trip;
- offline boarding events synchronize once and in order after restart;
- a trip cannot end with an onboard child;
- stale positions display as stale and alert the school;
- correction events preserve original history;
- notification fallbacks do not duplicate critical alerts;
- platform support access expires and leaves a complete audit trail.

### Field and resilience tests

- one-hour drive on low-cost Android devices with the screen locked;
- vendor battery-manager behavior, reboot, app swipe-away, permission removal, and low battery;
- poor network, no network, intermittent network, clock drift, duplicate requests, and out-of-order delivery;
- full trip battery and mobile-data consumption;
- GPS spoofing indicators and implausible jumps as warnings, without pretending perfect prevention;
- load test active trips, position ingestion, websocket fan-out, and notification bursts;
- backup restoration, queue recovery, Redis loss, and rolling deployment;
- loss or restart of any single service, the broker, or the gateway, with documented degradation and no lost safety events.

Do not use production child or school data in tests.

## Repository structure

Create or evolve toward this structure:

```text
aegis/
  apps/
    client/                  # One Expo app for mobile and web
      app/                   # Expo Router routes grouped by authenticated role
      src/
        components/
        features/
        navigation/
        offline/
        location/
        security/
        services/
  services/                  # One directory per independently deployable microservice
    api-gateway/             # Public edge for /api/v1; no business data
    identity-service/        # Users, OTP, sessions, MFA, devices, consents, invitation redemption
    administration-service/  # Tenants, workspaces, operators, memberships, roles, flags, privileged leases
    audit-service/           # Audit events and hash-chained administrative journal
    school-setup-service/    # Students, guardians, relationships, drivers, buses, routes, stops, schedules
    trip-service/            # Trips, assignments, transport events, projections, incidents, absences, sync
    tracking-service/        # Position ingestion, latest position, PostGIS history, stale and geofence logic
    realtime-gateway/        # Authenticated Socket.IO fan-out; no business data
    notification-service/    # Notifications, attempts, templates, provider adapters
    # Each service contains:
    #   src/            NestJS app: api/, application/, domain/ (service-specific), infrastructure/
    #   src/worker.ts   Background jobs and outbox relay entrypoint (same image, separate command)
    #   prisma/         schema.prisma, migrations/, seed.ts (synthetic data only)
    #   test/           unit, integration, and contract tests
    #   Dockerfile
  packages/
    contracts/               # Versioned Zod schemas for public APIs, internal APIs, and events
    domain/                  # Pure shared state machines, policies, and value objects
    service-kit/             # Shared NestJS bootstrap, auth verification, outbox/inbox, tenant transactions
    ui/                      # Shared design system
    config/                  # Typed environment and lint/test configuration
    observability/
  infrastructure/
    docker/                  # Compose stack for all services and dependencies
    terraform-or-equivalent/
    monitoring/
  docs/
    architecture/
    decisions/
    security/
    operations/
    api/
  .github/workflows/
  Aegis_Project_Context.md
  README.md
```

Keep domain rules independent of screens and transport frameworks. Do not duplicate permission logic between mobile and web views. Do not import one service's source code from another service; share only through `packages/*` and published contracts.

## Implementation sequence

Deliver working vertical slices. Each phase must leave the repository runnable and tested.

### Phase 0 Product and security foundations

- inspect the repository and record what already exists;
- create the architecture decision records;
- create the role-permission matrix, data-flow diagram, threat model, and abuse cases;
- define environment handling, coding standards, CI gates, error format, and API conventions;
- define the service catalog, data ownership, event catalog, internal API conventions, and service-to-service authentication;
- scaffold the monorepo, `packages/service-kit` (bootstrap, errors, correlation, token verification, outbox and inbox, tenant transactions), `api-gateway`, and local infrastructure, including RabbitMQ and one database per service.

### Phase 1 Identity and tenant isolation

- `identity-service`: invitations, OTP or passwordless authentication, sessions with rotating refresh tokens, MFA for privileged operators, JWKS publication, and session-revocation events;
- `administration-service`: global and per-school administration workspaces with named operator profiles, school memberships and roles, manual school provisioning by a platform operator, school-scoped user provisioning by a school operator, and the provisioning and invitation sagas with `identity-service`;
- privileged access leases with fencing tokens, heartbeats, safe expiry and release, session history, and the internal lease-validation API;
- `audit-service`: append-only, hash-chained administrative journaling and audit events fed through the transactional outbox;
- `realtime-gateway`: privileged lease channel with subscription revocation on lease loss;
- PostgreSQL RLS in every service database, and negative cross-tenant tests;
- contract tests between the gateway, identity, administration, audit, and realtime services;
- role-specific application shells and common profile/session screens.

### Phase 2 School transport setup

- `school-setup-service`: students, guardians, relationships, restrictions, buses, drivers, routes, ordered stops, independent morning/afternoon assignments, and schedules, with lease-validated and fencing-token-checked privileged commands;
- school setup UI with validation and audit history;
- synthetic seed for one pilot school.

### Phase 3 Driver trip vertical slice

- `trip-service`, with an event-fed local read model of assignments and manifests from `school-setup-service`;
- native capability and permission checks;
- expected trip and assignment;
- start trip, local manifest, board/no-show/arrive/drop-off events;
- SQLite outbox, idempotent sync, retry, restart recovery;
- end-of-trip sweep and completion invariant;
- incident/SOS.

### Phase 4 Live tracking and school monitoring

- native background GPS during active trips only;
- `tracking-service`: ingestion, validation, batching, latest-position cache, PostGIS history;
- authenticated realtime updates through `realtime-gateway`;
- school live map, occupancy, sync state, last-updated state, and GPS-silence alerts.

### Phase 5 Guardian experience and notifications

- linked-child authorization and restricted-contact enforcement;
- active-trip view with stale-data honesty;
- absence declaration;
- `notification-service`: event-driven push notifications, send-time recipient resolution, and critical fallback adapters;
- limited trip history.

### Phase 6 Hardening and pilot readiness

- full audit coverage, retention jobs, export/deletion controls, backups and restore test;
- performance, resilience, accessibility, device, and security testing;
- incident runbooks, onboarding guides, printed-manifest fallback, monitoring dashboards, and deployment automation;
- pilot metrics and go/no-go dashboard.

Do not begin later roadmap modules such as payments, grades, homework, full attendance, AI, advanced route optimization, or national multi-enterprise features during the MVP.

## Development rules for the AI assistant

- Start by reading the repository, this prompt, and `Aegis_Project_Context.md`.
- State assumptions and create short ADRs for consequential choices.
- Work in small, reviewable vertical increments.
- Before editing, inspect relevant code and tests. Preserve unrelated user changes.
- Use migrations; never synchronize a production schema destructively. Each service owns and runs only its own migrations.
- Never let one service query another service's database, and never add cross-service database foreign keys.
- Keep service APIs and event schemas backward compatible across at least one deployed version so services can be released independently.
- Do not place secrets, credentials, real phone numbers, or real child data in source, prompts, fixtures, logs, commits, screenshots, or issue text.
- Do not invent successful test results. Run commands and report actual output.
- Do not mark a feature complete when only the UI exists.
- Do not leave authorization, validation, offline behavior, error handling, or tests as TODOs for a feature claimed complete.
- Prefer explicit, readable policy code over clever abstractions.
- Keep adapters around external providers so local development and provider changes do not alter domain logic.
- When blocked by an external credential, implement and test the adapter contract with a local fake, document the exact missing secret, and continue with non-secret work.
- Stop and request a product decision only when alternatives materially change safety, legal obligations, data ownership, or irreversible architecture.

## Required documentation

Maintain:

- root README with exact setup, run, test, build, migration, seed, and deployment commands;
- environment variable reference with no secret values;
- architecture overview and system/data-flow diagrams;
- service catalog with data ownership, dependencies, SLOs, and on-call owner per service;
- event catalog and internal API catalog;
- ADRs for the microservice decomposition, messaging and outbox, service-to-service authentication, cross-service lease fencing, the universal client, authentication, authorization/RLS, offline sync, event model, realtime, notifications, map provider, retention, and deployment;
- current role-permission matrix;
- threat model and security verification checklist;
- API/OpenAPI documentation;
- incident response, backup/restore, support, and pilot runbooks;
- data inventory, retention schedule, and subprocessors/provider register;
- release checklist and rollback procedure.

## Definition of done

The MVP is done only when all of the following are demonstrated with synthetic data in staging:

- one client app signs in and presents four correctly isolated role experiences;
- a named platform operator can manually create a school administration workspace and its first named school administrator;
- a named school administrator can create or invite drivers and guardians only for that school;
- multiple operator profiles can belong to each administration workspace, but concurrent attempts prove that no more than one independently authenticated operator session can hold that workspace's privileged lease, and stale holders are rejected by fencing tokens in every service;
- each service builds, deploys, scales, and rolls back independently, and the loss of any single non-gateway service degrades only its own capabilities without losing safety events;
- login, logout, timeout, denial, takeover, and every privileged activity appear in an append-only journal attributed to the correct named operator and session;
- server, database, realtime, file, and notification authorization tests prevent cross-role, cross-child, and cross-school access;
- a school administrator can configure the complete pilot dataset;
- an assigned driver can run a morning and afternoon trip on a physical low-cost Android device;
- GPS and events survive screen lock and temporary network loss;
- queued events synchronize exactly once from the user's perspective;
- guardians see only eligible linked children and honest location freshness;
- restricted guardians lose access across all channels;
- a trip cannot complete with a child marked onboard;
- correction events preserve original history;
- critical notifications are logged, deduplicated, retried, and can use a fallback channel;
- audit, monitoring, alerting, backup, restore, retention, and rollback procedures are tested;
- accessibility, performance, security, and field-test acceptance criteria pass;
- deployment and operations documentation allows another engineer to run the system without private oral knowledge.

## Start now

First, inspect the repository and summarize the current state against this prompt. Then create an implementation plan that names files, migrations, tests, dependencies, risks, and acceptance checks for the first vertical slice. Unless a safety-critical or irreversible decision is missing, proceed to implement Phase 0 and Phase 1, run the verification suite, and report what is working, what remains, and the exact next command.
