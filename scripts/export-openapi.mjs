#!/usr/bin/env node
// Writes the aggregated public OpenAPI document (generated from packages/contracts) to docs/api.
// Requires `pnpm build` first so @aegis/contracts/dist exists.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const require = createRequire(join(root, 'services', 'api-gateway', 'package.json'));
const { buildOpenApiDocument } = require('@aegis/contracts/dist/openapi');
mkdirSync(join(root, 'docs', 'api'), { recursive: true });
writeFileSync(
  join(root, 'docs', 'api', 'openapi.json'),
  `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`,
);
console.log('wrote docs/api/openapi.json');
