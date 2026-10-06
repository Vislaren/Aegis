import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Integration-test database harness. Requires TEST_POSTGRES_ADMIN_URL: a superuser connection to
 * a disposable PostgreSQL server (Docker Compose `postgres`, CI service container, or the embedded
 * server from `pnpm test:db`). Each run recreates `<db>` and applies the service's reviewed
 * migrations as the owner role, exactly as `prisma migrate deploy` would, then returns URLs for
 * the owner and the restricted runtime role.
 */
export interface TestDatabase {
  ownerUrl: string;
  appUrl: string;
  name: string;
}

function withDatabase(url: string, database: string, user?: string, password?: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (user !== undefined) parsed.username = user;
  if (password !== undefined) parsed.password = password;
  return parsed.toString();
}

export function requireAdminUrl(): string {
  const url = process.env.TEST_POSTGRES_ADMIN_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      'TEST_POSTGRES_ADMIN_URL is not set. Start PostgreSQL (pnpm infra:up or pnpm test:db) and export the superuser URL; integration tests never run against a shared database.',
    );
  }
  return url;
}

export async function createTestDatabase(input: {
  /** Role prefix: `identity`, `administration`, or `audit`. */
  service: string;
  migrationsDir: string;
}): Promise<TestDatabase> {
  const adminUrl = requireAdminUrl();
  const owner = `${input.service}_owner`;
  const app = `${input.service}_app`;
  const ownerPassword = `${owner}_test`;
  const appPassword = `${app}_test`;
  const name = `aegis_${input.service}_it_${process.pid}`;

  const admin = new Client({ connectionString: withDatabase(adminUrl, 'postgres') });
  await admin.connect();
  try {
    for (const [role, password, extra] of [
      [owner, ownerPassword, 'NOBYPASSRLS'],
      [app, appPassword, 'NOBYPASSRLS NOCREATEDB'],
    ] as const) {
      const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.rowCount === 0)
        await admin.query(
          `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEROLE ${extra}`,
        );
      else await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
    }
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name} OWNER ${owner}`);
    await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO ${app}`);
  } finally {
    await admin.end();
  }

  const ownerUrl = withDatabase(adminUrl, name, owner, ownerPassword);
  const migrator = new Client({ connectionString: ownerUrl });
  await migrator.connect();
  try {
    // PostgreSQL 15+ no longer grants CREATE on public to everyone; the owner owns the database.
    await migrator.query('ALTER SCHEMA public OWNER TO CURRENT_USER').catch(() => undefined);
    const migrations = readdirSync(input.migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const migration of migrations) {
      await migrator.query(
        readFileSync(join(input.migrationsDir, migration, 'migration.sql'), 'utf8'),
      );
    }
  } finally {
    await migrator.end();
  }
  return { ownerUrl, appUrl: withDatabase(adminUrl, name, app, appPassword), name };
}

export async function dropTestDatabase(database: TestDatabase): Promise<void> {
  const admin = new Client({ connectionString: withDatabase(requireAdminUrl(), 'postgres') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database.name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** Runs SQL as a given role, for direct RLS and append-only assertions. */
export async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
