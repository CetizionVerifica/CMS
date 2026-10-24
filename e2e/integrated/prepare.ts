// Recreates the integrated run's database before the API starts (playwright.integrated.config.ts runs it first in
// the API's webServer command): migrations, the two seed firms, one client each, a signed-in account per role and the
// platform operator.
// The register itself is not seeded: the import journey loads it through the API, as a consultant would. Firm roles
// enrol in MFA through the API in auth.setup.ts, as a new firm user would.
import { execFileSync } from 'node:child_process';
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
import pg from 'pg';

import { storedPassword } from './password.js';
import {
  ACCOUNTS,
  APP_LOGIN,
  APP_PASSWORD,
  JOBS_LOGIN,
  JOBS_PASSWORD,
  OPERATOR,
  OPERATOR_LOGIN,
  OPERATOR_LOGIN_PASSWORD,
  OPERATOR_TOTP_FILE,
  E2E_DATABASE,
  FIRM_A,
  FIRM_B,
  PASSWORD,
  RUN_DIR,
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
// CONNECT only: the migrations create the `pgboss` schema pg-boss runs in (0022, then canopy_jobs's from 0023).
await owner.query(`GRANT CONNECT ON DATABASE ${E2E_DATABASE} TO ${APP_LOGIN}`);
// The jobs run as their own login, as in production. Once M3 hands the job schema to canopy_jobs, the login is a
// member of canopy_jobs and defaults to it, so pg-boss's tables belong to canopy_jobs; before that, of canopy_app.
const { rowCount: jobsRole } = await owner.query(
  `SELECT 1 FROM pg_roles WHERE rolname = 'canopy_jobs'`,
);
const jobsGroup = jobsRole === 1 ? 'canopy_jobs' : 'canopy_app';
await owner.query(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${JOBS_LOGIN}') THEN
    CREATE ROLE ${JOBS_LOGIN} LOGIN PASSWORD '${JOBS_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$`);
// Roles outlive the database, so a login a run before 0023 made a member of canopy_app leaves it.
if (jobsGroup === 'canopy_jobs') await owner.query(`REVOKE canopy_app FROM ${JOBS_LOGIN}`);
await owner.query(`GRANT ${jobsGroup} TO ${JOBS_LOGIN}`);
await owner.query(`ALTER ROLE ${JOBS_LOGIN} SET role = ${jobsGroup}`);
await owner.query(`GRANT CONNECT ON DATABASE ${E2E_DATABASE} TO ${JOBS_LOGIN}`);
// The operator console's login (OPERATOR_DATABASE_URL, ADR M3-0002): a member of canopy_operator only.
await owner.query(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OPERATOR_LOGIN}') THEN
    CREATE ROLE ${OPERATOR_LOGIN} LOGIN PASSWORD '${OPERATOR_LOGIN_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$`);
await owner.query(`GRANT canopy_operator TO ${OPERATOR_LOGIN}`);
await owner.query(`GRANT CONNECT ON DATABASE ${E2E_DATABASE} TO ${OPERATOR_LOGIN}`);
await owner.end();

for (const firm of Object.values(SEED_FIRMS)) await admin.createFirm(firm);
await admin.close();

// Seeding writes as the owner (the API's NODE_ENV=production would otherwise refuse it), still through withTenant.
const db = createDatabase({ connectionString: ownerUrl, max: 2, privilegedLogin: 'allow' });
const passwordHash = await storedPassword(PASSWORD);

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
      return person.id;
    },
  );
}
await db.close();

// The operator is created as in production: the API's command, the password on stdin. Its secret is kept from the
// otpauth URI it prints, as an authenticator app would keep it; the URI itself is never logged.
const added = execFileSync(
  'pnpm',
  [
    '--silent',
    '--filter',
    '@canopy/api',
    'platform:add-operator',
    '--email',
    OPERATOR.email,
    '--name',
    OPERATOR.displayName,
  ],
  {
    input: `${OPERATOR.password}\n`,
    encoding: 'utf8',
    env: {
      ...process.env,
      OPERATOR_DATABASE_URL: databaseUrl(base, E2E_DATABASE, [
        OPERATOR_LOGIN,
        OPERATOR_LOGIN_PASSWORD,
      ]),
    },
  },
);
const otpauth = added.split('\n').find((line) => line.startsWith('otpauth://'));
const operatorSecret = otpauth && new URL(otpauth).searchParams.get('secret');
if (!operatorSecret) throw new Error('platform:add-operator printed no otpauth URI');

mkdirSync(RUN_DIR, { recursive: true });
writeFileSync(OPERATOR_TOTP_FILE, operatorSecret);
writeFileSync(
  new URL('seed.json', RUN_DIR),
  JSON.stringify({ clients: clientIds, people: personIds }, null, 2),
);
console.log(
  `e2e database ${E2E_DATABASE} ready: 2 firms, 2 clients, ${Object.keys(personIds).length} accounts, 1 operator`,
);
