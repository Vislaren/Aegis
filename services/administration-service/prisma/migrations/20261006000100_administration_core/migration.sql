-- administration-service: core tenancy, workspace, membership, role, and lease tables.
-- Reviewed SQL. Constraints encode safety invariants so they hold even if application code errs.

CREATE TABLE roles (
  key          text PRIMARY KEY,
  scope        text NOT NULL CHECK (scope IN ('PLATFORM', 'SCHOOL')),
  privileged   boolean NOT NULL,
  feature_flag text,
  UNIQUE (key, scope)
);

INSERT INTO roles (key, scope, privileged, feature_flag) VALUES
  ('PLATFORM_ADMIN',    'PLATFORM', true,  NULL),
  ('SCHOOL_ADMIN',      'SCHOOL',   true,  NULL),
  ('DRIVER',            'SCHOOL',   false, NULL),
  ('GUARDIAN',          'SCHOOL',   false, NULL),
  ('TRANSPORT_MANAGER', 'SCHOOL',   false, 'role.transport_manager'),
  ('DISPATCHER',        'SCHOOL',   false, 'role.dispatcher'),
  ('BUS_ATTENDANT',     'SCHOOL',   false, 'role.bus_attendant');

-- Exactly one global platform administration workspace.
CREATE TABLE platform_administration_workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  singleton  boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_administration_workspaces (name) VALUES ('Aegis platform administration');

CREATE TABLE platform_admin_operator_profiles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES platform_administration_workspaces (id),
  user_id               uuid NOT NULL,
  display_name          text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  contact_masked        text NOT NULL,
  status                text NOT NULL CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED')),
  invitation_request_id uuid UNIQUE,
  created_by_user_id    uuid,
  effective_from        timestamptz NOT NULL DEFAULT now(),
  effective_to          timestamptz,
  activated_at          timestamptz,
  status_reason         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

CREATE TABLE schools (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(name) BETWEEN 3 AND 160),
  slug               text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status             text NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  timezone           text NOT NULL,
  country_code       text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  default_language   text NOT NULL,
  created_by_user_id uuid,
  status_reason      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE school_settings (
  school_id                        uuid PRIMARY KEY REFERENCES schools (id),
  stale_location_threshold_seconds integer NOT NULL DEFAULT 60 CHECK (stale_location_threshold_seconds BETWEEN 15 AND 900),
  absence_cutoff_minutes           integer NOT NULL DEFAULT 30 CHECK (absence_cutoff_minutes BETWEEN 0 AND 1440),
  gps_retention_days               integer NOT NULL DEFAULT 30 CHECK (gps_retention_days BETWEEN 1 AND 365),
  notification_retention_days      integer NOT NULL DEFAULT 90 CHECK (notification_retention_days BETWEEN 1 AND 730),
  support_email                    text,
  support_phone                    text,
  updated_at                       timestamptz NOT NULL DEFAULT now()
);

-- Exactly one administration workspace per school.
CREATE TABLE school_administration_workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL UNIQUE REFERENCES schools (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, school_id)
);

CREATE TABLE school_admin_operator_profiles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL,
  school_id             uuid NOT NULL REFERENCES schools (id),
  user_id               uuid NOT NULL,
  display_name          text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  contact_masked        text NOT NULL,
  status                text NOT NULL CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED')),
  invitation_request_id uuid UNIQUE,
  created_by_user_id    uuid,
  effective_from        timestamptz NOT NULL DEFAULT now(),
  effective_to          timestamptz,
  activated_at          timestamptz,
  status_reason         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id),
  -- The workspace must belong to the same school as the profile.
  FOREIGN KEY (workspace_id, school_id) REFERENCES school_administration_workspaces (id, school_id)
);

CREATE TABLE school_memberships (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             uuid NOT NULL REFERENCES schools (id),
  user_id               uuid NOT NULL,
  display_name          text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  contact_masked        text NOT NULL,
  status                text NOT NULL CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED')),
  invitation_request_id uuid UNIQUE,
  created_by_user_id    uuid,
  activated_at          timestamptz,
  status_reason         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, user_id),
  UNIQUE (id, school_id)
);
CREATE INDEX school_memberships_user_idx ON school_memberships (user_id);

CREATE TABLE role_assignments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  school_id          uuid REFERENCES schools (id),
  membership_id      uuid,
  role_key           text NOT NULL,
  role_scope         text NOT NULL,
  status             text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  granted_by_user_id uuid,
  granted_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  revoked_by_user_id uuid,
  -- The role's scope must match the assignment's shape: a platform role can never be bound to a
  -- school, and a school role can never exist without a school membership.
  FOREIGN KEY (role_key, role_scope) REFERENCES roles (key, scope),
  FOREIGN KEY (membership_id, school_id) REFERENCES school_memberships (id, school_id),
  CHECK ((role_scope = 'PLATFORM') = (school_id IS NULL)),
  CHECK ((school_id IS NULL) = (membership_id IS NULL)),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX role_assignments_active_unique
  ON role_assignments (user_id, school_id, role_key) NULLS NOT DISTINCT
  WHERE status = 'ACTIVE';
CREATE INDEX role_assignments_membership_idx ON role_assignments (membership_id);

CREATE TABLE feature_flags (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                text NOT NULL CHECK (key ~ '^[a-z0-9_.]+$'),
  school_id          uuid REFERENCES schools (id),
  enabled            boolean NOT NULL,
  updated_by_user_id uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (key, school_id)
);

-- One row per administration workspace: the authoritative privileged-access lock.
CREATE TABLE privileged_access_leases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_type        text NOT NULL CHECK (workspace_type IN ('PLATFORM', 'SCHOOL')),
  workspace_id          uuid NOT NULL,
  school_id             uuid REFERENCES schools (id),
  status                text NOT NULL CHECK (status IN ('VACANT', 'ACTIVE', 'RELEASED', 'EXPIRED', 'REVOKED')),
  grant_id              uuid UNIQUE,
  -- Strictly increases with every new grant; downstream services reject lower tokens.
  fencing_token         bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  version               integer NOT NULL DEFAULT 0,
  owner_user_id         uuid,
  operator_profile_id   uuid,
  operator_display_name text,
  session_id            uuid,
  acquired_at           timestamptz,
  heartbeat_at          timestamptz,
  last_activity_at      timestamptz,
  expires_at            timestamptz,
  idle_expires_at       timestamptz,
  released_at           timestamptz,
  release_reason        text,
  released_by_user_id   uuid,
  takeover_of_grant_id  uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_type, workspace_id),
  CHECK ((workspace_type = 'PLATFORM') = (school_id IS NULL)),
  CHECK (
    status <> 'ACTIVE' OR (
      grant_id IS NOT NULL AND session_id IS NOT NULL AND owner_user_id IS NOT NULL
      AND operator_profile_id IS NOT NULL AND expires_at IS NOT NULL AND idle_expires_at IS NOT NULL
      AND fencing_token > 0
    )
  )
);
-- The platform workspace's lock row exists from the start; school rows are created at provisioning.
INSERT INTO privileged_access_leases (workspace_type, workspace_id, school_id, status)
SELECT 'PLATFORM', id, NULL, 'VACANT' FROM platform_administration_workspaces;

CREATE INDEX privileged_access_leases_session_idx ON privileged_access_leases (session_id) WHERE status = 'ACTIVE';

CREATE TABLE privileged_session_history (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_type        text NOT NULL CHECK (workspace_type IN ('PLATFORM', 'SCHOOL')),
  workspace_id          uuid NOT NULL,
  school_id             uuid REFERENCES schools (id),
  user_id               uuid NOT NULL,
  operator_profile_id   uuid,
  operator_display_name text,
  session_id            uuid NOT NULL,
  grant_id              uuid,
  fencing_token         bigint,
  outcome               text NOT NULL CHECK (outcome IN ('GRANTED', 'TAKEOVER', 'DENIED_IN_USE', 'DENIED_POLICY')),
  attempted_at          timestamptz NOT NULL DEFAULT now(),
  acquired_at           timestamptz,
  last_active_at        timestamptz,
  ended_at              timestamptz,
  end_reason            text,
  source_ip             text,
  user_agent            text,
  correlation_id        text NOT NULL,
  risk_signals          jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK ((workspace_type = 'PLATFORM') = (school_id IS NULL)),
  CHECK (outcome NOT IN ('GRANTED', 'TAKEOVER') OR (grant_id IS NOT NULL AND acquired_at IS NOT NULL))
);
CREATE INDEX privileged_session_history_workspace_idx ON privileged_session_history (workspace_type, workspace_id, attempted_at DESC, id DESC);
CREATE INDEX privileged_session_history_grant_idx ON privileged_session_history (grant_id);

CREATE TABLE idempotency_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id   uuid NOT NULL,
  key             text NOT NULL,
  operation       text NOT NULL,
  request_hash    text NOT NULL,
  response_status integer NOT NULL,
  response_body   jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, key)
);

-- Workflow implemented in a later phase; the table exists so grants are reviewable and audited.
CREATE TABLE support_access_grants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id            uuid NOT NULL REFERENCES schools (id),
  requested_by_user_id uuid NOT NULL,
  approved_by_user_id  uuid,
  reason               text NOT NULL CHECK (length(reason) >= 10),
  scope                text NOT NULL,
  status               text NOT NULL CHECK (status IN ('REQUESTED', 'APPROVED', 'ACTIVE', 'EXPIRED', 'REVOKED', 'REJECTED')),
  starts_at            timestamptz,
  expires_at           timestamptz,
  revoked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> requested_by_user_id),
  CHECK (expires_at IS NULL OR starts_at IS NULL OR expires_at > starts_at)
);

-- Transactional outbox and idempotent inbox (shared shape, see packages/service-kit).
CREATE TABLE outbox_messages (
  id              uuid PRIMARY KEY,
  routing_key     text NOT NULL,
  envelope        jsonb NOT NULL,
  priority        smallint NOT NULL DEFAULT 5,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'DEAD')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);
CREATE INDEX outbox_messages_pending_idx ON outbox_messages (priority, created_at) WHERE status = 'PENDING';

CREATE TABLE inbox_messages (
  event_id    uuid NOT NULL,
  consumer    text NOT NULL,
  event_type  text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);
