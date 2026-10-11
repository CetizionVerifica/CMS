// Writes docs/contracts/openapi.json from the endpoint table. Run: pnpm --filter @canopy/contracts openapi
import { writeFileSync } from 'node:fs';
import { buildOpenApi } from '../src/api/openapi.js';

const target = new URL('../../../docs/contracts/openapi.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
console.log(`Wrote ${target.pathname}`);
