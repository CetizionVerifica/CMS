// Writes docs/contracts/openapi.json and openapi.platform.json from the endpoint tables.
// Run: pnpm --filter @canopy/contracts openapi
import { writeFileSync } from 'node:fs';
import { buildOpenApi, buildPlatformOpenApi } from '../src/api/openapi.js';

for (const [file, document] of [
  ['openapi.json', buildOpenApi()],
  ['openapi.platform.json', buildPlatformOpenApi()],
] as const) {
  const target = new URL(`../../../docs/contracts/${file}`, import.meta.url);
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Wrote ${target.pathname}`);
}
