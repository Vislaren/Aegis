-- identity-service: individual identities, verified contacts, authentication factors, sessions,
-- devices, consents, and invitation redemption. No passwords are stored. One-time codes, refresh
-- tokens, invitation tokens, and device identifiers are stored only as keyed hashes; TOTP secrets
-- are encrypted at the application layer (AES-256-GCM).

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name       text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  email              text UNIQUE CHECK (email IS NULL OR (email = lower(email) AND email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$')),
  phone_e164         text UNIQUE CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email_verified_at  timestamptz,
  phone_verified_at  timestamptz,
  status             text NOT NULL CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED')),
  -- Set when the person is invited as an administration operator: MFA becomes mandatory.
  requires_mfa       boolean NOT NULL DEFAULT false,
  preferred_language text NOT NULL DEFAULT 'en' CHECK (preferred_language ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL)
);

CREATE TABLE auth_factors (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id),
  type              text NOT NULL CHECK (type IN ('TOTP')),
  secret_ciphertext text NOT NULL,
  status            text NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED')),
  -- Highest accepted TOTP time step; a code for the same or an earlier step is a replay.
  last_used_step    bigint,
  created_at        timestamptz NOT NULL DEFAULT now(),
  activated_at      timestamptz,
  revoked_at        timestamptz
);
CREATE UNIQUE INDEX auth_factors_one_live_per_type ON auth_factors (user_id, type) WHERE status IN ('PENDING', 'ACTIVE');

CREATE TABLE invitations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_request_id uuid NOT NULL UNIQUE,
  user_id               uuid NOT NULL REFERENCES users (id),
  school_id             uuid,
  school_name           text,
  kind                  text NOT NULL CHECK (kind IN ('PLATFORM_OPERATOR', 'SCHOOL_OPERATOR', 'SCHOOL_MEMBER')),
  role                  text NOT NULL,
  token_hash            text NOT NULL UNIQUE,
  status                text NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED')),
  expires_at            timestamptz NOT NULL,
  delivered_at          timestamptz,
  accepted_at           timestamptz,
  revoked_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'ACCEPTED') = (accepted_at IS NOT NULL))
);
CREATE INDEX invitations_user_idx ON invitations (user_id);

CREATE TABLE otp_challenges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES users (id),
  purpose          text NOT NULL CHECK (purpose IN ('LOGIN', 'INVITATION')),
  channel          text NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  destination_hash text NOT NULL,
  code_hash        text NOT NULL,
  -- False for unknown or ineligible identifiers: the challenge exists only so responses are uniform.
  deliverable      boolean NOT NULL,
  invitation_id    uuid REFERENCES invitations (id),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,
  created_ip       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT deliverable OR user_id IS NOT NULL),
  CHECK (purpose <> 'INVITATION' OR invitation_id IS NOT NULL OR NOT deliverable)
);
CREATE INDEX otp_challenges_destination_idx ON otp_challenges (destination_hash, created_at DESC);

CREATE TABLE trusted_devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id),
  device_id_hash text NOT NULL,
  platform       text NOT NULL CHECK (platform IN ('web', 'ios', 'android')),
  device_name    text,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  UNIQUE (user_id, device_id_hash)
);

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id),
  status              text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  aal                 smallint NOT NULL CHECK (aal IN (1, 2)),
  authenticated_at    timestamptz NOT NULL,
  mfa_verified_at     timestamptz,
  -- Consecutive failed MFA codes in this session; the session is revoked at the limit.
  mfa_failures        smallint NOT NULL DEFAULT 0 CHECK (mfa_failures >= 0),
  client_type         text NOT NULL CHECK (client_type IN ('WEB', 'NATIVE')),
  platform            text NOT NULL CHECK (platform IN ('web', 'ios', 'android')),
  trusted_device_id   uuid REFERENCES trusted_devices (id),
  device_name         text,
  user_agent          text,
  ip                  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoke_reason       text,
  CHECK (aal = 1 OR mfa_verified_at IS NOT NULL),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE INDEX sessions_user_idx ON sessions (user_id, status);

CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions (id),
  token_hash text NOT NULL UNIQUE,
  parent_id  uuid REFERENCES refresh_tokens (id),
  status     text NOT NULL CHECK (status IN ('ACTIVE', 'ROTATED', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id);

-- Consent and policy acknowledgements are append-only evidence.
CREATE TABLE consent_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id),
  document_type    text NOT NULL CHECK (document_type IN ('PRIVACY_NOTICE', 'TERMS_OF_USE', 'LOCATION_PROCESSING')),
  document_version text NOT NULL,
  accepted_at      timestamptz NOT NULL DEFAULT now(),
  ip               text,
  user_agent       text
);
CREATE INDEX consent_records_user_idx ON consent_records (user_id, accepted_at DESC);

CREATE FUNCTION consent_records_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'consent_records is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER consent_records_append_only BEFORE UPDATE OR DELETE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION consent_records_append_only();

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

-- ---------- Runtime role grants (no DELETE anywhere) ----------
GRANT USAGE ON SCHEMA public TO identity_app;
GRANT SELECT, INSERT, UPDATE ON users, auth_factors, invitations, otp_challenges, trusted_devices,
  sessions, refresh_tokens, outbox_messages TO identity_app;
GRANT SELECT, INSERT ON consent_records, inbox_messages TO identity_app;
