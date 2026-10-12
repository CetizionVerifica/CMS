import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_CLIENT_SETTINGS,
  ImportBatch,
  ImportIssueGroup,
  ImportUploaded,
  ImportUploadTicket,
  LocalDate,
} from '@canopy/contracts';
import {
  acts,
  categories,
  clients,
  companies,
  createAdminDatabase,
  createDatabase,
  departments,
  locations,
  obligations,
  people,
  systemContext,
  units,
  type Database,
} from '@canopy/db';
import { inferRule } from '@canopy/engine';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import { repositoryStore } from './service.js';
import { MemoryImportFiles, uploadKey } from './files.js';

/**
 * The import API on Postgres through the M3 repositories (`pnpm --filter @canopy/api test:db`, CI `db` job).
 * The route tests (imports.test.ts) cover every step and role on the in-memory store; this file proves the
 * repository store behaves the same, under RLS, and that another firm sees none of it.
 */

const url = process.env.DATABASE_URL;
const SAMPLE = new URL(
  '../../../../../packages/importer/fixtures/sample-register.xlsx',
  import.meta.url,
);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe.skipIf(!url)('import API on Postgres', { timeout: 60_000 }, () => {
  const name = `canopy_import_${randomBytes(6).toString('hex')}`;
  let db: Database;
  let app: FastifyInstance;
  let bytes: Uint8Array;
  const files = new MemoryImportFiles();
  const auth = createTestAuth();
  const running: Promise<void>[] = [];
  const firms: { firmId: string; clientId: string; personId: string }[] = [];

  async function seedFirm(label: string) {
    const testUrl = databaseUrl();
    const admin = createAdminDatabase({ connectionString: testUrl });
    const firmId = await admin.createFirm({ name: `Firm ${label}` });
    await admin.close();
    return db.withTenant(systemContext(firmId, `seed-${label}`), async (tx) => {
      const client = await clients.create(tx, {
        name: `Client ${label}`,
        settings: DEFAULT_CLIENT_SETTINGS,
      });
      const person = await people.create(tx, {
        displayName: `Admin ${label}`,
        nameNormalized: `admin ${label}`.toLowerCase(),
        email: null,
        status: 'UNCLAIMED',
      });
      // Library rows the importer must recognise: an alias, a known Act and an existing obligation.
      await departments.create(tx, {
        clientId: client.id,
        name: 'Human Resources',
        aliases: ['HR'],
      });
      const act = await acts.create(tx, {
        name: 'Factories Act, 1948',
        shortName: null,
        jurisdiction: 'CENTRAL',
        stateCode: null,
        aliases: [],
      });
      const category = await categories.create(tx, { name: 'Returns', aliases: [] });
      await obligations.create(tx, {
        externalRef: 'TAX-CL-033-6067-60218',
        domain: 'TAX',
        jurisdiction: 'CENTRAL',
        stateCode: null,
        actId: act.id,
        categoryId: category.id,
        title: 'Existing',
        description: 'Already in the library',
        applicabilityText: null,
        criticality: 'HIGH',
        timelineType: 'TIME_BASED',
        recurrenceRule: { kind: 'ONE_TIME', dueDate: LocalDate.parse('2022-04-30') },
        ruleStatus: 'CONFIRMED',
        evidenceRequired: false,
        forms: [],
        logSheets: [],
        libraryVersion: 1,
      });
      // Obligations without a source ID are matched per unit at commit, not by the library.
      await obligations.create(tx, {
        externalRef: null,
        domain: 'HRS',
        jurisdiction: 'CENTRAL',
        stateCode: null,
        actId: act.id,
        categoryId: category.id,
        title: 'No source ID',
        description: 'Created by hand',
        applicabilityText: null,
        criticality: 'LOW',
        timelineType: 'ONGOING',
        recurrenceRule: { kind: 'ONE_TIME', dueDate: LocalDate.parse('2022-04-30') },
        ruleStatus: 'CONFIRMED',
        evidenceRequired: false,
        forms: [],
        logSheets: [],
        libraryVersion: 1,
      });
      const location = await locations.create(tx, {
        country: 'India',
        countryCode: 'IN',
        state: 'West Bengal',
        stateCode: 'WB',
        city: 'Belur',
      });
      const company = await companies.create(tx, { clientId: client.id, name: 'Hindalco' });
      await units.create(tx, {
        clientId: client.id,
        companyId: company.id,
        name: 'Belur',
        locationId: location.id,
      });
      return { firmId, clientId: client.id, personId: person.id };
    });
  }

  function databaseUrl(): string {
    const base = new URL(url ?? '');
    base.pathname = `/${name}`;
    return base.toString();
  }

  function headers(firm: (typeof firms)[number]) {
    return auth.signIn({
      firmId: firm.firmId,
      personId: firm.personId,
      memberships: [{ role: 'FIRM_ADMIN' }],
      principal: { firmClientIds: [firm.clientId] },
    }).headers;
  }

  beforeAll(async () => {
    const server = new pg.Client({ connectionString: url });
    await server.connect();
    await server.query(`CREATE DATABASE ${name}`);
    await server.end();
    const admin = createAdminDatabase({ connectionString: databaseUrl() });
    await admin.migrate();
    await admin.close();
    db = createDatabase({ connectionString: databaseUrl(), max: 4 });
    bytes = new Uint8Array(await readFile(SAMPLE));
    firms.push(await seedFirm('a'), await seedFirm('b'));
    app = buildServer({
      authStore: auth.store,
      imports: {
        store: repositoryStore(db),
        files,
        inferRule,
        runInBackground: (task) => running.push(task()),
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    const server = new pg.Client({ connectionString: url });
    await server.connect();
    await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await server.end();
  });

  it('runs every step through the repositories and keeps the batch inside its firm', async () => {
    const firm = firms[0]!;
    const h = headers(firm);
    const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, payload?: object) =>
      app.inject({ method, url: `/api/v1${path}`, payload, headers: h });

    const ticket = ImportUploadTicket.parse(
      (
        await call('POST', `/clients/${firm.clientId}/imports`, {
          fileName: 'register.xlsx',
          sizeBytes: bytes.byteLength,
        })
      ).json(),
    );
    files.put(uploadKey(firm.firmId, ticket.batchId), bytes);
    const preview = ImportUploaded.parse(
      (await call('POST', `/imports/${ticket.batchId}/uploaded`, { sha256: sha(bytes) })).json(),
    );
    expect(preview.batch.id).toBe(ticket.batchId);

    const mapped = await call('PUT', `/imports/${ticket.batchId}/mapping`, {
      sheetName: preview.sheets[0]?.name,
      mapping: preview.suggestedMapping,
      saveAsTemplate: { name: 'EY grid', scope: 'FIRM' },
    });
    expect(ImportBatch.parse(mapped.json()).status).toBe('MAPPED');

    expect((await call('POST', `/imports/${ticket.batchId}/parse`)).statusCode).toBe(202);
    await Promise.all(running.splice(0));
    const parsed = ImportBatch.parse((await call('GET', `/imports/${ticket.batchId}`)).json());
    expect(parsed).toMatchObject({ status: 'PARSED', counts: { rows: 424 } });

    const groups = z
      .strictObject({ items: z.array(ImportIssueGroup) })
      .parse((await call('GET', `/imports/${ticket.batchId}/issues`)).json()).items;
    // "HR" is a known alias of Human Resources, so it needs no decision.
    expect(groups.filter((g) => g.type === 'ALIAS_DEPARTMENT')).toEqual([]);
    // The obligation already in the library keeps its rule: no low-confidence issue for it.
    const lowConfidence = groups.filter((g) => g.type === 'RULE_LOW_CONFIDENCE');
    expect(JSON.stringify(lowConfidence)).not.toContain('TAX-CL-033-6067-60218');

    // Rejecting proposals changes the issue set: repeated periods stay apart, so their issues go and new
    // ones can appear. The repository store deletes the old groups and relinks the rows; new ones need deciding.
    const issuesNow = async () =>
      z
        .strictObject({ items: z.array(ImportIssueGroup) })
        .parse((await call('GET', `/imports/${ticket.batchId}/issues`)).json()).items;
    let pending = groups.filter((g) => g.decision === 'PENDING');
    for (let round = 0; pending.length > 0 && round < 5; round++) {
      for (const group of pending) {
        const decision = group.type === 'RULE_LOW_CONFIDENCE' ? 'ACCEPTED' : 'REJECTED';
        const res = await call('PATCH', `/imports/${ticket.batchId}/issues/${group.groupKey}`, {
          decision,
        });
        expect(res.statusCode).toBe(200);
      }
      pending = (await issuesNow()).filter((g) => g.decision === 'PENDING');
    }
    const after = await issuesNow();
    expect(after.map((g) => g.groupKey).sort()).not.toEqual(groups.map((g) => g.groupKey).sort());
    expect(pending).toEqual([]);
    const reviewed = ImportBatch.parse((await call('GET', `/imports/${ticket.batchId}`)).json());
    expect(reviewed.status).toBe('REVIEWED');

    const rows = await call('GET', `/imports/${ticket.batchId}/rows?limit=200`);
    expect(rows.json().items).toHaveLength(200);
    const second = ImportUploadTicket.parse(
      (
        await call('POST', `/clients/${firm.clientId}/imports`, {
          fileName: 'again.xlsx',
          sizeBytes: bytes.byteLength,
        })
      ).json(),
    );
    files.put(uploadKey(firm.firmId, second.batchId), bytes);
    await call('POST', `/imports/${second.batchId}/uploaded`, { sha256: sha(bytes) });
    const newest = await call('GET', `/clients/${firm.clientId}/imports?limit=1`);
    expect(newest.json().items.map((b: { id: string }) => b.id)).toEqual([second.batchId]);
    const older = await call(
      'GET',
      `/clients/${firm.clientId}/imports?limit=1&cursor=${newest.json().nextCursor}`,
    );
    expect(older.json().items.map((b: { id: string }) => b.id)).toEqual([ticket.batchId]);
    const templates = await call('GET', `/clients/${firm.clientId}/mapping-templates`);
    expect(templates.json().items).toHaveLength(1);
    const renamed = await call('PATCH', `/mapping-templates/${templates.json().items[0].id}`, {
      version: 1,
      name: 'EY grid export',
    });
    expect(renamed.json()).toMatchObject({ name: 'EY grid export', clientId: null, version: 2 });

    // Another firm's admin, even one who guesses the id, sees nothing.
    const other = firms[1]!;
    const outsider = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${ticket.batchId}`,
      headers: headers(other),
    });
    expect(outsider.statusCode).toBe(404);
    const upload = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${ticket.batchId}/uploaded`,
      payload: { sha256: sha(bytes) },
      headers: headers(other),
    });
    expect(upload.statusCode).toBe(404);

    const cancelled = await call('POST', `/imports/${ticket.batchId}/cancel`);
    expect(ImportBatch.parse(cancelled.json()).status).toBe('CANCELLED');
  });
});
