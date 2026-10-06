-- audit-service: append-only security audit events and the hash-chained administrative activity
-- journal. Records arrive only through the broker from producing services' transactional
-- outboxes. No role can UPDATE or DELETE them, and each journal chain (one per administration
-- workspace) is tamper-evident: every entry commits to the previous entry's hash.

CREATE FUNCTION aegis_ctx() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('aegis.context', true), ''), 'none') $$;
CREATE FUNCTION aegis_school() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('aegis.school_id', true), '')::uuid $$;
CREATE FUNCTION aegis_user() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('aegis.user_id', true), '')::uuid $$;

CREATE TABLE audit_events (
  id             uuid PRIMARY KEY,           -- event ID from the producing service (idempotency)
  occurred_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  origin_service text NOT NULL,
  user_id        uuid,
  session_id     uuid,
  school_id      uuid,
  event_type     text NOT NULL CHECK (event_type ~ '^[A-Z_]{3,80}$'),
  outcome        text NOT NULL CHECK (outcome IN ('SUCCESS', 'DENIED', 'FAILED')),
  source_ip      text,
  user_agent     text,
  correlation_id text NOT NULL,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_events_user_idx ON audit_events (user_id, occurred_at DESC, id DESC);

CREATE TABLE activity_journal (
  id                  uuid PRIMARY KEY,      -- event ID from the producing service (idempotency)
  chain_key           text NOT NULL,         -- '<workspace_type>:<workspace_id>'
  chain_position      bigint NOT NULL,
  occurred_at         timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  workspace_type      text NOT NULL CHECK (workspace_type IN ('PLATFORM', 'SCHOOL')),
  workspace_id        uuid NOT NULL,
  school_id           uuid,
  actor_user_id       uuid,
  operator_profile_id uuid,
  session_id          uuid,
  grant_id            uuid,
  fencing_token       bigint,
  origin_service      text NOT NULL,
  action              text NOT NULL CHECK (action ~ '^[A-Z_]{3,80}$'),
  target_type         text NOT NULL,
  target_id           text,
  outcome             text NOT NULL CHECK (outcome IN ('SUCCESS', 'DENIED', 'FAILED')),
  correlation_id      text NOT NULL,
  source_ip           text,
  user_agent          text,
  changes             jsonb NOT NULL,
  prev_hash           text NOT NULL,
  entry_hash          text NOT NULL,
  UNIQUE (chain_key, chain_position),
  CHECK (workspace_type <> 'SCHOOL' OR school_id IS NOT NULL)
);
CREATE INDEX activity_journal_search_idx ON activity_journal (chain_key, occurred_at DESC, id DESC);
CREATE INDEX activity_journal_school_idx ON activity_journal (school_id, occurred_at DESC);

-- Deterministic hash input: fixed field order, UTC timestamps with microseconds, jsonb's
-- canonical text form. Session settings such as TimeZone or DateStyle cannot change it.
CREATE FUNCTION journal_entry_hash(e activity_journal, prev text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    prev,
    e.id::text,
    e.chain_key,
    e.chain_position::text,
    to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    e.workspace_type,
    e.workspace_id::text,
    coalesce(e.school_id::text, ''),
    coalesce(e.actor_user_id::text, ''),
    coalesce(e.operator_profile_id::text, ''),
    coalesce(e.session_id::text, ''),
    coalesce(e.grant_id::text, ''),
    coalesce(e.fencing_token::text, ''),
    e.origin_service,
    e.action,
    e.target_type,
    coalesce(e.target_id, ''),
    e.outcome,
    e.correlation_id,
    e.changes::text
  ), 'UTF8')), 'hex')
$$;

-- Assigns the chain position and hash under a per-chain advisory lock, so concurrent inserts into
-- one chain are serialized and the chain has no forks. SECURITY DEFINER: it must read the previous
-- entry regardless of the inserting session's row-level-security context.
CREATE FUNCTION activity_journal_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  previous record;
BEGIN
  NEW.chain_key := NEW.workspace_type || ':' || NEW.workspace_id::text;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.chain_key, 0));
  SELECT chain_position, entry_hash INTO previous
    FROM activity_journal WHERE chain_key = NEW.chain_key
    ORDER BY chain_position DESC LIMIT 1;
  NEW.chain_position := coalesce(previous.chain_position, 0) + 1;
  NEW.prev_hash := coalesce(previous.entry_hash, repeat('0', 64));
  NEW.recorded_at := now();
  NEW.entry_hash := journal_entry_hash(NEW, NEW.prev_hash);
  RETURN NEW;
END
$$;
CREATE TRIGGER activity_journal_chain BEFORE INSERT ON activity_journal
  FOR EACH ROW EXECUTE FUNCTION activity_journal_chain();

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER activity_journal_append_only BEFORE UPDATE OR DELETE ON activity_journal
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER activity_journal_no_truncate BEFORE TRUNCATE ON activity_journal
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Recomputes a chain from the start. Returns the first broken position, or NULL when intact.
CREATE FUNCTION aegis_verify_journal_chain(p_chain_key text) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  entry activity_journal;
  expected_prev text := repeat('0', 64);
  expected_position bigint := 1;
BEGIN
  FOR entry IN SELECT * FROM activity_journal WHERE chain_key = p_chain_key ORDER BY chain_position LOOP
    IF entry.chain_position <> expected_position
       OR entry.prev_hash <> expected_prev
       OR entry.entry_hash <> journal_entry_hash(entry, entry.prev_hash) THEN
      RETURN entry.chain_position;
    END IF;
    expected_prev := entry.entry_hash;
    expected_position := expected_position + 1;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TABLE inbox_messages (
  event_id    uuid NOT NULL,
  consumer    text NOT NULL,
  event_type  text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);

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

-- ---------- Row-level security ----------
ALTER TABLE activity_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

-- Reading: a school workspace's journal is visible only in that school's context; the platform
-- journal only in the platform context. The platform cannot read school operators' journals.
CREATE POLICY journal_read ON activity_journal FOR SELECT USING (
  (workspace_type = 'SCHOOL' AND school_id = aegis_school())
  OR (workspace_type = 'PLATFORM' AND aegis_ctx() = 'platform')
);
-- Writing: only the event consumer, in the narrow 'system' context. It can insert, never read.
CREATE POLICY journal_insert ON activity_journal FOR INSERT WITH CHECK (aegis_ctx() = 'system');

CREATE POLICY audit_events_read ON audit_events FOR SELECT USING (user_id = aegis_user());
CREATE POLICY audit_events_insert ON audit_events FOR INSERT WITH CHECK (aegis_ctx() = 'system');

GRANT USAGE ON SCHEMA public TO audit_app;
GRANT SELECT, INSERT ON activity_journal, audit_events, inbox_messages TO audit_app;
GRANT SELECT, INSERT, UPDATE ON outbox_messages TO audit_app;
GRANT EXECUTE ON FUNCTION aegis_ctx(), aegis_school(), aegis_user() TO audit_app;
REVOKE ALL ON FUNCTION aegis_verify_journal_chain(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aegis_verify_journal_chain(text) TO audit_app;
