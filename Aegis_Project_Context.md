# Aegis Project Context

## Purpose

This file is the durable context for engineers and AI assistants building Aegis. It describes the product boundary, architecture, security posture, domain rules, repository structure, and operating practices that must remain consistent as the codebase evolves.

Aegis is a real-time school-transport safety product. It handles information about children, guardians, staff, routes, and live location. A technically functional feature is not acceptable if it weakens privacy, tenant isolation, auditability, truthful status reporting, or safe human operations.

## Product view

The MVP solves one problem: make school transport visible, accountable, and safer during real morning and afternoon trips.

The product's core promise is:

> Parents know the relevant status of their child and assigned bus, the school knows which children are assigned and onboard, and authorized users receive timely confirmation when a child boards, arrives, or is dropped off.

The school is the primary customer and tenant. A school may operate transport directly or through a transport operator, but the commercial and data-controller relationships must be validated before contracts and pricing are finalized.

The first milestone is deliberately narrow: one school, one bus, roughly twenty students, and one complete real trip. Expansion into attendance, parent communication, payments, grades, homework, accounting, AI, route optimization, or a complete school ERP is outside the MVP.

## Business and rollout context

The initial commercial model is business-to-business: the school pays for the service and may include it in transport fees. Validate whether an outsourced transport operator is instead the buyer or a second customer segment before fixing contracts or product packaging.

The specification proposes an early pricing hypothesis of 50,000 to 150,000 FCFA per school per month plus 300 to 1,000 FCFA per active child, depending on service level. This is research input, not approved pricing. Model the recurring cost of push fallback messages, WhatsApp or SMS, map tiles, cloud infrastructure, driver data, onboarding, support, and optional hardware before accepting a price.

Pilot shape:

- one school and one committed school champion;
- one or two buses;
- approximately 20 to 50 children;
- morning and afternoon routes;
- two to four weeks of live operation;
- a paid pilot or signed letter of intent where practical;
- agreed go, fix, and stop thresholds before results are known.

Product expansion is demand-led:

1. Aegis Transport: the current MVP.
2. Attendance integration after transport is reliable.
3. Parent communication after repeated validated demand.
4. Selected payments after commercial and regulatory review.
5. Broader school operations only after the transport product has retained paying users.

## Product principles

1. Safety rules are domain invariants, not optional UI guidance.
2. Server authorization is authoritative. The client never grants access.
3. Every school is isolated from every other school.
4. Guardians see only linked children and only the minimum relevant transport context.
5. Drivers see only current assignments and minimum operational data.
6. Safety events are append-only. Corrections do not erase history.
7. Offline operation is a core requirement for the driver experience.
8. Old location data is visibly stale. The system never presents it as live.
9. Location is collected only for an authorized active trip.
10. The app supplements trained human supervision and paper fallback procedures.
11. External providers are replaceable adapters, not domain dependencies.
12. Production readiness includes operations, monitoring, support, recovery, and security evidence.
13. Administrative authority belongs to a platform or school workspace, but every use of it is attributable to one individually authenticated named operator.
14. No platform administration workspace, and no single school administration workspace, may have more than one active privileged operator session at a time.
15. The administrative hierarchy is additive: existing transport, guardian, driver, offline, tracking, incident, notification, and reporting behavior remains unless an explicit authorization boundary limits who can use it.
16. The backend is a set of microservices organized by bounded context. Each service owns its data exclusively, enforces its own authorization, and communicates only through versioned APIs and events. Distribution never weakens a safety or administration invariant; where one transaction is no longer possible, the transactional outbox, fencing tokens, and fail-closed synchronous checks preserve it.

## Single application model

Aegis uses one universal Expo and React Native client application for Android, iOS, and web. All users enter through the same authentication flow. After authentication, the application receives a server-issued session and a server-authorized role context, then constructs the appropriate navigation shell.

One application does not mean one identical screen layout. The same codebase may use:

- a desktop-oriented responsive dashboard for school administrators;
- a low-distraction native trip workflow for drivers;
- a simple mobile or web status experience for guardians;
- a tightly restricted operational console for platform administrators.

Driver background location requires native Android or iOS capability and a development or production build. The web client must not pretend it can provide equivalent background tracking.

## Roles and access boundaries

### Administrative workspace model

The phrases `super admin account` and `school main administration account` describe organizational administration workspaces. They must never be implemented as shared usernames or shared passwords.

- Aegis has one global `PlatformAdministrationWorkspace`.
- Every school tenant has exactly one `SchoolAdministrationWorkspace`.
- Each workspace may have multiple named operator profiles so different authorized people can administer it at different times.
- Each operator authenticates with an individual `User` identity, verified contact, MFA or passkey, and revocable operator profile.
- Every privileged request carries the operator identity, administrative workspace, authenticated session, and active role context.
- The UI always displays the named operator currently exercising the workspace privilege.

An operator profile is not a second anonymous login beneath a shared password. It is an attributable authorization relationship between one human identity and one administrative workspace.

### One-active-operator rule

Only one independently authenticated session may exercise a given administration workspace at a time:

- the global platform workspace permits one active platform operator lease across the deployment;
- each school workspace permits one active school operator lease, independently of all other schools;
- administrators of different schools may work at the same time;
- drivers and guardians may have ordinary concurrent sessions and are not covered by this rule;
- the same authenticated browser session may reconnect or use multiple tabs under the same lease, but a second device or independent session cannot acquire another lease;
- `administration-service`'s PostgreSQL database is authoritative for atomic lease acquisition, heartbeat renewal, expiry, release, and revocation. Redis and the message broker may accelerate signals but may never be the only lock;
- every new grant carries a monotonically increasing fencing token per workspace, and every service that executes privileged commands rejects a token lower than the highest it has seen;
- every privileged API request and realtime subscription revalidates lease ownership and expiry. Services other than `administration-service` validate through its internal API on every privileged command and fail closed when it cannot be reached;
- logout, idle timeout, missed heartbeat, session revocation, or operator suspension releases or expires access;
- a second operator receives a safe workspace-in-use response rather than partial access;
- expired leases can be recovered. Forced revocation or takeover requires reauthentication or MFA, a reason, adequate authority, and complete journaling.

Start with configurable values of a 60-second heartbeat, a 5-minute missed-heartbeat expiry, and a 15-minute privileged idle timeout, then validate them during the pilot. A platform operator may revoke a stuck school-administration lease without gaining routine access to that school's child, route, trip, or location data.

### Platform Administrator

Platform administrators are named operators in the global administration workspace. They manually create, suspend, and reactivate school tenants; create each school's administration workspace and first named school operator; and manage platform configuration and platform operator profiles. They do not receive routine access to school child, route, or live-location data. Any support access is time-limited, approved, reasoned, scoped, and audited. Silent impersonation is prohibited.

### School Administrator

School administrators are named operators in exactly one school's administration workspace. They create or invite that school's drivers, guardians, other school operators, and future enabled roles; manage their school-scoped memberships; and manage transport data and operations for their school. They can manage students, guardian relationships, restrictions, buses, drivers, routes, stops, schedules, assignments, trips, incidents, and school audit history. They cannot create platform operators, select another `school_id`, access another school, or alter historical safety events in place.

### Driver

Drivers operate assigned trips. They can see the minimum manifest required for the current route, record boarding and drop-off states, publish location during the trip, report incidents, and complete the child sweep. They cannot browse other routes, full guardian records, or school configuration.

### Guardian

Guardians see only children linked through an active `StudentGuardian` permission. They may see the linked child's relevant trip and assigned bus, declare an eligible absence, receive notifications, and view limited history. A restriction immediately removes transport access across REST, realtime, notifications, cached client data, and signed files.

### Authorization policy

The authorization decision combines:

- authenticated identity and valid session;
- role and school membership;
- `school_id` tenant boundary;
- relationship to the requested student, trip, route, bus, or record;
- current assignment and trip state;
- guardian restriction and effective dates;
- requested action and data fields;
- device/platform capability where safety depends on it;
- explicit feature enablement.

No role implicitly inherits another role's permissions. If multiple roles are introduced later, the user must select an active role context and the server must authorize it. Avoid broad `isAdmin` flags.

## Role capability summary

| Capability | Platform Admin | School Admin | Driver | Guardian |
|---|---:|---:|---:|---:|
| Manually provision or suspend schools | Yes | No | No | No |
| Create the first school administration operator | Yes | No | No | No |
| Manage named operators in own administration workspace | Platform scope | Own school | No | No |
| Create or invite drivers and guardians | No by default | Own school | No | No |
| Hold workspace privilege while another independent operator is active | No | No | Not applicable | Not applicable |
| View administrative session and activity journal | Platform scope | Own school | Own security/session events only | Own security/session events only |
| Manage own school configuration | No by default | Yes | No | No |
| Manage students and guardian links | No by default | Own school | No | No |
| Manage buses, routes, stops, schedules | No by default | Own school | No | No |
| View active school fleet | No by default | Own school | Assigned trip only | Eligible linked trip only |
| Start and operate a trip | No | Exception workflow only | Assigned trip | No |
| Record boarding and drop-off | No | Audited correction or exception | Assigned trip | No |
| Declare child not riding | No | Own school exception workflow | No | Eligible linked child |
| View child transport history | No by default | Own school | Current assigned trip minimum | Linked child limited history |
| Manage platform configuration | Yes | No | No | No |
| View audit data | Platform scope | Own school | Own security/session events only | Own security/session events only |

`No by default` means support access requires a separate grant; it does not mean the platform role may bypass normal APIs.

## Common user capabilities

All authenticated users may manage their own profile, verified contact details, supported language, accessibility settings, non-critical notification preferences, sessions, devices, and account recovery. They may read current privacy and consent documents, submit a support request, and sign out.

Common capabilities do not include access to a global directory, school roster, route list, live fleet, or other users' profiles.

## Core journeys

### School onboarding

A named platform operator acquires the global privileged lease and manually creates the school profile, school administration workspace, and first named school administrator. The action records the operator, session, timestamps, result, and redacted change details. The first school administrator completes individual authentication and MFA, acquires the school's privileged lease, and creates or invites school users such as other administrators, drivers, and guardians. Every membership is server-bound to that school. The school then configures timezone, support contacts, policies, buses, staff, routes, captured stop coordinates, students, guardian links, morning and afternoon assignments, and schedules. Accounts are invitation-only. The pilot dataset and its provisioning journal must be reviewable before the first trip.

### Morning collection

A schedule produces an expected trip. The assigned driver uses a supported native device, passes permission and readiness checks, and starts the trip. The client writes operational events locally first, synchronizes them idempotently, and sends active-trip GPS. At each stop, the driver records boarding or no-show states. At school, onboard students are marked arrived. The driver completes a physical sweep, confirms the bus is empty, and completes the trip.

### Afternoon return

The same engine runs in the opposite direction. Students board at school and are dropped at the approved stop under school policy. When an authorized recipient is required but absent, the child stays onboard and an exception workflow begins.

### Guardian absence

A permitted guardian may declare a linked child not riding until the configured cutoff. The server validates relationship, restriction, schedule, cutoff, and current event state. It updates the expected manifest through an append-only event. A declaration after boarding becomes a conflict, not an overwrite.

### Incident

A driver can create an incident or SOS event even without connectivity. High-priority events synchronize before routine location batches. The school receives configured escalation, and the system preserves the full timeline. The product must not claim to summon public emergency services unless a specific, tested integration exists.

## State machines

### Trip state

```text
SCHEDULED -> ACTIVE -> COMPLETION_PENDING -> COMPLETED
     |          |
     +--------> CANCELLED
```

Only the domain service transitions state. Completed and cancelled trips are terminal. Administrative exception transitions require an authorized actor, reason, and audit event.

### Student trip projection

```text
EXPECTED -> WAITING -> BOARDED -> ARRIVED_SCHOOL   morning
    |                    |
    |                    +-----> DROPPED_OFF       afternoon
    +------> NOT_RIDING
    +------> NO_SHOW
    +------> EXCEPTION
```

The projection is derived from immutable transport events. A correction adds a new event referencing the original.

### Invariants

- The platform administration workspace has no more than one active privileged operator lease.
- Each school administration workspace has no more than one active privileged operator lease for that school.
- Every privileged action resolves to one named operator, one authenticated session, one administration workspace, and one valid lease.
- Only platform operators create school tenants. School operators create memberships only in their own school and cannot assign the platform role.
- One bus and one driver have at most one active trip under normal operation.
- Only the assigned driver operates a trip.
- Only an active trip accepts location.
- No invalid student transition is accepted.
- No completed trip has a child projected as onboard.
- A guardian's access requires an active relationship and no active restriction.
- Notifications reference an accepted server event.
- Every client retry with the same event UUID produces the same authoritative result.
- Tracking stops and native tasks unregister when the trip ends or the session is revoked.

## Domain model guidance

### Tenancy

`School` is the tenant boundary. Its system of record is `administration-service`. Put `school_id` on school-owned records in every service database, even where it could be inferred. Within one service database, use foreign keys, composite uniqueness constraints, and PostgreSQL row-level security. The normal database role of every service must not have `BYPASSRLS`. References to another service's entities are plain UUIDs without cross-database foreign keys, validated through the owning service's API or event-fed read models.

Workers and event consumers must establish tenant context explicitly before processing school data. An event's `school_id` comes from the producing service's authoritative record, never from client input. Platform operations use a separate, narrow service path and never a general-purpose tenant bypass.

### Service ownership

| Service | System of record |
|---|---|
| `identity-service` | users, OTP challenges, sessions, refresh tokens, MFA factors, trusted devices, consent records, invitation delivery and redemption |
| `administration-service` | schools, school settings, administration workspaces, operator profiles, memberships, roles, role assignments, feature flags, privileged leases, privileged session history, support access grants |
| `audit-service` | audit events and the hash-chained administrative activity journal |
| `school-setup-service` | students, guardian profiles, student-guardian relationships and restrictions, driver profiles, buses, routes, stops, route stops, student stops, schedules |
| `trip-service` | trips, trip assignments, trip students, transport events and projections, incidents, absence declarations |
| `tracking-service` | position points, latest positions, stale-location and geofence state |
| `notification-service` | notifications, notification attempts, templates |
| `api-gateway`, `realtime-gateway` | no business data |

Every service database also contains `OutboxMessage` and `InboxMessage` tables. Copies of another service's data are labelled read models, rebuilt from events, and never authoritative.

### Identities and relationships

`User` stores one person's identity and verified contact channels. `SchoolMembership` assigns a role within a school. `PlatformAdminOperatorProfile` links an individually authenticated user to the global `PlatformAdministrationWorkspace`; `SchoolAdminOperatorProfile` links a user to one school's `SchoolAdministrationWorkspace`. Profiles include status, creator, effective dates, and MFA readiness but never credentials. A person with legitimate memberships in multiple schools must select an active context and acquire that workspace's lease; memberships never merge tenant data.

`PrivilegedAccessLease` is the authoritative one-row-per-workspace lock in `administration-service`. It stores:

- workspace type and ID;
- owner user, operator profile, and authentication session;
- acquired time, heartbeat time, and expiry;
- version and fencing token;
- release time and release reason;
- takeover metadata.

Acquire or replace an expired lease atomically in a PostgreSQL transaction. A background cleanup job may mark expired leases, but correctness must not depend on the job running. Lease changes are published as events so that `realtime-gateway` and other services can drop privileged subscriptions and caches immediately. Those events are an acceleration only; synchronous validation remains authoritative.

`PrivilegedSessionHistory` records every acquisition attempt and the session lifecycle.

`AdministrativeActivityJournal` is an append-only ledger of privileged actions, owned by `audit-service`. Each record includes:

- actor, workspace, and school where applicable;
- session, lease grant, and fencing token;
- originating service, action, target, and outcome;
- server time, correlation ID, and source metadata;
- carefully redacted before-and-after fields.

Each producing service writes its journal records to its own outbox in the same transaction as the privileged mutation, and `audit-service` appends them idempotently to a per-workspace hash chain. Operators cannot edit or delete these records, and no service other than `audit-service` can write the journal store.

`StudentGuardian` is many-to-many and stores relationship, view permission, pickup authorization, restriction status, effective dates, and policy metadata. Do not put all relationship semantics on `GuardianProfile`.

### Routes and schedules

`Route` has ordered `RouteStop` records. Stops are captured as coordinates by an authorized user. A `StudentStop` may differ for morning and afternoon. `Schedule` represents what should run and generates expected `Trip` records so completion metrics have a denominator.

### Events and projections

`TransportEvent` is append-only and versioned. It includes school, trip, optional student, type, actor, client UUID, device identifier, device sequence, device time, server time, payload version, payload, and optional corrected-event reference.

Read models such as `TripStudent` and occupancy are projections inside `trip-service`, updated transactionally or by a reliable projector. The event record remains the audit truth. Accepted transport events are published through `trip-service`'s outbox. Downstream consumers (`notification-service`, `realtime-gateway`, `audit-service`) are therefore driven only by events the server has accepted, and every consumer is idempotent.

### Location

Location points include trip, bus, driver, latitude, longitude, speed, heading, accuracy, device time, server receipt time, and sequence. Reject impossible formats and points outside the active-trip window. Treat spoofing or implausible jumps as confidence signals, not proof of fraud.

Store the latest authorized position in Redis for fast reads and websocket fan-out. Persist history in batches and apply configured retention. Do not keep indefinite precise location by default.

### Notifications

`Notification` represents an intended user communication derived from a domain event. `NotificationAttempt` records each channel attempt and provider result. Resolve eligibility when sending, deduplicate, and avoid child names or precise locations in lock-screen text.

## Offline-first driver design

The driver app is a local-first command client during a trip:

1. Store the current authorized manifest and minimal route data in private local storage.
2. Write each event to a SQLite outbox before acknowledging the action in the UI.
3. Assign a UUID and per-device trip sequence.
4. Show `pending sync` until the server accepts it.
5. Send safety events before location batches.
6. Retry with exponential backoff and jitter.
7. Use server uniqueness on `client_uuid` for idempotency.
8. Preserve outbox state across app restart and device reboot.
9. Surface rejection or conflict; never silently discard it.
10. Purge expired manifests, completed outboxes, and cached location under policy.

Minimize the local data set. Store tokens in the platform keystore, not SQLite. Never store full custody notes, unrelated guardian data, or provider credentials on the device.

## Realtime and stale-data honesty

Websocket channels are conveniences over authoritative persisted state. Clients must reconnect, reauthenticate, resubscribe, and reconcile through REST after gaps.

All location surfaces show:

- server-accepted position time;
- `last updated` age;
- live, delayed, stale, or offline state;
- accuracy when operationally useful.

A configurable starting silence threshold is approximately 60 seconds, subject to field testing. Crossing it marks the bus stale and triggers a school alert. An old marker must not continue moving or appear live.

## Notification design

Initial event types include:

- trip started;
- child boarded;
- approaching guardian stop;
- arrived at school;
- child dropped off;
- trip incident;
- active bus location stale;
- trip completion blocked because a child remains onboard.

Push is the primary consumer channel. SMS or WhatsApp may be used as a fallback for configured critical events. Provider callbacks are signed and replay-protected. Delivery status is recorded. Templates are versioned and localized.

## Canonical technology stack

Use current stable, mutually compatible, pinned versions. The backend uses a microservice architecture organized by bounded context (see the service ownership table). Keep the service count at the catalog defined here. Split a service further only when measured scale, failure isolation, or operational ownership justifies it, and record each split in an ADR.

### Application and data

- Monorepo: pnpm workspaces and Turborepo with TypeScript strict mode.
- Universal client: Expo, React Native, React Native Web, and Expo Router. Use responsive web layouts for administration and native Android or iOS builds for reliable driver background location.
- Client libraries: TanStack Query for server state, Zustand for small client-only state, React Hook Form and Zod for forms and validation, SecureStore for credentials, Location and TaskManager for active-trip tracking, and SQLite with SQLCipher-enabled encryption for the driver's minimal offline outbox and cached manifest.
- Backend services: NestJS with Fastify in every microservice. A shared `service-kit` package provides bootstrap, problem-details errors, correlation and trace propagation, JWKS token verification, tenant-context transactions, and the outbox and inbox.
- Public API: REST under `/api/v1`, exposed only through `api-gateway`, with per-service OpenAPI aggregated at the gateway and shared Zod contracts.
- Internal APIs: REST under `/internal/v1` on the private network, authenticated with short-lived service tokens and contract-tested. They are never exposed publicly.
- Messaging: RabbitMQ (Amazon MQ in production) behind a broker port, with quorum queues, dead-letter exchanges, publisher confirms, a transactional outbox in every producer, and an idempotent inbox in every consumer.
- Authoritative databases: PostgreSQL with PostGIS, with one logical database and separate least-privilege roles per service. For the pilot these may share one cluster; no service may read another's database. Use Prisma for ordinary access, explicit transactions, reviewed migrations, PostgreSQL row-level security, and reviewed SQL for PostGIS and lease primitives. PostgreSQL remains preferable because, within each service, tenant constraints, transactions, RLS, geospatial queries, append-only events, and the outbox belong in one strongly consistent store.
- Cache and jobs: managed Redis or Valkey with BullMQ for in-service jobs, using per-service key prefixes. Redis is disposable acceleration, never the only record of a safety event, permission, or privileged lease.
- Realtime: a dedicated `realtime-gateway` service running Socket.IO with authenticated school and trip rooms, and a Redis adapter for horizontal scaling. It authorizes rooms through the owning services and fans out broker events.
- Identity: managed OpenID Connect such as Amazon Cognito, Auth0, or self-hosted Zitadel, fronted by `identity-service`, which issues the Aegis access tokens and publishes the JWKS. Authentication factors live with the identity system. Aegis roles, memberships, operator profiles, and tenant policy live in `administration-service`.
- Maps: MapLibre with a contracted production tile provider.
- Files: private S3-compatible object storage with short-lived authorized URLs.
- Notifications: Firebase Cloud Messaging and APNs through an adapter, with provider-based SMS or WhatsApp fallback for policy-defined critical events.
- Observability: OpenTelemetry, structured redacted logs, metrics and traces, plus Sentry or equivalent error tracking.

### Delivery and production hosting

- Local development: Docker Compose with PostgreSQL/PostGIS (one database per service), Redis or Valkey, RabbitMQ, mail capture, fake notification providers, S3-compatible storage, and every service container.
- Infrastructure and delivery: Docker with one image per service, Terraform, GitHub Actions with Turborepo affected-service builds and independent per-service deployment, and Expo Application Services for signed mobile builds and store submission.
- Recommended managed AWS production target:
  - ECS Fargate with one ECS service per microservice, connected through ECS Service Connect;
  - an Application Load Balancer and WAF in front of `api-gateway` and `realtime-gateway`;
  - RDS PostgreSQL with PostGIS, with one database per service;
  - ElastiCache Redis or Valkey, and Amazon MQ for RabbitMQ;
  - S3 and CloudFront, Route 53 and ACM, and ECR;
  - Secrets Manager and KMS, with per-service secrets and task roles;
  - CloudWatch.
- A lower-cost pilot may use a well-operated regional VPS or another managed cloud running the same service images through Docker Compose or k3s. It must preserve TLS, backups, database isolation between services, secret management, monitoring, recovery, and the same application contracts. Avoid irreversible dependence on one provider.

This is a mobile-first universal product, not mobile-only. Drivers need native mobile capabilities; school and platform administrators need efficient responsive web consoles; guardians may use mobile or web. One client codebase and one public API surface through the gateway preserve consistent security and reduce duplicate product work. The backend decomposition into microservices is invisible to the client.

## Repository structure and boundaries

```text
apps/client                      universal role-aware Expo app
services/api-gateway             public /api/v1 edge; routing, rate limits, CORS/CSRF, correlation
services/identity-service        authentication, sessions, MFA, devices, consents, invitation redemption
services/administration-service  tenants, workspaces, operators, memberships, roles, flags, privileged leases
services/audit-service           audit events and hash-chained administrative journal
services/school-setup-service    students, guardians, restrictions, drivers, buses, routes, stops, schedules
services/trip-service            trips, transport events, projections, incidents, absences, offline sync
services/tracking-service        position ingestion, latest position, history, stale and geofence logic
services/realtime-gateway        authenticated Socket.IO fan-out
services/notification-service    notifications, attempts, templates, provider adapters
packages/domain                  pure shared state machines, policies, and value objects
packages/contracts               versioned public API, internal API, and event schemas
packages/service-kit             shared service bootstrap, auth verification, outbox/inbox, tenant transactions
packages/ui                      accessible shared design system
packages/config                  typed configuration and tooling
packages/observability           tracing, metrics, and redaction
infrastructure                   local and cloud infrastructure as code
docs                             architecture, decisions, security, and operations
```

Each service owns its `prisma/` schema, reviewed migrations, and synthetic seed. It also contains a worker entrypoint for its jobs and outbox relay, its own Dockerfile, and its own tests.

Lease policy lives in `packages/domain` and is enforced only by `administration-service`, never by controllers in other services or by client code. Journal hash-chaining lives only in `audit-service`.

Dependency direction:

```text
UI and transport adapters -> application services -> domain
infrastructure adapters   -> application ports   -> domain
service A                 -> published contracts  -> service B   (never A's code -> B's code or database)
```

The domain package does not import Expo, NestJS, Prisma, Redis, broker clients, provider SDKs, or UI code. External systems implement explicit ports. No service imports another service's source.

## API conventions

- Prefix versioned routes with `/api/v1`.
- Use nouns for resources and explicit command endpoints for state transitions.
- Accept and return documented Zod-validated contracts.
- Use UTC ISO 8601 timestamps and UUIDs.
- Use cursor pagination for growing event and position collections.
- Cap page size and request body size.
- Use `Idempotency-Key` for sensitive commands.
- Return a consistent problem-details error shape with a correlation ID.
- Do not expose stack traces, database errors, authorization reasoning, or object existence.
- Generate OpenAPI from the implemented contracts and test examples.

Representative commands:

```text
POST /api/v1/platform/schools
POST /api/v1/platform/admin-operators
POST /api/v1/schools/{schoolId}/admin-operators
POST /api/v1/schools/{schoolId}/user-invitations
POST /api/v1/privileged-access/acquire
POST /api/v1/privileged-access/heartbeat
POST /api/v1/privileged-access/release
GET  /api/v1/administration/session-history
GET  /api/v1/administration/activity-journal
POST /api/v1/trips/{tripId}/start
POST /api/v1/trips/{tripId}/events
POST /api/v1/trips/{tripId}/positions/batch
POST /api/v1/trips/{tripId}/request-completion
POST /api/v1/trips/{tripId}/confirm-empty
POST /api/v1/trips/{tripId}/complete
POST /api/v1/trips/{tripId}/incidents
POST /api/v1/students/{studentId}/absence-declarations
GET  /api/v1/guardian/children/{studentId}/active-trip
```

Every command loads the actor, membership, object, school, relationship, and current state before applying the domain transition.

Privileged commands additionally load and verify the operator profile, administration workspace, authentication session, unexpired lease, and fencing token. In `administration-service` these checks run against its own database. Other services obtain them from `administration-service`'s internal lease-validation API on every privileged command. The service derives the platform or school scope from those server records; it never trusts a submitted `school_id` to grant authority.

Internal and event conventions:

- Internal routes use the `/internal/v1/...` prefix, are never routed by the gateway, require a service token whose audience is the callee, and authorize the calling service per endpoint.
- Events are named `<service>.<entity>.<fact>.v<n>` (for example `identity.session.revoked.v1`, `administration.lease.revoked.v1`, and `trip.student.boarded.v1`). They carry an event ID, occurred time, producer, `school_id` where applicable, correlation and trace IDs, and a minimal payload.
- Producers publish only through their transactional outbox. Consumers deduplicate by event ID and tolerate redelivery and reordering within the documented ordering key.
- Breaking API or event changes require a new version that runs alongside the old one until all consumers have migrated.

## Security baseline

### Verification standards

Use these as engineering baselines, not compliance claims:

- OWASP Application Security Verification Standard 5.0 for web and API security requirements;
- OWASP Mobile Application Security Verification Standard for device storage, cryptography, authentication, network, platform, code, resilience, and privacy controls;
- OWASP API Security Top 10 2023, especially object-level and function-level authorization;
- NIST Secure Software Development Framework for secure lifecycle practices.

Maintain a traceable security matrix mapping applicable controls to code, configuration, automated tests, manual tests, owners, and evidence.

### Threat model priorities

Review at least:

- shared or borrowed administrator credentials destroy individual accountability;
- two platform operators, or two operators of the same school, acquire privilege concurrently because of a race condition;
- a crashed client leaves a stale lease that blocks legitimate administration indefinitely;
- lease heartbeat or release requests are replayed or forged;
- a forced takeover is abused or performed without a reason and strong reauthentication;
- an operator tampers with, deletes, or floods their own activity journal;
- a school administrator creates a user in another tenant or assigns the platform role through mass assignment;
- guardian enumerates another child or bus;
- school administrator crosses tenant boundaries;
- driver downloads an excessive roster;
- restricted guardian retains cached, realtime, notification, or signed-link access;
- stolen driver device continues publishing or reading trip data;
- replayed OTP, invitation, refresh token, event, webhook, or location batch;
- mass assignment changes `school_id`, role, guardian permissions, or trip ownership;
- forged boarding or drop-off event;
- app reports old coordinates as live;
- malicious file upload;
- notification exposes child details on a lock screen;
- support staff abuse platform access;
- provider or dependency compromise;
- log, analytics, crash report, or backup leaks sensitive data;
- denial of service through location ingestion or OTP abuse.

### Authentication

- Invitation-only accounts; no open signup.
- Privileged users use MFA or passkeys.
- Every platform and school administrator signs in as a named individual. Administrative workspaces have no password and shared credentials are forbidden.
- Successful identity authentication does not by itself grant privileged operation: the operator must also hold a valid workspace lease.
- Record login or lease-acquired time, last activity, logout or release time, and release reason against the named operator and session.
- Passwords, if used, are Argon2id hashes.
- Access tokens are short-lived; refresh tokens rotate and support reuse detection.
- Mobile credentials live in the OS keystore. Web sessions use secure, `HttpOnly`, `SameSite` cookies with CSRF protection where applicable.
- Recovery, invitation, and OTP flows are short-lived, single-use, rate-limited, replay-resistant, and non-enumerating.
- Session revocation immediately closes realtime connections and stops access to cached sensitive data.

### Authorization

- Deny by default.
- Centralize policy evaluation.
- Require a valid, current privileged lease for every platform- or school-administration command and privileged socket subscription.
- Derive school membership and workspace scope server-side. School administrators may create or invite users only for their own school and cannot grant platform roles.
- Make lease acquisition atomic in PostgreSQL and test it with real concurrent transactions. Do not depend on a UI guard or a Redis-only mutex.
- Check function-level and object-level authorization.
- Enforce tenant scope in API services and PostgreSQL RLS.
- Allowlist writable fields; never bind request bodies directly to database models.
- Reauthorize socket subscriptions and notification recipients.
- Require reauthentication and explicit reason for sensitive changes and support access.
- Include negative tests for every read and write endpoint.

### Data protection and privacy

- Maintain a data inventory and purpose for every personal field.
- Collect the minimum data required for transport safety.
- Obtain and version appropriate school, guardian, staff, and location consent or lawful-basis records.
- Define retention separately for event history, precise GPS, notification delivery, audit, support, and backups.
- Encrypt in transit and at rest; use a managed key and secret service.
- Redact child names, phone numbers, tokens, OTPs, coordinates, and provider payloads from logs.
- Keep analytics de-identified and separated from operational records.
- Use private object storage and short-lived signed URLs.
- Build access, correction, export, restriction, and deletion procedures with legal review.
- Review applicable children's privacy, data protection, employment monitoring, data residency, cross-border transfer, and breach-notification law with qualified counsel before launch.

### Mobile controls

- Use SecureStore or native keystore/keychain for credentials.
- Do not store sensitive data in AsyncStorage, external storage, clipboard, screenshots, or notifications.
- Minimize and encrypt offline content where supported.
- Clear sensitive cached data on sign-out, restriction, assignment removal, and expiry.
- Use TLS only; do not disable certificate validation. Consider pinning only with a tested rotation and recovery design.
- Detect rooted or compromised devices as a risk signal; do not rely on detection as the sole control.
- Disable verbose production logging and developer menus.
- Protect deep links and validate all parameters server-side.

### Infrastructure and supply chain

- Separate development, staging, and production accounts, databases, keys, and domains.
- Use least-privilege IAM and short-lived CI identity federation.
- Keep secrets in a managed secret store and rotate them.
- Pin dependencies and CI actions, generate an SBOM, and scan code, secrets, dependencies, containers, and infrastructure.
- Run minimal non-root containers, apply network controls, and expose only required services.
- Encrypt backups, restrict them separately, and test restores.
- Sign builds and protect app-store, DNS, cloud, and source-control administration with MFA.
- Patch critical vulnerabilities under a documented SLA and maintain a disclosure channel.

## Observability

All services and workers emit structured logs, metrics, and distributed traces with a shared correlation ID. W3C trace context propagates across HTTP calls and broker messages, so that a single request or trip event can be followed across services. Logging must use a central redaction layer, provided by `packages/observability`.

Monitor:

- per-service health, readiness, error rate, and latency, plus internal-call failure rates between services;
- outbox backlog and age per service, broker queue depth, dead-letter counts, consumer lag, and redelivery rate;
- journal delivery lag from producing services to `audit-service`, and lease-validation latency and failures;

- authentication failures and OTP abuse;
- privileged workspace occupancy, denied concurrent acquisitions, heartbeat age, expiries, releases, revocations, and forced takeovers;
- administrative journal write failures or unexpected gaps;
- authorization denials and tenant-isolation alarms;
- active and completed trips;
- GPS ingestion rate, invalid points, and silent active buses;
- offline queue depth, sync latency, conflicts, and rejected events;
- websocket connections, reconnects, and fan-out latency;
- notification queue time, provider failures, delivery latency, and fallback use;
- API latency, error rate, saturation, and database/Redis health;
- audit pipeline health, retention jobs, backup age, and restore verification.

Alerts must be actionable, severity-based, deduplicated, and connected to a runbook. Never alert with unnecessary child details.

## Reliability and disaster recovery

Define service objectives for the pilot and revise them using field data. At minimum:

- graceful degradation when push, SMS, WhatsApp, map tiles, Redis, the message broker, websocket services, or any single microservice fail;
- persisted events remain authoritative when realtime is unavailable, and outbox backlogs drain without loss when the broker recovers;
- privileged administration fails closed when `administration-service` or `identity-service` is unavailable, while active trips continue in `trip-service` and on the driver device;
- each service has its own health checks, autoscaling limits, timeouts, retries with backoff, and circuit breakers on synchronous dependencies;
- the driver continues core trip actions offline;
- queues use bounded retries and dead-letter handling;
- deployments support health checks, backward-compatible migrations, rollback, and drain behavior;
- backups have explicit retention, RPO, and RTO;
- restore tests are scheduled and evidenced.

Printed manifests and school emergency procedures remain operational fallbacks.

## Testing strategy

Use a test pyramid. Domain and policy coverage is strong. Each service has integration tests against its own database and the broker. Consumer-driven contract tests cover every internal API and event between services. A focused set of full end-to-end journeys runs through the gateway against the composed system.

Every role-sensitive endpoint needs positive and negative authorization tests. Generate tests that deliberately substitute another school's ID, another child's ID, another trip's ID, stale sessions, expired invitations, revoked assignments, and restricted relationships.

Critical scenarios:

- concurrent acquisition by two platform operators yields exactly one valid lease;
- concurrent acquisition by two administrators of the same school yields exactly one valid lease, while different schools remain independent;
- logout, idle timeout, missed heartbeat, revocation, and operator suspension remove privileged access;
- a second device cannot reuse another session's lease and a lost lease immediately blocks commands and socket access;
- a stale lease holder's delayed command is rejected by its fencing token in every downstream service;
- privileged commands fail closed when lease validation or session introspection is unavailable;
- a broker outage or duplicate delivery neither loses nor duplicates journal records, transport events, or notifications;
- provisioning and invitation sagas complete or compensate after a partial failure;
- manual school provisioning and school-scoped user creation are fully journaled under the correct named operator;
- a school administrator cannot choose another tenant, assign a platform role, or alter the administrative journal;
- morning and afternoon happy paths;
- offline event queue across restart;
- duplicate and out-of-order events;
- incorrect state transition;
- end-trip blocked with onboard child;
- guardian restriction during active viewing;
- websocket revocation;
- stale bus location;
- fallback notification deduplication;
- correction event and recomputed projection;
- low-cost Android background location with screen locked;
- backup restore and production rollback.

Test fixtures must be synthetic and clearly fictional.

## Environments and configuration

Use typed configuration validated at process startup. No code path may silently fall back to an insecure production default.

Environment classes:

- local: Docker Compose providers and fake notification adapters;
- test: isolated databases and deterministic clocks/providers;
- staging: production-like infrastructure with synthetic data;
- production: approved providers, protected secrets, monitoring, backups, and change controls.

Document every variable by name, purpose, sensitivity, example shape, owner, and rotation method. Never commit actual values.

## Delivery and change management

Use trunk-based development or short-lived branches with protected mainline reviews. Require:

- passing format, lint, type, unit, integration, and policy tests;
- migration safety checks;
- secret, dependency, container, and IaC scans;
- review for authorization, child privacy, location, authentication, and event-model changes;
- staging deployment and smoke tests;
- explicit approval and rollback plan for production.

Use expand-and-contract database migrations. Deploy backward-compatible schema changes before code that depends on them. Destructive cleanup happens only after verification and backup.

## Indicative delivery roadmap

The source plan uses a twelve-week target for a small team, with an advised two-to-four-week buffer or a scope reduction if field readiness slips.

- Weeks 1 and 2: stakeholder interviews, concierge validation, exact workflows, role matrix, wireframes, threat model, and baseline parent-call measurement.
- Weeks 3 and 4:
  - service platform: `service-kit`, gateway, broker, outbox and inbox, and per-service databases;
  - identity, administration, and audit services;
  - tenant isolation;
  - core transport data;
  - local infrastructure;
  - a one-hour low-cost Android background-GPS spike.

  The microservice platform adds scaffolding and operational work to this window. Track it explicitly and use the buffer rather than cutting safety scope.
- Weeks 5 and 6: driver trip flow, offline outbox, idempotent synchronization, boarding and drop-off events, child sweep, and incident action.
- Weeks 7 and 8: realtime position ingestion, school map, guardian trip status, freshness indicators, and silent-bus alerts.
- Weeks 9 and 10: event-driven notifications, fallback channels, absence declaration, history, and failure handling.
- Week 11: simulated routes, poor-network tests, battery tests, device tests, permission and authorization tests, recovery drills, and training rehearsal.
- Week 12: school onboarding, live pilot launch, trip shadowing, support coverage, and structured feedback.

Do not protect the calendar by hiding defects or weakening safety. Cut limited history and non-essential reporting before cutting authorization, offline operation, stale-data handling, auditability, or the end-of-trip sweep.

## Coding standards

- TypeScript strict mode; avoid `any`, unsafe casts, and non-null assertions.
- Small domain functions with explicit inputs and outputs.
- UTC internally; convert using the school's IANA timezone at the boundary.
- Use decimal or integer minor units for money, never floating point.
- Use UUIDs and database constraints, not client trust.
- Never log raw request bodies by default.
- Use dependency injection for time, UUID, provider, and network behavior in tests.
- Prefer named domain concepts over generic utility layers.
- Comment why a safety or security constraint exists; do not narrate obvious code.
- Keep generated API types and migrations under version control.

## User interface standards

- Role-specific home screens must expose only relevant tasks.
- Driver screens use large targets and short actions intended for use while stopped.
- All map views show freshness and offline state.
- All local mutations show pending, accepted, rejected, or conflict state.
- Accessibility is required: contrast, labels, dynamic text, screen reader order, web keyboard access, focus management, and reduced motion.
- Localize text and formats; do not concatenate translated phrases.
- Sensitive values are masked where full display is unnecessary.
- Error messages tell the user what to do without leaking internals.

## Pilot operations

Before launch:

- identify a school pilot champion;
- train administrators and drivers in the languages they use;
- verify mounts, chargers, mobile data, permissions, battery settings, and supported devices;
- perform a shadow route and capture stop coordinates;
- record baseline transport-call volume;
- agree absence, wrong-bus, unlisted-child, no-recipient, restricted-contact, incident, and offline-bus procedures;
- print manifests and emergency contacts;
- define support ownership during morning and afternoon windows;
- agree go, fix, and stop thresholds.

During the pilot, record software defects and operational problems separately. Review them weekly with an owner and due date.

## Success metrics

Measure:

- scheduled trip start and completion rate;
- GPS availability during active trips;
- boarding and drop-off accuracy;
- false notification rate;
- notification latency and delivery rate;
- driver actions missed or corrected per trip;
- offline event count and synchronization delay;
- battery and mobile data consumed per trip;
- stale-location incidents;
- support requests and transport-call reduction;
- guardian engagement;
- school willingness to continue and pay.

Initial hypotheses from the specification are at least 90 percent trip completion, at least 95 percent GPS availability during active trip time, 95 percent of notifications within 30 seconds, zero incorrect boarding notifications caused by system faults, and at least 80 percent driver adoption by pilot week two. Treat these as pilot hypotheses, not guaranteed production SLAs.

## Out of scope for the MVP

- full school ERP;
- grades and homework;
- accounting;
- transport payment collection;
- general parent-school chat;
- school entrance attendance integration;
- QR, NFC, RFID, or automated child identification;
- advanced route optimization or predictive ETA;
- dedicated hardware as a hard dependency;
- AI features;
- broad enterprise analytics;
- national-scale rollout.

Architectural extension points may exist, but no out-of-scope feature should complicate or delay the pilot workflow.

## Decisions still requiring owner input

These do not block local development when adapters and safe defaults are used, but they must be resolved before production:

- deployment country and qualified legal review;
- school versus transport-operator contracting and data roles;
- hosting region and cross-border transfer position;
- identity method and OTP provider;
- platform and school operator approval, suspension, forced-revocation, and emergency-takeover policy;
- exact privileged heartbeat, lease-expiry, and idle-timeout values after pilot validation;
- push, SMS, WhatsApp, email, map tile, and object-storage providers;
- message broker hosting (default: RabbitMQ on Amazon MQ) and whether pilot service databases share one PostgreSQL cluster;
- on-call ownership per service and acceptable operating cost for running the microservice fleet during the pilot;
- school policy for no recipient at an afternoon stop;
- required guardian pickup verification;
- precise retention periods by data category;
- privileged support-access approval owner;
- pilot service hours, escalation contacts, and response targets;
- production SLO, RPO, and RTO;
- pricing and who supplies driver phones and mobile data.

Record each decision in an ADR, policy, or operations document rather than leaving it in chat history.

## Definition of a production-quality change

A change is complete when:

- requirements and acceptance behavior are clear;
- domain and authorization implications are reviewed;
- schema changes have safe migrations and rollback consideration;
- code is typed, validated, observable, and free of secrets;
- positive, negative, failure, and cross-tenant tests pass;
- offline and realtime behavior are covered where relevant;
- accessibility and privacy are reviewed;
- documentation and runbooks are updated;
- staging behavior is verified with synthetic data;
- the result can be operated and recovered by someone other than the author.

For the identity and administration foundation specifically, production quality also requires evidence of all of the following:

- platform operators alone can manually create school workspaces;
- school operators create users only inside their school;
- the one-active-operator invariant survives concurrent requests, process restarts, and service redeployments;
- stale leases recover safely, and stale holders are fenced out of every service;
- all privileged session and mutation history is append-only, attributable to a named individual, and delivered to `audit-service` without loss.

For any cross-service change, it also requires updated contracts, passing contract tests, and backward compatibility with the currently deployed versions of dependent services.

## Guidance for AI assistants

Read this file before planning or modifying Aegis. Treat repository code and tests as evidence, not assumptions. Never invent provider behavior, credentials, test results, legal conclusions, or deployment success. Preserve unrelated user work. Keep changes scoped and reviewable. When uncertainty does not affect safety or irreversible architecture, choose the smallest safe option, document it, and continue. When it does affect safety, privacy, legal duties, data ownership, or an irreversible design, stop and request an owner decision.

## Security references

- [OWASP Application Security Verification Standard](https://owasp.org/projects/asvs?tab=main)
- [OWASP Mobile Application Security Verification Standard](https://mas.owasp.org/MASVS/)
- [OWASP API Security Top 10 2023](https://api-security.owasp.org/editions/2023/en/0x00-header/)
- [NIST Secure Software Development Framework SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final)
- [Expo Location documentation](https://docs.expo.dev/versions/latest/sdk/location/)
- [Expo TaskManager documentation](https://docs.expo.dev/versions/latest/sdk/task-manager/)

These references are baselines, not certifications. Recheck versions and applicable requirements before each production release.
