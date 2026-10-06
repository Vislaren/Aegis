# Database roles and provisioning

Each service owns one logical database. For the pilot these may share one PostgreSQL cluster. Each database has two roles:

| Role              | Used by                            | Privileges                                                                                                                                                                                       |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<service>_owner` | The one-shot migration task only   | Owns the database and its objects. Never used by a running service.                                                                                                                              |
| `<service>_app`   | The running service and its worker | `CONNECT`, plus the grants listed in the migrations: SELECT, INSERT, and UPDATE only where needed, and no DELETE on safety or audit tables. `NOBYPASSRLS`. Not the owner, so RLS always applies. |

## Rules

- **Roles must exist before migrations run.** Migrations grant to the fixed role names and do not create roles, because creating roles needs elevated privileges that the owner must not have.
- **Local creation.** Locally, `infrastructure/docker/postgres/init/01-service-databases.sql` creates the roles and databases with development-only passwords.
- **Deployed creation.** In deployed environments, infrastructure automation creates the roles. The cluster admin credentials are in the secret store, and the passwords are generated and stored per service.
- **No cross-service access.** No role has `CONNECT` on another service's database.
- **Narrow privileged paths.** `SECURITY DEFINER` functions are limited to `aegis_sweep_expired_leases()` and the journal chain trigger and verifier. Each sets `search_path` explicitly.

## Bootstrap for a new environment

1. Create the cluster with encryption at rest and automated, encrypted backups.
2. For each service, create the two roles and the database. Revoke `PUBLIC` access and grant `CONNECT` to `<service>_app`.
3. Run each service's migration task with `MIGRATION_DATABASE_URL`.
4. Create the first platform operator:

   ```bash
   pnpm --filter @aegis/administration-service bootstrap:platform-operator -- --name "<full name>" --contact <email>
   ```

   This runs once, from an audited operator workstation or CI job. The bootstrap is journaled with an empty actor and the `bootstrap` marker.
