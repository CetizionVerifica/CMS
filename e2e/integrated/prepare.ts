// Recreates the integrated run's database before the API starts (playwright.integrated.config.ts runs it first in
// the API's webServer command): migrations, the two seed firms, one client each and a signed-in account per role.
// The register itself is not seeded: the import journey loads it through the API, as a consultant would.
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_CLIENT_SETTINGS } from '@canopy/contracts';
import {
  SEED_FIRMS,
  clients,
  createAdminDatabase,
  createDatabase,
  credentials,
  memberships,
  people,
  systemContext,
} from '@canopy/db';
import { hashPassword, SecretBox } from '@canopy/api/src/auth/index.js';
import pg from 'pg';
import {
  ACCOUNTS,
  APP_LOGIN,
  APP_PASSWORD,
  AUTH_SECRET_KEY,
  E2E_DATABASE,
  FIRM_A,
  FIRM_B,
  PASSWORD,
  RUN_DIR,
  TOTP_SECRET,
  databaseUrl,
  type Account,
} from './stack.js';

if (SEED_FIRMS.a.id !== FIRM_A || SEED_FIRMS.b.id !== FIRM_B)
  throw new Error('SEED_FIRMS changed: update stack.ts');

const base = process.env.E2E_SERVER_DATABASE_URL;
if (!base) {
  console.error('DATABASE_URL is not set: the integrated journeys need Postgres 16.');
  process.exit(1);
}

// A fresh database each run, so journeys start from the same state.
const server = new pg.Client({ connectionString: base });
await server.connect();
await server.query(`DROP DATABASE IF EXISTS ${E2E_DATABASE} WITH (FORCE)`);
await server.query(`CREATE DATABASE ${E2E_DATABASE}`);
await server.end();

const ownerUrl = databaseUrl(base, E2E_DATABASE);
const admin = createAdminDatabase({ connectionString: ownerUrl });
await admin.migrate();

// The API serves through a plain member of canopy_app, as in production (packages/db/CLAUDE.md), not the owner.
// Roles are per server, so this survives the database being dropped.
const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();
await owner.query(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_LOGIN}') THEN
    CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$`);
await owner.query(`GRANT canopy_app TO ${APP_LOGIN}`);
// CONNECT, and CREATE because M9's pg-boss creates and owns its `pgboss` schema when the API starts.
await owner.query(`GRANT CONNECT, CREATE ON DATABASE ${E2E_DATABASE} TO ${APP_LOGIN}`);
await owner.end();

for (const firm of Object.values(SEED_FIRMS)) await admin.createFirm(firm);
await admin.close();

// Seeding writes as the owner (the API's NODE_ENV=production would otherwise refuse it), still through withTenant.
const db = createDatabase({ connectionString: ownerUrl, max: 2, privilegedLogin: 'allow' });
const secrets = new SecretBox(AUTH_SECRET_KEY);
const passwordHash = await hashPassword(PASSWORD);

async function createClient(firmId: string, name: string): Promise<string> {
  const client = await db.withTenant(systemContext(firmId, 'e2e-seed'), (tx) =>
    clients.create(tx, { name, settings: DEFAULT_CLIENT_SETTINGS }),
  );
  return client.id;
}

const clientIds = {
  kestrel: await createClient(SEED_FIRMS.a.id, 'Kestrel Metals Group'),
  osprey: await createClient(SEED_FIRMS.b.id, 'Osprey Textiles Group'),
};
const clientOf = (account: Account) =>
  account.firmId === SEED_FIRMS.a.id ? clientIds.kestrel : clientIds.osprey;

const personIds: Record<string, string> = {};
for (const account of Object.values(ACCOUNTS) as Account[]) {
  const firmRole = account.role === 'FIRM_ADMIN' || account.role === 'CONSULTANT';
  personIds[account.key] = await db.withTenant(
    systemContext(account.firmId, 'e2e-seed'),
    async (tx) => {
      const person = await people.create(tx, {
        displayName: account.displayName,
        nameNormalized: account.displayName.toLowerCase(),
        email: account.email,
        status: 'ACTIVE',
      });
      await memberships.create(tx, {
        personId: person.id,
        role: account.role,
        clientId: firmRole ? null : clientOf(account),
        consultantClientIds: account.role === 'CONSULTANT' ? [clientOf(account)] : null,
        unitIds: null,
        expiresAt: account.role === 'VIEWER' ? '2099-12-31T00:00:00Z' : null,
      });
      await credentials.setPassword(tx, person.id, passwordHash);
      // Firm roles must pass MFA; they are enrolled with a known secret so the journeys can compute codes.
      if (firmRole) {
        await credentials.saveMfa(tx, person.id, {
          sealedSecret: secrets.seal(TOTP_SECRET),
          enrolledAt: new Date().toISOString(),
          lastStep: null,
        });
      }
      return person.id;
    },
  );
}
await db.close();

mkdirSync(RUN_DIR, { recursive: true });
writeFileSync(
  new URL('seed.json', RUN_DIR),
  JSON.stringify({ clients: clientIds, people: personIds }, null, 2),
);
console.log(
  `e2e database ${E2E_DATABASE} ready: 2 firms, 2 clients, ${Object.keys(personIds).length} accounts`,
);
