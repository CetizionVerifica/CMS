// `pnpm db:seed`: seed firms, then every package's registered seed hook (see src/seed.ts).
import { fileURLToPath } from 'node:url';
import { createAdminDatabase, createDatabase } from '../database.js';
import { findSeedModules, loadSeedHooks, runSeed } from '../seed.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const admin = createAdminDatabase({ connectionString });
const db = createDatabase({ connectionString });
try {
  const hooks = await loadSeedHooks(findSeedModules(workspaceRoot));
  await runSeed({ admin, db, hooks, log: (line) => console.log(line) });
  console.log(`Seed done (${hooks.length} hook${hooks.length === 1 ? '' : 's'}).`);
} finally {
  await Promise.all([admin.close(), db.close()]);
}
