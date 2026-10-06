#!/usr/bin/env node
// Starts a disposable native PostgreSQL server for integration tests when Docker is unavailable.
// Data lives in a temporary directory and is deleted on exit.
//
//   pnpm test:db            (keep it running in one terminal)
//   TEST_POSTGRES_ADMIN_URL=postgresql://postgres:aegis_test_admin@localhost:54329/postgres pnpm test:integration
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { default: EmbeddedPostgres } = await import('embedded-postgres').catch(() => {
  console.error('embedded-postgres is not installed. Run: pnpm add -D -w embedded-postgres');
  process.exit(1);
});

const port = Number(process.env.TEST_POSTGRES_PORT ?? 54329);
const dir = mkdtempSync(join(tmpdir(), 'aegis-pg-'));
const server = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'postgres',
  password: 'aegis_test_admin',
  port,
  persistent: false,
  onLog: () => undefined,
});

await server.initialise();
await server.start();
console.log(
  `TEST_POSTGRES_ADMIN_URL=postgresql://postgres:aegis_test_admin@localhost:${port}/postgres`,
);
console.log('Disposable test PostgreSQL is running. Press Ctrl+C to stop and delete it.');

const stop = async () => {
  await server.stop().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
