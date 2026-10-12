import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_CLIENT_SETTINGS,
  DryRunReport,
  ImportBatch,
  ImportIssueGroup,
  ImportUploaded,
  ImportUploadTicket,
  LocalDate,
} from '@canopy/contracts';
import {
  acts,
  assignments,
  auditEvents,
  categories,
  clients,
  companies,
  createAdminDatabase,
  createDatabase,
  departments,
  comments,
  instances,
  locations,
  obligations,
  people,
  systemContext,
  units,
  type Database,
} from '@canopy/db';
import { inferRule } from '@canopy/engine';
import {
  companyKey,
  instanceChange,
  locationKey,
  obligationRefKey,
  obligationTitleKey,
  unitKey,
  type ExistingInstance,
  type ImportPlan,
  type PlanInstance,
} from '@canopy/importer';
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

  /** Uploads the sample again for `firm`, maps it and decides it as before; returns the batch id. */
  async function importAgain(firm: (typeof firms)[number]): Promise<string> {
    const h = headers(firm);
    const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, payload?: object) =>
      app.inject({ method, url: `/api/v1${path}`, payload, headers: h });
    const ticket = ImportUploadTicket.parse(
      (
        await call('POST', `/clients/${firm.clientId}/imports`, {
          fileName: 'again.xlsx',
          sizeBytes: bytes.byteLength,
        })
      ).json(),
    );
    files.put(uploadKey(firm.firmId, ticket.batchId), bytes);
    const preview = ImportUploaded.parse(
      (await call('POST', `/imports/${ticket.batchId}/uploaded`, { sha256: sha(bytes) })).json(),
    );
    await call('PUT', `/imports/${ticket.batchId}/mapping`, {
      sheetName: preview.sheets[0]?.name,
      mapping: preview.suggestedMapping,
    });
    await call('POST', `/imports/${ticket.batchId}/parse`);
    await Promise.all(running.splice(0));
    for (let round = 0; round < 5; round++) {
      const pending = z
        .strictObject({ items: z.array(ImportIssueGroup) })
        .parse(
          (await call('GET', `/imports/${ticket.batchId}/issues?decision=PENDING`)).json(),
        ).items;
      if (pending.length === 0) break;
      for (const group of pending) {
        const decision = group.type === 'RULE_LOW_CONFIDENCE' ? 'ACCEPTED' : 'REJECTED';
        await call('PATCH', `/imports/${ticket.batchId}/issues/${group.groupKey}`, { decision });
      }
    }
    return ticket.batchId;
  }

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

    const cancelled = await call('POST', `/imports/${second.batchId}/cancel`);
    expect(ImportBatch.parse(cancelled.json()).status).toBe('CANCELLED');

    // Dry run and commit through the repositories, under the consultant's tenant context.
    const report = DryRunReport.parse(
      (await call('POST', `/imports/${ticket.batchId}/dry-run`)).json(),
    );
    // Every row becomes an instance or is skipped (rejected errors and folded repeats).
    expect(report.create.instances).toBeGreaterThan(400);
    expect(report.blockingErrors).toBe(0);
    expect((await call('POST', `/imports/${ticket.batchId}/commit`)).statusCode).toBe(202);
    await Promise.all(running.splice(0));
    const done = ImportBatch.parse((await call('GET', `/imports/${ticket.batchId}`)).json());
    expect(done).toMatchObject({ status: 'COMMITTED', failureCode: null });

    const stored = await db.withTenant(systemContext(firm.firmId, 'check'), async (tx) => {
      const register = await instances.register(tx, firm.clientId, {}, { limit: 200 });
      const assigned = await assignments.findAll(tx, { clientId: firm.clientId });
      const first = register.items[0]!;
      const history = await auditEvents.forEntity(tx, 'instance', first.id);
      return { register, assigned, history };
    });
    expect(stored.register.items).toHaveLength(200);
    expect(stored.assigned.length).toBeGreaterThan(0);
    expect(stored.history[0]).toMatchObject({
      action: 'IMPORT',
      actorKind: 'PERSON',
      actorId: firm.personId,
      after: expect.objectContaining({ importBatchId: ticket.batchId }),
    });
    const linked = await call('GET', `/imports/${ticket.batchId}/rows?limit=5`);
    expect(
      linked.json().items.some((r: { targetInstanceId: string | null }) => r.targetInstanceId),
    ).toBe(true);

    // Importing the same register again finds everything already there.
    const again = await importAgain(firm);
    const repeat = DryRunReport.parse((await call('POST', `/imports/${again}/dry-run`)).json());
    expect(repeat.create).toMatchObject({ instances: 0, obligations: 0, people: 0, units: 0 });
    expect(repeat.update).toEqual({ obligations: 0, assignments: 0, instances: 0 });
    expect(repeat.unchanged.instances).toBe(report.create.instances);
    expect((await call('POST', `/imports/${again}/commit`)).statusCode).toBe(202);
    await Promise.all(running.splice(0));
    expect(ImportBatch.parse((await call('GET', `/imports/${again}`)).json()).status).toBe(
      'COMMITTED',
    );
  });

  it('commits a plan into existing data: aliases, updates and instance changes, all audited', async () => {
    const firm = firms[1]!;
    const store = repositoryStore(db);
    const ctx = systemContext(firm.firmId, 'plan-test');
    const day = (d: string) => LocalDate.parse(d);
    const belur = unitKey('Hindalco', 'Belur');
    const pune = unitKey('Novelis', 'Pune');
    const existingRef = obligationRefKey('TAX-CL-033-6067-60218');
    const newRef = obligationRefKey('NEW-1');
    const byTitle = obligationTitleKey('Factories Act, 1948', 'No source ID', belur);
    const rule = (d: string) => ({ kind: 'ONE_TIME' as const, dueDate: day(d) });
    const obligation = (key: string, externalRef: string | null, title: string, due: string) => ({
      key,
      externalRef,
      domain: 'TAX' as const,
      jurisdiction: 'CENTRAL' as const,
      stateCode: null,
      act: 'Factories Act, 1948',
      category: 'Returns',
      title,
      description: 'From the register',
      applicabilityText: null,
      criticality: 'HIGH' as const,
      timelineType: 'TIME_BASED' as const,
      inferred: null,
      recurrenceRule: rule(due),
      ruleStatus: 'CONFIRMED' as const,
      forms: [],
      logSheets: [],
    });
    const instance = (
      assignmentKey: string,
      due: string,
      extra: Partial<PlanInstance> = {},
    ): PlanInstance => ({
      key: `${assignmentKey}|${due}`,
      assignmentKey,
      rowNumbers: [2],
      dueDate: day(due),
      workflowState: 'OPEN',
      completedOn: null,
      naReason: null,
      owner: 'asha rao',
      approver: 'admin b',
      comments: [],
      ...extra,
    });
    const a1 = `${belur}|${existingRef}|Human Resources`;
    const a2 = `${pune}|${newRef}|Admin`;
    const a3 = `${belur}|${byTitle}|Human Resources`;
    const plan: ImportPlan = {
      coverage: null,
      acts: [
        {
          name: 'Factories Act, 1948',
          aliases: ['Factories Act 1948'],
          jurisdiction: 'CENTRAL',
          stateCode: null,
        },
        { name: 'Shops Act', aliases: [], jurisdiction: 'STATE', stateCode: 'MH' },
      ],
      categories: [
        { name: 'Returns', aliases: ['Return'] },
        { name: 'Registers', aliases: [] },
      ],
      departments: [
        { name: 'Human Resources', aliases: ['H.R.'] },
        { name: 'Admin', aliases: [] },
      ],
      people: [
        { nameNormalized: 'asha rao', displayName: 'Asha Rao' },
        { nameNormalized: 'admin b', displayName: 'Admin b' },
      ],
      companies: [
        { key: companyKey('Hindalco'), name: 'Hindalco' },
        { key: companyKey('Novelis'), name: 'Novelis' },
      ],
      locations: [
        {
          key: locationKey({ countryCode: 'IN', state: 'West Bengal', city: 'Belur' }),
          country: 'India',
          countryCode: 'IN',
          state: 'West Bengal',
          stateCode: 'WB',
          city: 'Belur',
        },
        {
          key: locationKey({ countryCode: 'IN', state: 'Maharashtra', city: 'Pune' }),
          country: 'India',
          countryCode: 'IN',
          state: 'Maharashtra',
          stateCode: 'MH',
          city: 'Pune',
        },
      ],
      units: [
        {
          key: belur,
          companyKey: companyKey('Hindalco'),
          name: 'Belur',
          locationKey: locationKey({ countryCode: 'IN', state: 'West Bengal', city: 'Belur' }),
        },
        {
          key: pune,
          companyKey: companyKey('Novelis'),
          name: 'Pune',
          locationKey: locationKey({ countryCode: 'IN', state: 'Maharashtra', city: 'Pune' }),
        },
      ],
      obligations: [
        obligation(existingRef, 'TAX-CL-033-6067-60218', 'Existing', '2022-04-30'),
        obligation(newRef, 'NEW-1', 'New return', '2023-05-15'),
        obligation(byTitle, null, 'No source ID', '2022-06-30'),
      ],
      assignments: [
        {
          key: a1,
          unitKey: belur,
          obligationKey: existingRef,
          department: 'Human Resources',
          defaultOwner: 'asha rao',
          defaultApprover: 'admin b',
          firstDueDate: day('2022-04-30'),
        },
        {
          key: a2,
          unitKey: pune,
          obligationKey: newRef,
          department: 'Admin',
          defaultOwner: 'asha rao',
          defaultApprover: 'admin b',
          firstDueDate: day('2023-05-15'),
        },
        {
          key: a3,
          unitKey: belur,
          obligationKey: byTitle,
          department: 'Human Resources',
          defaultOwner: 'asha rao',
          defaultApprover: 'admin b',
          firstDueDate: day('2022-06-30'),
        },
      ],
      instances: [
        instance(a1, '2022-04-30', { comments: ['Filed late'] }),
        instance(a2, '2023-05-15', { workflowState: 'APPROVED', completedOn: day('2023-05-10') }),
        instance(a3, '2022-06-30'),
      ],
    };
    const commit = (p: ImportPlan, changes = new Map()) =>
      store.transaction(ctx, (tx) =>
        tx.commit({
          batchId: firm.clientId,
          clientId: firm.clientId,
          plan: p,
          instanceChanges: changes,
          actorId: firm.personId,
          requestId: 'plan-test',
        }),
      );

    const first = await commit(plan);
    expect(first.instanceIds.size).toBe(3);
    const before = await store.transaction(ctx, (tx) => tx.existingState(firm.clientId));
    expect(Object.keys(before.instances).sort()).toEqual(plan.instances.map((i) => i.key).sort());
    expect(before.acts.find((a) => a.name === 'Factories Act, 1948')?.aliases).toEqual([
      'Factories Act 1948',
    ]);
    expect(before.departments.find((d) => d.name === 'Human Resources')?.aliases).toEqual([
      'HR',
      'H.R.',
    ]);
    // The library obligation took the register's description; the period is the rule's.
    const a1Instance = first.instanceIds.get(plan.instances[0]!.key)!;
    const stored1 = await db.withTenant(ctx, (tx) => instances.require(tx, a1Instance));
    expect(stored1).toMatchObject({
      periodStart: '2022-04-30',
      periodEnd: '2022-04-30',
      dueDate: '2022-04-30',
    });

    // The register changed: a new owner on A1, and the first instance approved with a new comment.
    const next: ImportPlan = {
      ...plan,
      assignments: plan.assignments.map((a) =>
        a.key === a1 ? { ...a, defaultOwner: 'admin b' } : a,
      ),
      instances: [
        instance(a1, '2022-04-30', {
          workflowState: 'APPROVED',
          completedOn: day('2022-04-25'),
          owner: 'admin b',
          approver: 'asha rao',
          comments: ['Filed late', 'Receipt attached'],
        }),
        ...plan.instances.slice(1),
      ],
    };
    const changes = new Map(
      next.instances.flatMap((i) => {
        const change = instanceChange(i, before.instances[i.key] as ExistingInstance);
        return change ? [[i.key, change] as const] : [];
      }),
    );
    expect([...changes.keys()]).toEqual([next.instances[0]!.key]);
    const second = await commit(next, changes);
    expect(second.instanceIds.get(next.instances[0]!.key)).toBe(a1Instance);

    const after = await db.withTenant(ctx, async (tx) => ({
      instance: await instances.require(tx, a1Instance),
      notes: (await comments.forInstance(tx, a1Instance)).map((c) => [c.kind, c.body]),
      history: await auditEvents.forEntity(tx, 'instance', a1Instance),
      assignment: (await assignments.findAll(tx, { clientId: firm.clientId })).find(
        (a) => a.id === stored1.assignmentId,
      ),
    }));
    expect(after.instance).toMatchObject({
      workflowState: 'APPROVED',
      completedOn: '2022-04-25',
      version: 2,
    });
    expect(after.notes).toEqual([
      ['IMPORT', 'Filed late'],
      ['IMPORT', 'Receipt attached'],
    ]);
    expect(after.history.map((e) => e.action)).toEqual(['IMPORT', 'IMPORT', 'IMPORT']);
    expect(after.history.find((e) => e.before !== null)).toMatchObject({
      before: { workflowState: 'OPEN', completedOn: null },
      after: expect.objectContaining({ workflowState: 'APPROVED', completedOn: '2022-04-25' }),
    });
    expect(after.assignment?.version).toBe(2);

    // Committing the same plan again writes nothing.
    const state = await store.transaction(ctx, (tx) => tx.existingState(firm.clientId));
    expect(
      next.instances.filter((i) => instanceChange(i, state.instances[i.key] as ExistingInstance)),
    ).toEqual([]);
    await commit(next);
    const unchanged = await db.withTenant(ctx, (tx) => instances.require(tx, a1Instance));
    expect(unchanged.version).toBe(2);
  });
});
