# Database migrations

Each service owns its migrations in `services/<service>/prisma/migrations`. They are hand-written, reviewed SQL. Prisma's schema language cannot express what Aegis relies on:

- row-level security policies;
- append-only and hash-chain triggers;
- CHECK constraints and partial or `NULLS NOT DISTINCT` indexes;
- composite foreign keys and `SECURITY DEFINER` functions;
- database-generated UUID defaults and role grants.

## Rules

- **Never run `prisma migrate dev` or `prisma db push`.** Both would "correct" the database toward `schema.prisma` and drop the constraints above. The scripts were removed deliberately.
- **To change a schema:**
  1. Add a new directory `prisma/migrations/<UTC timestamp>_<name>/migration.sql` with expand-and-contract changes.
  2. Update `schema.prisma` to mirror the new columns.
  3. Run `pnpm --filter <service> prisma:generate`.
- **Check drift.** Run `pnpm --filter <service> prisma:drift` with `MIGRATION_DATABASE_URL` pointing at a migrated database.
  - The expected output lists only items Prisma cannot model: index drops, UUID default drops, and differences in foreign-key referential actions.
  - Any `ADD COLUMN`, `ALTER COLUMN ... TYPE`, or nullability change in the output means `schema.prisma` and the SQL disagree. Fix it before merging.
- **Apply in deployed environments** with `prisma migrate deploy` (the one-shot migration task), using the owner role's credentials.

## Verified on 2026-10-06

- `prisma migrate deploy` applied all migrations of identity, administration, and audit to fresh PostgreSQL 18.4 databases.
- The drift check showed no column-level differences.
