-- Local development only. Creates one database per service with two roles each:
--   <service>_owner : owns the database and runs migrations (never used by the running service)
--   <service>_app   : runtime login, NOBYPASSRLS, granted DML by the migrations
-- Deployed environments create the same role names through infrastructure automation with
-- secrets from the managed secret store (docs/operations/database-roles.md).

DO $$
DECLARE
  svc text;
BEGIN
  FOREACH svc IN ARRAY ARRAY['identity', 'administration', 'audit'] LOOP
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEROLE NOBYPASSRLS', svc || '_owner', svc || '_owner_dev');
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS', svc || '_app', svc || '_app_dev');
  END LOOP;
END
$$;

CREATE DATABASE aegis_identity OWNER identity_owner;
CREATE DATABASE aegis_administration OWNER administration_owner;
CREATE DATABASE aegis_audit OWNER audit_owner;

-- Integration-test databases (recreated by the test harness through migrations).
CREATE DATABASE aegis_identity_test OWNER identity_owner;
CREATE DATABASE aegis_administration_test OWNER administration_owner;
CREATE DATABASE aegis_audit_test OWNER audit_owner;

REVOKE ALL ON DATABASE aegis_identity, aegis_administration, aegis_audit,
                       aegis_identity_test, aegis_administration_test, aegis_audit_test FROM PUBLIC;

GRANT CONNECT ON DATABASE aegis_identity, aegis_identity_test TO identity_app;
GRANT CONNECT ON DATABASE aegis_administration, aegis_administration_test TO administration_app;
GRANT CONNECT ON DATABASE aegis_audit, aegis_audit_test TO audit_app;

-- The owner roles may create test databases' schemas but no service can reach another's database.
