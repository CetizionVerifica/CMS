import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  acts,
  assignments,
  categories,
  clients,
  createAdminDatabase,
  createDatabase,
  departments,
  findSeedModules,
  importBatches,
  instances,
  loadSeedHooks,
  obligations,
  people,
  runSeed,
  SEED_FIRMS,
  systemContext,
  type AdminDatabase,
  type Database,
} from '@canopy/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_CLIENT_NAME } from './seed.js';

/**
 * `pnpm db:seed` with the hooks apps/api/package.json registers (`canopy.seed`): the sample register lands in
 * firm A with the "recommended" golden counts (docs/contracts/fixtures.md §3), and a second run changes nothing.
 */

const url = process.env.DATABASE_URL;
const WORKSPACE = fileURLToPath(new URL('../../../../../', import.meta.url));

describe.skipIf(!url)('pnpm db:seed loads the sample register', { timeout: 180_000 }, () => {
  const name = `canopy_seed_${randomBytes(6).toString('hex')}`;
  let admin: AdminDatabase;
  let db: Database;

  function databaseUrl(): string {
    const base = new URL(url ?? '');
    base.pathname = `/${name}`;
    return base.toString();
  }

  beforeAll(async () => {
    const server = new pg.Client({ connectionString: url });
    await server.connect();
    await server.query(`CREATE DATABASE ${name}`);
    await server.end();
    admin = createAdminDatabase({ connectionString: databaseUrl() });
    await admin.migrate();
    db = createDatabase({ connectionString: databaseUrl(), max: 4 });
  });

  afterAll(async () => {
    await admin?.close();
    await db?.close();
    const server = new pg.Client({ connectionString: url });
    await server.connect();
    await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await server.end();
  });

  async function seed(): Promise<string[]> {
    const modules = findSeedModules(WORKSPACE);
    expect(modules.map((m) => m.packageName)).toContain('@canopy/api');
    const lines: string[] = [];
    await runSeed({ admin, db, hooks: await loadSeedHooks(modules), log: (l) => lines.push(l) });
    return lines;
  }

  /** What firm A holds: counts, plus every instance's id and version so a rewrite would show. */
  function snapshot() {
    return db.withTenant(systemContext(SEED_FIRMS.a.id, 'seed-check'), async (tx) => {
      const [client, ...others] = await clients.findAll(tx, {});
      if (!client) throw new Error('no client');
      const assigned = await assignments.findAll(tx, { clientId: client.id });
      const all = [];
      // One query at a time: a transaction holds a single connection.
      for (const a of assigned) all.push(...(await instances.forAssignment(tx, a.id)));
      const states: Record<string, number> = {};
      for (const i of all) states[i.workflowState] = (states[i.workflowState] ?? 0) + 1;
      return {
        clientName: client.name,
        otherClients: others.length,
        obligations: (await obligations.findAll(tx, {})).length,
        assignments: assigned.length,
        instances: all.length,
        states,
        acts: (await acts.findAll(tx, {})).length,
        categories: (await categories.findAll(tx, {})).length,
        departments: (await departments.findAll(tx, { clientId: client.id })).length,
        people: (await people.findAll(tx, {})).length,
        batches: (await importBatches.list(tx, client.id)).items.map((b) => b.status),
        versions: all.map((i) => `${i.id}:${i.version}`).sort(),
      };
    });
  }

  it('gives the golden counts once, and a second run changes nothing', async () => {
    const first = await seed();
    expect(first).toContain('hook sample-register: running');
    expect(first.some((l) => l.startsWith('sample register: imported 119 obligations'))).toBe(true);

    const seeded = await snapshot();
    expect(seeded).toMatchObject({
      clientName: SEED_CLIENT_NAME,
      otherClients: 0,
      obligations: 119,
      assignments: 119,
      instances: 422,
      states: { APPROVED: 209, OPEN: 201, NOT_APPLICABLE: 12 },
      acts: 33,
      categories: 10,
      departments: 9,
      // The register's 21 people and the seed consultant.
      people: 22,
      batches: ['COMMITTED'],
    });
    // Firm B gets no client data from this hook.
    const firmB = await db.withTenant(systemContext(SEED_FIRMS.b.id, 'seed-check'), (tx) =>
      clients.findAll(tx, {}),
    );
    expect(firmB).toEqual([]);

    const second = await seed();
    expect(second).toContain('sample register: already imported');
    expect(await snapshot()).toEqual(seeded);
  });
});
