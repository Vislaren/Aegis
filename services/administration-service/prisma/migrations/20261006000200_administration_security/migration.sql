-- administration-service: runtime role grants, row-level security, and append-only protections.
--
-- Runtime connections use the login role `administration_app` (NOBYPASSRLS, not the owner),
-- created by infrastructure. Every request runs in a transaction that sets:
--   aegis.context   'platform' | 'school' | 'user' | 'system'
--   aegis.school_id tenant UUID or ''
--   aegis.user_id   acting user UUID or ''
-- with set_config(..., true), so values never outlive the transaction.

CREATE FUNCTION aegis_ctx() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('aegis.context', true), ''), 'none') $$;
CREATE FUNCTION aegis_school() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('aegis.school_id', true), '')::uuid $$;
CREATE FUNCTION aegis_user() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('aegis.user_id', true), '')::uuid $$;

-- ---------- Grants (least privilege; no DELETE on safety or audit-relevant tables) ----------
GRANT USAGE ON SCHEMA public TO administration_app;
GRANT SELECT ON roles, platform_administration_workspaces TO administration_app;
GRANT SELECT, INSERT, UPDATE ON
  platform_admin_operator_profiles, schools, school_settings, school_administration_workspaces,
  school_admin_operator_profiles, school_memberships, role_assignments, feature_flags,
  privileged_access_leases, privileged_session_history, support_access_grants,
  outbox_messages TO administration_app;
GRANT SELECT, INSERT ON inbox_messages TO administration_app;
GRANT SELECT, INSERT, DELETE ON idempotency_records TO administration_app;
GRANT EXECUTE ON FUNCTION aegis_ctx(), aegis_school(), aegis_user() TO administration_app;

-- ---------- Row-level security ----------
ALTER TABLE schools                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_settings                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_administration_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_admin_operator_profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_memberships               ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignments                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_operator_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flags                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE privileged_access_leases         ENABLE ROW LEVEL SECURITY;
ALTER TABLE privileged_session_history       ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records              ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access_grants            ENABLE ROW LEVEL SECURITY;

-- Schools: the tenant itself, the platform registry, or schools where the user holds a membership.
CREATE POLICY schools_read ON schools FOR SELECT USING (
  id = aegis_school()
  OR aegis_ctx() = 'platform'
  OR id IN (SELECT m.school_id FROM school_memberships m WHERE m.user_id = aegis_user())
);
CREATE POLICY schools_platform_insert ON schools FOR INSERT WITH CHECK (aegis_ctx() = 'platform');
CREATE POLICY schools_platform_update ON schools FOR UPDATE
  USING (aegis_ctx() = 'platform') WITH CHECK (aegis_ctx() = 'platform');

CREATE POLICY school_settings_tenant ON school_settings
  USING (school_id = aegis_school()) WITH CHECK (school_id = aegis_school());

CREATE POLICY school_workspaces_tenant ON school_administration_workspaces
  USING (school_id = aegis_school()) WITH CHECK (school_id = aegis_school());

CREATE POLICY school_operators_read ON school_admin_operator_profiles FOR SELECT
  USING (school_id = aegis_school() OR user_id = aegis_user());
CREATE POLICY school_operators_write ON school_admin_operator_profiles FOR INSERT
  WITH CHECK (school_id = aegis_school());
CREATE POLICY school_operators_update ON school_admin_operator_profiles FOR UPDATE
  USING (school_id = aegis_school()) WITH CHECK (school_id = aegis_school());

CREATE POLICY memberships_read ON school_memberships FOR SELECT
  USING (school_id = aegis_school() OR user_id = aegis_user());
CREATE POLICY memberships_insert ON school_memberships FOR INSERT
  WITH CHECK (school_id = aegis_school());
CREATE POLICY memberships_update ON school_memberships FOR UPDATE
  USING (school_id = aegis_school()) WITH CHECK (school_id = aegis_school());

CREATE POLICY role_assignments_read ON role_assignments FOR SELECT USING (
  school_id = aegis_school()
  OR user_id = aegis_user()
  OR (school_id IS NULL AND aegis_ctx() = 'platform')
);
-- A school context can only ever write school-scoped assignments for its own tenant; only the
-- platform context can write the (school_id IS NULL) platform role.
CREATE POLICY role_assignments_insert ON role_assignments FOR INSERT WITH CHECK (
  (school_id IS NOT NULL AND school_id = aegis_school())
  OR (school_id IS NULL AND aegis_ctx() = 'platform')
);
CREATE POLICY role_assignments_update ON role_assignments FOR UPDATE
  USING ((school_id IS NOT NULL AND school_id = aegis_school()) OR (school_id IS NULL AND aegis_ctx() = 'platform'))
  WITH CHECK ((school_id IS NOT NULL AND school_id = aegis_school()) OR (school_id IS NULL AND aegis_ctx() = 'platform'));

CREATE POLICY platform_operators_read ON platform_admin_operator_profiles FOR SELECT
  USING (aegis_ctx() = 'platform' OR user_id = aegis_user());
CREATE POLICY platform_operators_insert ON platform_admin_operator_profiles FOR INSERT
  WITH CHECK (aegis_ctx() = 'platform');
CREATE POLICY platform_operators_update ON platform_admin_operator_profiles FOR UPDATE
  USING (aegis_ctx() = 'platform') WITH CHECK (aegis_ctx() = 'platform');

CREATE POLICY feature_flags_read ON feature_flags FOR SELECT
  USING (school_id IS NULL OR school_id = aegis_school());
CREATE POLICY feature_flags_platform_write ON feature_flags FOR INSERT
  WITH CHECK (aegis_ctx() = 'platform');
CREATE POLICY feature_flags_platform_update ON feature_flags FOR UPDATE
  USING (aegis_ctx() = 'platform') WITH CHECK (aegis_ctx() = 'platform');

-- Leases and privileged history: the workspace's own tenant, the platform context for the
-- platform workspace, or the owning user (logout / session-revocation cleanup).
CREATE POLICY leases_access ON privileged_access_leases
  USING (
    (school_id IS NOT NULL AND school_id = aegis_school())
    OR (school_id IS NULL AND aegis_ctx() = 'platform')
    OR owner_user_id = aegis_user()
  )
  WITH CHECK (
    (school_id IS NOT NULL AND school_id = aegis_school())
    OR (school_id IS NULL AND aegis_ctx() = 'platform')
    OR owner_user_id = aegis_user()
  );

CREATE POLICY session_history_read ON privileged_session_history FOR SELECT USING (
  (school_id IS NOT NULL AND school_id = aegis_school())
  OR (school_id IS NULL AND aegis_ctx() = 'platform')
  OR user_id = aegis_user()
);
CREATE POLICY session_history_insert ON privileged_session_history FOR INSERT WITH CHECK (
  (school_id IS NOT NULL AND school_id = aegis_school())
  OR (school_id IS NULL AND aegis_ctx() = 'platform')
);
CREATE POLICY session_history_update ON privileged_session_history FOR UPDATE
  USING (
    (school_id IS NOT NULL AND school_id = aegis_school())
    OR (school_id IS NULL AND aegis_ctx() = 'platform')
    OR user_id = aegis_user()
  );

CREATE POLICY idempotency_own ON idempotency_records
  USING (actor_user_id = aegis_user()) WITH CHECK (actor_user_id = aegis_user());

CREATE POLICY support_grants_access ON support_access_grants
  USING (school_id = aegis_school() OR aegis_ctx() = 'platform')
  WITH CHECK (aegis_ctx() = 'platform');

-- ---------- Append-only protections ----------

-- Session history rows are append-only except for closing lifecycle fields exactly once.
CREATE FUNCTION privileged_session_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'privileged_session_history is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'closed privileged session history cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.workspace_type, NEW.workspace_id, NEW.school_id, NEW.user_id, NEW.operator_profile_id,
      NEW.operator_display_name, NEW.session_id, NEW.grant_id, NEW.fencing_token, NEW.outcome,
      NEW.attempted_at, NEW.acquired_at, NEW.source_ip, NEW.user_agent, NEW.correlation_id, NEW.risk_signals)
     IS DISTINCT FROM
     (OLD.id, OLD.workspace_type, OLD.workspace_id, OLD.school_id, OLD.user_id, OLD.operator_profile_id,
      OLD.operator_display_name, OLD.session_id, OLD.grant_id, OLD.fencing_token, OLD.outcome,
      OLD.attempted_at, OLD.acquired_at, OLD.source_ip, OLD.user_agent, OLD.correlation_id, OLD.risk_signals) THEN
    RAISE EXCEPTION 'only lifecycle fields of privileged session history may change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER privileged_session_history_guard
  BEFORE UPDATE OR DELETE ON privileged_session_history
  FOR EACH ROW EXECUTE FUNCTION privileged_session_history_guard();

-- Fencing tokens never decrease, and a lease row never moves to another workspace.
CREATE FUNCTION privileged_access_leases_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'privileged access leases cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.fencing_token < OLD.fencing_token THEN
    RAISE EXCEPTION 'fencing token must not decrease' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.workspace_type, NEW.workspace_id, NEW.school_id) IS DISTINCT FROM (OLD.workspace_type, OLD.workspace_id, OLD.school_id) THEN
    RAISE EXCEPTION 'lease workspace is immutable' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER privileged_access_leases_guard
  BEFORE UPDATE OR DELETE ON privileged_access_leases
  FOR EACH ROW EXECUTE FUNCTION privileged_access_leases_guard();

-- Correctness never depends on this sweeper: every acquisition and validation computes expiry
-- itself. The sweeper only closes stale rows promptly for monitoring and history.
CREATE FUNCTION aegis_sweep_expired_leases() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  swept integer;
BEGIN
  WITH expired AS (
    UPDATE privileged_access_leases
       SET status = 'EXPIRED',
           released_at = now(),
           release_reason = CASE WHEN idle_expires_at <= expires_at THEN 'IDLE_TIMEOUT' ELSE 'HEARTBEAT_EXPIRED' END,
           version = version + 1
     WHERE status = 'ACTIVE' AND (expires_at <= now() OR idle_expires_at <= now())
     RETURNING grant_id, release_reason
  ), closed AS (
    UPDATE privileged_session_history h
       SET ended_at = now(), end_reason = e.release_reason
      FROM expired e
     WHERE h.grant_id = e.grant_id AND h.ended_at IS NULL
     RETURNING h.id
  )
  SELECT count(*) INTO swept FROM expired;
  RETURN swept;
END
$$;
REVOKE ALL ON FUNCTION aegis_sweep_expired_leases() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aegis_sweep_expired_leases() TO administration_app;
