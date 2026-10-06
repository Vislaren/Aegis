import { existsSync } from 'node:fs';
import { defineConfig, env } from 'prisma/config';

// Local development reads the git-ignored .env written by scripts/setup-dev-env.mjs.
if (existsSync('.env')) process.loadEnvFile('.env');

// Migrations run as the database owner role (MIGRATION_DATABASE_URL); the running service uses
// the restricted runtime role (DATABASE_URL). Falls back to DATABASE_URL for one-shot containers.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.MIGRATION_DATABASE_URL ?? env('DATABASE_URL'),
  },
});
