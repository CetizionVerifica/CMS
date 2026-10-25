import { DEFAULT_CLIENT_SETTINGS, LocalDate, type ManagementSystem } from '@canopy/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantTx } from '../src/database.js';
import { DbError } from '../src/errors.js';
import * as r from '../src/repositories/index.js';
import { systemContext, type TenantContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

/**
 * The ISO add-on's tables, part 1 (migration 0040, ISO-2d): catalogue writes only by a system job, composite keys
 * inside one client, the one-subject rule on files, the record checks, unit scope on every list, and the repositories.
 * Table-by-table isolation and the purge list are in isolation.db.test.ts and purge.db.test.ts.
 */

let t: TestDatabase;
let firmId: string;

interface World {
  kestrel: string;
  osprey: string;
  riverbend: string;
  stonebridge: string;
  ospreyUnit: string;
  ownerId: string;
  approverId: string;
  otherId: string;
  adminId: string;
  iso9001: string;
  iso14001: string;
  clauses: Record<string, string>;
}
let w: World;

const system = (): TenantContext => systemContext(firmId, 'iso-test');
const asSystem = <T>(fn: (tx: TenantTx) => Promise<T>) => t.db.withTenant(system(), fn);
const firmAdmin = (): TenantContext => ({
  firmId,
  personId: w.adminId,
  clientIds: 'ALL',
  requestId: 'iso-test',
});
const consultant = (): TenantContext => ({
  firmId,
  personId: w.adminId,
  clientIds: [w.kestrel],
  firmStaff: true,
  requestId: 'iso-test',
});
const clientUser = (): TenantContext => ({
  firmId,
  personId: w.ownerId,
  clientIds: [w.kestrel],
  requestId: 'iso-test',
});
const asAdmin = <T>(fn: (tx: TenantTx) => Promise<T>) => t.db.withTenant(firmAdmin(), fn);

function sqlState(error: unknown): string | undefined {
  let e: unknown = error;
  while (e && typeof e === 'object') {
    if ('code' in e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    e = 'cause' in e ? e.cause : undefined;
  }
  return undefined;
}
/** The DbError code, or the SQLSTATE of a raw statement; 'resolved' when it did not fail. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof DbError) return e.code;
    return sqlState(e) ?? String(e);
  }
  return 'resolved';
}

const SHA = 'b'.repeat(64);
const day = (value: string) => LocalDate.parse(value);

function newSystem(overrides: Partial<Omit<ManagementSystem, 'id'>> = {}) {
  return {
    clientId: w.kestrel,
    name: 'Kestrel integrated system',
    standardIds: [w.iso9001],
    scopeStatement: null,
    unitIds: [],
    status: 'PLANNING' as const,
    reviewIntervalMonths: 12,
    climateChangeRelevant: null,
    climateChangeRationale: null,
    climateDecidedOn: null,
    ...overrides,
  };
}

function newDocument(managementSystemId: string, code: string) {
  return {
    clientId: w.kestrel,
    managementSystemId,
    code,
    title: `Procedure ${code}`,
    type: 'PROCEDURE' as const,
    clauseIds: [] as string[],
    status: 'ACTIVE' as const,
    currentRevisionId: null,
    ownerId: w.ownerId,
    approverId: w.approverId,
    reviewDueOn: null,
    lastReviewedOn: null,
    retention: null,
    issuer: null,
    externalRef: null,
  };
}

function newRevision(documentId: string, revision: string) {
  return {
    clientId: w.kestrel,
    documentId,
    revision,
    changeNote: 'First issue',
    state: 'DRAFT' as const,
    preparedById: w.ownerId,
    approvedById: null,
    approvedAt: null,
    sendBackReason: null,
  };
}

beforeAll(async () => {
  t = await createTestDatabase();
  firmId = await t.admin.createFirm({ name: 'Demo Advisory' });
  w = await asSystem(async (tx) => {
    const location = await r.locations.create(tx, {
      country: 'India',
      countryCode: 'IN',
      state: 'West Bengal',
      stateCode: 'WB',
      city: 'Riverbend',
    });
    const clientWithUnits = async (name: string, units: string[]) => {
      const client = await r.clients.create(tx, { name, settings: DEFAULT_CLIENT_SETTINGS });
      const company = await r.companies.create(tx, { clientId: client.id, name: `${name} Ltd` });
      const ids: string[] = [];
      for (const unit of units) {
        ids.push(
          (
            await r.units.create(tx, {
              clientId: client.id,
              companyId: company.id,
              name: unit,
              locationId: location.id,
            })
          ).id,
        );
      }
      return { clientId: client.id, unitIds: ids };
    };
    const kestrel = await clientWithUnits('Kestrel Metals Group', ['Riverbend', 'Stonebridge']);
    const osprey = await clientWithUnits('Osprey Textiles Group', ['Highmoor']);
    const person = (name: string) =>
      r.people.create(tx, {
        displayName: name,
        nameNormalized: name.toLowerCase(),
        email: null,
        status: 'UNCLAIMED',
      });
    const [owner, approver, other, admin] = [
      await person('Owner One'),
      await person('Approver One'),
      await person('Other One'),
      await person('Admin One'),
    ];
    const iso9001 = await r.isoCatalogue.createStandard(tx, {
      code: 'ISO_9001',
      edition: '2015+A1:2024',
      title: 'ISO 9001',
      topic: 'Quality management',
    });
    const iso14001 = await r.isoCatalogue.createStandard(tx, {
      code: 'ISO_14001',
      edition: '2015+A1:2024',
      title: 'ISO 14001',
      topic: 'Environmental management',
    });
    // Parents and children in one statement: the copy may set ids itself.
    const ids = {
      '4': '01920000-0000-7000-8000-00000000c004',
      '4.1': '01920000-0000-7000-8000-00000000c041',
    };
    const clause = (standardId: string, number: string, more: Record<string, unknown> = {}) => ({
      standardId,
      number,
      title: `Clause ${number}`,
      summary: 'Our own summary.',
      parentId: null,
      hlsKey: null,
      assessable: true,
      exclusionAllowed: false,
      ...more,
    });
    const created = await r.isoCatalogue.createClauses(tx, [
      clause(iso9001.id, '4', { id: ids['4'], assessable: false, hlsKey: '4' }),
      clause(iso9001.id, '4.1', { id: ids['4.1'], parentId: ids['4'], hlsKey: '4.1' }),
      clause(iso9001.id, '10.1', { hlsKey: '10.1' }),
      clause(iso9001.id, '8.3', { exclusionAllowed: true }),
      clause(iso14001.id, '4.1', { hlsKey: '4.1' }),
    ]);
    const clauses: Record<string, string> = {};
    for (const c of created) {
      clauses[`${c.standardId === iso9001.id ? '9001' : '14001'}:${c.number}`] = c.id;
    }
    await r.isoCatalogue.createReviewInputDefs(tx, [
      {
        standardId: iso9001.id,
        key: 'CUSTOMER_SATISFACTION',
        clauseNumber: '9.3.2',
        item: 'c1',
        title: 'Customer satisfaction',
        source: 'MANUAL',
      },
      {
        standardId: iso9001.id,
        key: 'PREVIOUS_ACTIONS',
        clauseNumber: '9.3.2',
        item: 'a',
        title: 'Actions from previous reviews',
        source: 'PREVIOUS_ACTIONS',
      },
    ]);
    await r.isoCatalogue.createReviewOutputDefs(tx, [
      {
        standardId: iso14001.id,
        key: 'SUITABILITY',
        clauseNumber: '9.3',
        item: null,
        title: 'Suitability of the system',
      },
    ]);
    return {
      kestrel: kestrel.clientId,
      osprey: osprey.clientId,
      riverbend: kestrel.unitIds[0]!,
      stonebridge: kestrel.unitIds[1]!,
      ospreyUnit: osprey.unitIds[0]!,
      ownerId: owner.id,
      approverId: approver.id,
      otherId: other.id,
      adminId: admin.id,
      iso9001: iso9001.id,
      iso14001: iso14001.id,
      clauses,
    };
  });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('the catalogue', () => {
  it('is read by every context of the firm, clauses in reading order', async () => {
    for (const ctx of [clientUser(), consultant(), firmAdmin()]) {
      const read = await t.db.withTenant(ctx, async (tx) => ({
        standards: (await r.isoCatalogue.standards(tx)).map((s) => s.code),
        clauses: (await r.isoCatalogue.clauses(tx, { standardIds: [w.iso9001] })).map(
          (c) => c.number,
        ),
        assessable: (await r.isoCatalogue.clauses(tx, { assessable: false })).map((c) => c.number),
      }));
      expect(read).toEqual({
        standards: ['ISO_9001', 'ISO_14001'],
        clauses: ['4', '4.1', '8.3', '10.1'],
        assessable: ['4'],
      });
    }
    const one = await asAdmin(async (tx) => ({
      standard: await r.isoCatalogue.standard(tx, w.iso9001),
      clause: await r.isoCatalogue.clause(tx, w.clauses['9001:4.1']!),
    }));
    expect(one.standard?.title).toBe('ISO 9001');
    expect(one.clause?.parentId).toBe(w.clauses['9001:4']);
  });

  it('gives the review definitions per standard, by clause and item', async () => {
    const defs = await t.db.withTenant(clientUser(), (tx) => r.isoCatalogue.reviewDefs(tx));
    expect(defs.inputs.map((d) => d.key)).toEqual(['PREVIOUS_ACTIONS', 'CUSTOMER_SATISFACTION']);
    expect(defs.outputs.map((d) => d.key)).toEqual(['SUITABILITY']);
    const only = await asAdmin((tx) =>
      r.isoCatalogue.reviewDefs(tx, { standardIds: [w.iso14001] }),
    );
    expect({ inputs: only.inputs.length, outputs: only.outputs.length }).toEqual({
      inputs: 0,
      outputs: 1,
    });
  });

  it('refuses writes from every context but a system job', async () => {
    for (const ctx of [firmAdmin(), consultant(), clientUser()]) {
      expect(
        await failure(
          t.db.withTenant(ctx, (tx) =>
            r.isoCatalogue.createStandard(tx, {
              code: 'ISO_45001',
              edition: '2018+A1:2024',
              title: 'ISO 45001',
              topic: 'Occupational health and safety',
            }),
          ),
        ),
      ).toBe('FORBIDDEN');
      for (const table of [
        'iso_standard',
        'iso_clause',
        'iso_review_input_def',
        'iso_review_output_def',
      ]) {
        const updated = await t.db.withTenant(ctx, (tx) =>
          tx.execute(sql.raw(`UPDATE "${table}" SET updated_at = updated_at`)),
        );
        expect(updated.rowCount, table).toBe(0);
      }
    }
    const updated = await asSystem((tx) => tx.execute(sql`UPDATE iso_clause SET title = title`));
    expect(updated.rowCount).toBe(5);
  });

  it('checks editions, clause numbers, exclusions and review items, and one edition per code', async () => {
    const bad = [
      sql`INSERT INTO iso_standard (code, edition, title, topic) VALUES ('ISO_45001', '2018 A1', 'ISO 45001', 'OH&S')`,
      sql`INSERT INTO iso_clause (standard_id, number, title, summary, assessable, exclusion_allowed)
        VALUES (${w.iso9001}, '4.', 'x', 'x', true, false)`,
      sql`INSERT INTO iso_clause (standard_id, number, title, summary, assessable, exclusion_allowed)
        VALUES (${w.iso9001}, '7.1', 'x', 'x', false, true)`,
      sql`INSERT INTO iso_review_output_def (standard_id, key, clause_number, item, title)
        VALUES (${w.iso9001}, 'IMPROVEMENT', '9.3.3', 'A1', 'x')`,
    ];
    for (const statement of bad) {
      expect(await failure(asSystem((tx) => tx.execute(statement)))).toBe('23514');
    }
    expect(
      await failure(
        asSystem((tx) =>
          tx.execute(
            sql`INSERT INTO iso_standard (code, edition, title, topic) VALUES ('ISO_9001', '2015+A1:2024', 'ISO 9001', 'x')`,
          ),
        ),
      ),
    ).toBe('23505');
  });
});

describe('management systems', () => {
  it('keep their units as join rows, archived when removed, never deleted', async () => {
    const created = await asAdmin((tx) =>
      r.managementSystems.create(tx, newSystem({ unitIds: [w.riverbend, w.stonebridge] })),
    );
    expect(created.unitIds).toEqual([w.riverbend, w.stonebridge].sort());
    const updated = await asAdmin((tx) =>
      r.managementSystems.update(tx, created.id, created.version, {
        unitIds: [w.stonebridge],
        name: 'Kestrel QMS',
      }),
    );
    expect(updated).toMatchObject({ name: 'Kestrel QMS', unitIds: [w.stonebridge], version: 2 });
    const back = await asAdmin((tx) =>
      r.managementSystems.update(tx, created.id, 2, { unitIds: [w.riverbend, w.stonebridge] }),
    );
    expect(back).toMatchObject({ unitIds: [w.riverbend, w.stonebridge].sort(), version: 3 });
    const { rows } = await t.ownerQuery<{ unit: string; archived: boolean }>(
      `SELECT unit_id AS unit, archived_at IS NOT NULL AS archived FROM management_system_unit
       WHERE management_system_id = $1 ORDER BY created_at, id`,
      [created.id],
    );
    expect(rows.filter((x) => x.archived).map((x) => x.unit)).toEqual([w.riverbend]);
    expect(rows.filter((x) => !x.archived)).toHaveLength(2);
    expect(await asAdmin((tx) => r.managementSystems.get(tx, created.id))).toEqual(back);
    expect(await asAdmin((tx) => r.managementSystems.update(tx, created.id, 3, {}))).toMatchObject({
      version: 4,
    });
    expect(
      await failure(asAdmin((tx) => r.managementSystems.update(tx, created.id, 3, { name: 'x' }))),
    ).toBe('STALE_VERSION');
  });

  it('let standards grow, never shrink, and keep a climate decision once made', async () => {
    const ms = await asAdmin((tx) => r.managementSystems.create(tx, newSystem()));
    const grown = await asAdmin((tx) =>
      r.managementSystems.update(tx, ms.id, 1, { standardIds: [w.iso9001, w.iso14001] }),
    );
    expect(grown.standardIds).toEqual([w.iso9001, w.iso14001]);
    expect(
      await failure(
        asAdmin((tx) => r.managementSystems.update(tx, ms.id, 2, { standardIds: [w.iso14001] })),
      ),
    ).toBe('VALIDATION');
    const decided = await asAdmin((tx) =>
      r.managementSystems.update(tx, ms.id, 2, {
        climateChangeRelevant: false,
        climateChangeRationale: 'Indoor finishing only.',
        climateDecidedOn: day('2026-10-01'),
      }),
    );
    expect(decided.climateChangeRelevant).toBe(false);
    expect(
      await failure(
        asAdmin((tx) =>
          r.managementSystems.update(tx, ms.id, 3, {
            climateChangeRelevant: null,
            climateChangeRationale: null,
            climateDecidedOn: null,
          }),
        ),
      ),
    ).toBe('VALIDATION');
    for (const statement of [
      sql`UPDATE management_system SET climate_change_rationale = null WHERE id = ${ms.id}`,
      sql`UPDATE management_system SET standard_ids = ARRAY[${w.iso9001}, ${w.iso9001}]::uuid[] WHERE id = ${ms.id}`,
      sql`UPDATE management_system SET review_interval_months = 0 WHERE id = ${ms.id}`,
    ]) {
      expect(await failure(asAdmin((tx) => tx.execute(statement)))).toBe('23514');
    }
  });

  it('list by name with search, status, paging, count and unit scope', async () => {
    await asAdmin(async (tx) => {
      await r.managementSystems.create(
        tx,
        newSystem({ name: 'Riverbend EMS', unitIds: [w.riverbend], status: 'IMPLEMENTING' }),
      );
      await r.managementSystems.create(
        tx,
        newSystem({ name: 'Stonebridge EMS', unitIds: [w.stonebridge], status: 'IMPLEMENTING' }),
      );
      await r.managementSystems.create(
        tx,
        newSystem({ clientId: w.osprey, name: 'Osprey QMS', unitIds: [w.ospreyUnit] }),
      );
    });
    const names = (page: { items: ManagementSystem[] }) => page.items.map((m) => m.name);
    const first = await asAdmin((tx) =>
      r.managementSystems.list(tx, w.kestrel, { status: ['IMPLEMENTING'], limit: 1, count: true }),
    );
    expect({ names: names(first), total: first.total }).toEqual({
      names: ['Riverbend EMS'],
      total: 2,
    });
    const second = await asAdmin((tx) =>
      r.managementSystems.list(tx, w.kestrel, {
        status: ['IMPLEMENTING'],
        limit: 1,
        cursor: first.nextCursor,
      }),
    );
    expect({ names: names(second), next: second.nextCursor }).toEqual({
      names: ['Stonebridge EMS'],
      next: null,
    });
    expect(
      names(await asAdmin((tx) => r.managementSystems.list(tx, w.kestrel, { q: 'stoneBRIDGE' }))),
    ).toEqual(['Stonebridge EMS']);
    expect(
      names(await asAdmin((tx) => r.managementSystems.list(tx, w.kestrel, { status: [] }))),
    ).toEqual([]);
    // A Stonebridge member sees the Stonebridge system and every system without units, never Riverbend's.
    const scoped = await t.db.withTenant(clientUser(), (tx) =>
      r.managementSystems.list(tx, w.kestrel, {
        scope: { unitIds: [w.stonebridge], personId: w.ownerId },
      }),
    );
    expect(names(scoped)).not.toContain('Riverbend EMS');
    expect(names(scoped)).toContain('Stonebridge EMS');
    expect(names(scoped)).toContain('Kestrel integrated system');
    // A client user of Kestrel never sees Osprey's.
    expect(
      await t.db.withTenant(clientUser(), (tx) => r.managementSystems.list(tx, w.osprey)),
    ).toEqual({ items: [], nextCursor: null });
  });

  it('archive like every record, and leave archived ones out of lists', async () => {
    const ms = await asAdmin((tx) => r.managementSystems.create(tx, newSystem({ name: 'Zz old' })));
    const archived = await asAdmin((tx) => r.managementSystems.archive(tx, ms.id, 1));
    expect(archived.archivedAt).not.toBeNull();
    const list = (includeArchived: boolean) =>
      asAdmin(
        async (tx) =>
          (await r.managementSystems.list(tx, w.kestrel, { includeArchived, q: 'Zz' })).items
            .length,
      );
    expect([await list(false), await list(true)]).toEqual([0, 1]);
    expect(
      await asAdmin((tx) => r.managementSystems.get(tx, '01920000-0000-7000-8000-0000000000aa')),
    ).toBeNull();
  });
});

describe('references stay inside one client', () => {
  let kestrelSystem: ManagementSystem;
  let ospreySystem: ManagementSystem;
  beforeAll(async () => {
    [kestrelSystem, ospreySystem] = await asAdmin(async (tx) => [
      await r.managementSystems.create(tx, newSystem({ name: 'Kestrel refs' })),
      await r.managementSystems.create(tx, newSystem({ clientId: w.osprey, name: 'Osprey refs' })),
    ]);
  });

  it('a system cannot list another client’s unit', async () => {
    expect(
      await failure(
        asAdmin((tx) =>
          r.managementSystems.create(tx, newSystem({ unitIds: [w.ospreyUnit], name: 'Cross' })),
        ),
      ),
    ).toBe('NOT_FOUND');
  });

  it('a record cannot point at another client’s system, document, certificate or ISO record', async () => {
    const kestrelDoc = await asAdmin((tx) =>
      r.controlledDocuments.create(tx, newDocument(kestrelSystem.id, 'REF-01')),
    );
    const statements = [
      sql`INSERT INTO context_item (client_id, management_system_id, kind, text)
        VALUES (${w.kestrel}, ${ospreySystem.id}, 'INTERNAL_ISSUE', 'x')`,
      sql`INSERT INTO clause_assessment (client_id, management_system_id, clause_id)
        VALUES (${w.osprey}, ${kestrelSystem.id}, ${w.clauses['9001:4.1']})`,
      sql`INSERT INTO document_revision (client_id, document_id, revision, prepared_by_id)
        VALUES (${w.osprey}, ${kestrelDoc.id}, 'A', ${w.ownerId})`,
      sql`INSERT INTO certification (client_id, management_system_id, standard_id, body)
        VALUES (${w.osprey}, ${kestrelSystem.id}, ${w.iso9001}, 'Osprey Certification')`,
      sql`INSERT INTO external_audit (client_id, management_system_id, standard_ids, type, body, start_on, end_on)
        VALUES (${w.osprey}, ${kestrelSystem.id}, ARRAY[${w.iso9001}]::uuid[], 'STAGE_1', 'x', '2026-11-01', '2026-11-01')`,
      sql`INSERT INTO management_system_unit (client_id, management_system_id, unit_id)
        VALUES (${w.kestrel}, ${kestrelSystem.id}, ${w.ospreyUnit})`,
    ];
    for (const statement of statements) {
      expect(await failure(asAdmin((tx) => tx.execute(statement)))).toBe('23503');
    }
    const cert = await asAdmin((tx) =>
      r.certifications.create(tx, {
        clientId: w.osprey,
        managementSystemId: ospreySystem.id,
        standardId: w.iso9001,
        body: 'Osprey Certification',
        certificateNumber: null,
        issuedOn: null,
        expiresOn: null,
        scopeText: null,
        unitIds: [],
      }),
    );
    expect(
      await failure(
        asAdmin((tx) =>
          tx.execute(sql`INSERT INTO certification_unit (client_id, certification_id, unit_id)
            VALUES (${w.osprey}, ${cert.id}, ${w.riverbend})`),
        ),
      ),
    ).toBe('23503');
    expect(
      await failure(
        asAdmin((tx) =>
          r.isoFiles.create(tx, {
            clientId: w.kestrel,
            subject: { type: 'certification', id: cert.id },
            fileName: 'certificate.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 10,
            sha256: SHA,
            storageKey: `evidence/${firmId}/${w.kestrel}/iso/certification/${cert.id}/x`,
            uploadedById: w.ownerId,
          }),
        ),
      ),
    ).toBe('NOT_FOUND');
  });

  it('a client user of one client cannot write records of another', async () => {
    expect(
      await failure(
        t.db.withTenant(clientUser(), (tx) =>
          r.contextItems.create(tx, {
            clientId: w.osprey,
            managementSystemId: ospreySystem.id,
            kind: 'INTERNAL_ISSUE',
            text: 'x',
            needs: null,
            climateRelated: false,
            reviewedOn: null,
          }),
        ),
      ),
    ).toBe('FORBIDDEN');
  });
});

describe('context items', () => {
  it('are listed per system with kind and climate filters, and archived', async () => {
    const ms = await asAdmin((tx) =>
      r.managementSystems.create(tx, newSystem({ name: 'Context' })),
    );
    const item = (kind: 'INTERNAL_ISSUE' | 'INTERESTED_PARTY', climateRelated: boolean) => ({
      clientId: w.kestrel,
      managementSystemId: ms.id,
      kind,
      text: `${kind} item`,
      needs: kind === 'INTERESTED_PARTY' ? 'Permits renewed on time' : null,
      climateRelated,
      reviewedOn: null,
    });
    const [issue, party] = await asAdmin(async (tx) => [
      await r.contextItems.create(tx, item('INTERNAL_ISSUE', true)),
      await r.contextItems.create(tx, item('INTERESTED_PARTY', false)),
    ]);
    const list = (f: r.ContextItemFilter = {}) =>
      asAdmin(async (tx) => (await r.contextItems.list(tx, ms.id, f)).map((c) => c.id));
    expect(await list()).toEqual([issue!.id, party!.id]);
    expect(await list({ kind: ['INTERESTED_PARTY'] })).toEqual([party!.id]);
    expect(await list({ climateRelated: true })).toEqual([issue!.id]);
    expect(await list({ kind: [] })).toEqual([]);
    const edited = await asAdmin((tx) =>
      r.contextItems.update(tx, issue!.id, 1, { reviewedOn: day('2026-10-20') }),
    );
    expect(edited).toMatchObject({ reviewedOn: day('2026-10-20'), version: 2 });
    await asAdmin((tx) => r.contextItems.archive(tx, issue!.id, 2));
    expect(await list()).toEqual([party!.id]);
    expect(await list({ includeArchived: true })).toHaveLength(2);
    expect(await asAdmin((tx) => r.contextItems.require(tx, party!.id))).toMatchObject({
      needs: 'Permits renewed on time',
    });
    expect(
      await failure(
        asAdmin((tx) =>
          tx.execute(sql`UPDATE context_item SET needs = 'x' WHERE id = ${issue!.id}`),
        ),
      ),
    ).toBe('23514');
  });
});

describe('the clause checklist', () => {
  let ms: ManagementSystem;
  beforeAll(async () => {
    ms = await asAdmin((tx) =>
      r.managementSystems.create(tx, newSystem({ name: 'Checklist', unitIds: [w.riverbend] })),
    );
  });

  it('gets one NOT_STARTED row per assessable clause, added once per standard', async () => {
    const added = await asAdmin((tx) => r.clauseAssessments.addForStandards(tx, ms, [w.iso9001]));
    expect(added.map((a) => a.status)).toEqual(['NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED']);
    expect(await asAdmin((tx) => r.clauseAssessments.addForStandards(tx, ms, [w.iso9001]))).toEqual(
      [],
    );
    await asAdmin((tx) => r.clauseAssessments.addForStandards(tx, ms, [w.iso9001, w.iso14001]));
    const rows = await asAdmin((tx) => r.clauseAssessments.list(tx, ms.id));
    expect(
      rows.map((x) => [x.standardId === w.iso9001 ? '9001' : '14001', x.clauseNumber]),
    ).toEqual([
      ['9001', '4.1'],
      ['9001', '8.3'],
      ['9001', '10.1'],
      ['14001', '4.1'],
    ]);
    expect(rows.find((x) => x.clauseNumber === '8.3')).toMatchObject({
      exclusionAllowed: true,
      clauseTitle: 'Clause 8.3',
    });
    expect(
      (await asAdmin((tx) => r.clauseAssessments.list(tx, ms.id, { standardIds: [w.iso14001] })))
        .length,
    ).toBe(1);
  });

  it('keeps the N/A rules of the contracts', async () => {
    const row = (await asAdmin((tx) => r.clauseAssessments.list(tx, ms.id))).find(
      (x) => x.clauseNumber === '8.3' && x.standardId === w.iso9001,
    )!;
    // NOT_APPLICABLE only with an open request, and a request needs its justification and requester.
    expect(
      await failure(
        asAdmin((tx) => r.clauseAssessments.update(tx, row.id, 1, { status: 'NOT_APPLICABLE' })),
      ),
    ).toBe('VALIDATION');
    for (const statement of [
      sql`UPDATE clause_assessment SET status = 'NOT_APPLICABLE', na_state = 'REQUESTED', status_before_na = 'NOT_STARTED', na_requested_by_id = ${w.ownerId} WHERE id = ${row.id}`,
      sql`UPDATE clause_assessment SET status_before_na = 'NOT_APPLICABLE' WHERE id = ${row.id}`,
      sql`UPDATE clause_assessment SET na_decided_at = now() WHERE id = ${row.id}`,
    ]) {
      expect(await failure(asAdmin((tx) => tx.execute(statement)))).toBe('23514');
    }
    const requested = await asAdmin((tx) =>
      r.clauseAssessments.update(tx, row.id, 1, {
        status: 'NOT_APPLICABLE',
        naState: 'REQUESTED',
        statusBeforeNa: 'PARTIAL',
        justification: 'No design and development at this site.',
        naRequestedById: w.ownerId,
      }),
    );
    expect(requested).toMatchObject({ naState: 'REQUESTED', version: 2 });
    // The requester never decides their own request.
    expect(
      await failure(
        asAdmin((tx) =>
          r.clauseAssessments.update(tx, row.id, 2, {
            naState: 'APPROVED',
            naDecidedById: w.ownerId,
            naDecidedAt: '2026-10-21T05:00:00.000Z',
          }),
        ),
      ),
    ).toBe('VALIDATION');
    const approved = await asAdmin((tx) =>
      r.clauseAssessments.update(tx, row.id, 2, {
        naState: 'APPROVED',
        naDecidedById: w.approverId,
        naDecidedAt: '2026-10-21T05:00:00.000Z',
      }),
    );
    expect(approved).toMatchObject({
      naState: 'APPROVED',
      naDecidedAt: '2026-10-21T05:00:00.000Z',
    });
    expect(
      (await asAdmin((tx) => r.clauseAssessments.list(tx, ms.id, { naState: ['APPROVED'] }))).map(
        (x) => x.id,
      ),
    ).toEqual([row.id]);
    expect(
      await asAdmin((tx) => r.clauseAssessments.list(tx, ms.id, { status: [], naState: [] })),
    ).toEqual([]);
    expect(
      await failure(
        asAdmin((tx) =>
          tx.execute(sql`INSERT INTO clause_assessment (client_id, management_system_id, clause_id)
            VALUES (${w.kestrel}, ${ms.id}, ${w.clauses['9001:4.1']})`),
        ),
      ),
    ).toBe('23505');
  });

  it('applies unit scope: the system’s units, or the row’s owner', async () => {
    const rows = await asAdmin((tx) => r.clauseAssessments.list(tx, ms.id));
    const owned = rows.find((x) => x.clauseNumber === '10.1')!;
    await asAdmin((tx) =>
      r.clauseAssessments.update(tx, owned.id, owned.version, { ownerId: w.otherId }),
    );
    const scoped = (scope: r.UnitScope) =>
      t.db.withTenant(clientUser(), async (tx) =>
        (await r.clauseAssessments.list(tx, ms.id, { scope })).map((x) => x.id),
      );
    expect(await scoped({ unitIds: [w.riverbend], personId: w.ownerId })).toHaveLength(rows.length);
    expect(await scoped({ unitIds: [w.stonebridge], personId: w.ownerId })).toEqual([]);
    expect(await scoped({ unitIds: [w.stonebridge], personId: w.otherId })).toEqual([owned.id]);
    expect(await scoped({ unitIds: [], personId: null })).toEqual([]);
    expect(
      (await asAdmin((tx) => r.clauseAssessments.list(tx, ms.id, { ownerId: w.otherId }))).map(
        (x) => x.id,
      ),
    ).toEqual([owned.id]);
  });
});

describe('controlled documents and revisions', () => {
  let ms: ManagementSystem;
  beforeAll(async () => {
    ms = await asAdmin((tx) =>
      r.managementSystems.create(tx, newSystem({ name: 'Documents', unitIds: [w.riverbend] })),
    );
  });

  it('keep codes unique per client and the type fields to their types', async () => {
    await asAdmin((tx) => r.controlledDocuments.create(tx, newDocument(ms.id, 'QP-07')));
    expect(
      await failure(asAdmin((tx) => r.controlledDocuments.create(tx, newDocument(ms.id, 'QP-07')))),
    ).toBe('DUPLICATE');
    expect(
      await failure(
        asAdmin((tx) =>
          r.controlledDocuments.create(tx, {
            ...newDocument(ms.id, 'QP-08'),
            retention: '7 years',
          }),
        ),
      ),
    ).toBe('VALIDATION');
    for (const statement of [
      sql`INSERT INTO controlled_document (client_id, management_system_id, code, title, type, owner_id, approver_id, issuer)
        VALUES (${w.kestrel}, ${ms.id}, 'X-1', 'x', 'POLICY', ${w.ownerId}, ${w.approverId}, 'BIS')`,
      sql`INSERT INTO controlled_document (client_id, management_system_id, code, title, type, owner_id, approver_id, clause_ids)
        VALUES (${w.kestrel}, ${ms.id}, 'X-2', 'x', 'POLICY', ${w.ownerId}, ${w.approverId}, ARRAY[${w.iso9001}, ${w.iso9001}]::uuid[])`,
    ]) {
      expect(await failure(asAdmin((tx) => tx.execute(statement)))).toBe('23514');
    }
  });

  it('allow one open revision, an approver who is not the preparer, and a current revision that is approved', async () => {
    const doc = await asAdmin((tx) =>
      r.controlledDocuments.create(tx, newDocument(ms.id, 'QP-10')),
    );
    const draft = await asAdmin((tx) => r.documentRevisions.create(tx, newRevision(doc.id, 'A')));
    expect(
      await failure(asAdmin((tx) => r.documentRevisions.create(tx, newRevision(doc.id, 'B')))),
    ).toBe('DUPLICATE');
    expect(
      await failure(
        asAdmin((tx) =>
          r.controlledDocuments.update(tx, doc.id, 1, { currentRevisionId: draft.id }),
        ),
      ),
    ).toBe('VALIDATION');
    expect(
      await failure(
        asAdmin((tx) =>
          r.documentRevisions.update(tx, draft.id, 1, {
            state: 'APPROVED',
            approvedById: w.ownerId,
            approvedAt: '2026-10-22T05:00:00.000Z',
          }),
        ),
      ),
    ).toBe('VALIDATION');
    for (const statement of [
      sql`UPDATE document_revision SET state = 'APPROVED' WHERE id = ${draft.id}`,
      sql`UPDATE document_revision SET approved_by_id = ${w.approverId} WHERE id = ${draft.id}`,
    ]) {
      expect(await failure(asAdmin((tx) => tx.execute(statement)))).toBe('23514');
    }
    // APPROVE: the revision first, then the document's current revision.
    const current = await asAdmin(async (tx) => {
      const approved = await r.documentRevisions.update(tx, draft.id, 1, {
        state: 'APPROVED',
        approvedById: w.approverId,
        approvedAt: '2026-10-22T05:00:00.000Z',
      });
      return r.controlledDocuments.update(tx, doc.id, 1, { currentRevisionId: approved.id });
    });
    expect(current.currentRevisionId).toBe(draft.id);
    // A second APPROVED revision is refused until the first is SUPERSEDED.
    const next = await asAdmin((tx) =>
      r.documentRevisions.create(tx, { ...newRevision(doc.id, 'B'), preparedById: w.otherId }),
    );
    expect(
      await failure(
        asAdmin((tx) =>
          r.documentRevisions.update(tx, next.id, 1, {
            state: 'APPROVED',
            approvedById: w.approverId,
            approvedAt: '2026-10-23T05:00:00.000Z',
          }),
        ),
      ),
    ).toBe('DUPLICATE');
    expect(
      (await asAdmin((tx) => r.documentRevisions.forDocument(tx, doc.id))).map((x) => x.revision),
    ).toEqual(['B', 'A']);
    expect(await asAdmin((tx) => r.documentRevisions.require(tx, next.id))).toMatchObject({
      state: 'DRAFT',
      preparedById: w.otherId,
    });
    // Another document's approved revision is not this one's.
    const other = await asAdmin((tx) =>
      r.controlledDocuments.create(tx, newDocument(ms.id, 'QP-11')),
    );
    expect(
      await failure(
        asAdmin((tx) =>
          r.controlledDocuments.update(tx, other.id, 1, { currentRevisionId: draft.id }),
        ),
      ),
    ).toBe('VALIDATION');
  });

  it('list by code: ACTIVE by default, filters, search, clause overlap and unit scope', async () => {
    const [policy, obsolete, external] = await asAdmin(async (tx) => [
      await r.controlledDocuments.create(tx, {
        ...newDocument(ms.id, 'AA-POL'),
        type: 'POLICY',
        title: 'Environmental policy',
        clauseIds: [w.clauses['9001:4.1']!],
        ownerId: w.otherId,
        approverId: w.otherId,
      }),
      await r.controlledDocuments.create(tx, {
        ...newDocument(ms.id, 'AA-OLD'),
        status: 'OBSOLETE',
      }),
      await r.controlledDocuments.create(tx, {
        ...newDocument(ms.id, 'AA-EXT'),
        type: 'EXTERNAL',
        issuer: 'Pollution Control Board',
        externalRef: 'CTO-2026',
      }),
    ]);
    const codes = async (f: r.DocumentFilter, ctx = firmAdmin()) =>
      (await t.db.withTenant(ctx, (tx) => r.controlledDocuments.list(tx, w.kestrel, f))).items.map(
        (d) => d.code,
      );
    expect(await codes({ q: 'AA-' })).toEqual(['AA-EXT', 'AA-POL']);
    expect(await codes({ q: 'aa-', status: ['ACTIVE', 'OBSOLETE'] })).toEqual([
      'AA-EXT',
      'AA-OLD',
      'AA-POL',
    ]);
    expect(await codes({ q: 'environmental' })).toEqual(['AA-POL']);
    expect(await codes({ type: ['EXTERNAL'] })).toEqual(['AA-EXT']);
    expect(await codes({ clauseIds: [w.clauses['9001:4.1']!] })).toEqual(['AA-POL']);
    expect(await codes({ ownerId: w.otherId })).toEqual(['AA-POL']);
    expect(await codes({ approverId: w.otherId, managementSystemIds: [ms.id] })).toEqual([
      'AA-POL',
    ]);
    expect(await codes({ status: [] })).toEqual([]);
    const page = await asAdmin((tx) =>
      r.controlledDocuments.list(tx, w.kestrel, { q: 'AA-', limit: 1, count: true }),
    );
    expect({ codes: page.items.map((d) => d.code), total: page.total }).toEqual({
      codes: ['AA-EXT'],
      total: 2,
    });
    const rest = await asAdmin((tx) =>
      r.controlledDocuments.list(tx, w.kestrel, { q: 'AA-', limit: 1, cursor: page.nextCursor }),
    );
    expect(rest.items.map((d) => d.code)).toEqual(['AA-POL']);
    // Out of the system's units, only the documents naming the person stay in scope.
    expect(
      await codes(
        { q: 'AA-', scope: { unitIds: [w.stonebridge], personId: w.otherId } },
        clientUser(),
      ),
    ).toEqual(['AA-POL']);
    expect(
      await codes({ q: 'AA-', scope: { unitIds: [w.riverbend], personId: null } }, clientUser()),
    ).toEqual(['AA-EXT', 'AA-POL']);
    expect([policy!.type, obsolete!.status, external!.issuer]).toEqual([
      'POLICY',
      'OBSOLETE',
      'Pollution Control Board',
    ]);
    expect(await asAdmin((tx) => r.controlledDocuments.archive(tx, obsolete!.id, 1))).toMatchObject(
      {
        version: 2,
      },
    );
  });
});

describe('certificates and external audits', () => {
  let ms: ManagementSystem;
  beforeAll(async () => {
    ms = await asAdmin((tx) =>
      r.managementSystems.create(
        tx,
        newSystem({ name: 'Certified', unitIds: [w.riverbend, w.stonebridge] }),
      ),
    );
  });
  const newCertificate = (unitIds: string[]) => ({
    clientId: w.kestrel,
    managementSystemId: ms.id,
    standardId: w.iso9001,
    body: 'Osprey Certification',
    certificateNumber: null,
    issuedOn: null,
    expiresOn: null,
    scopeText: null,
    unitIds,
  });

  it('record a certificate before it is issued, then issue it with number and dates together', async () => {
    const pursued = await asAdmin((tx) =>
      r.certifications.create(tx, newCertificate([w.riverbend])),
    );
    expect(pursued).toMatchObject({ certificateNumber: null, unitIds: [w.riverbend] });
    expect(
      await failure(
        asAdmin((tx) =>
          tx.execute(
            sql`UPDATE certification SET issued_on = '2026-01-01' WHERE id = ${pursued.id}`,
          ),
        ),
      ),
    ).toBe('23514');
    expect(
      await failure(
        asAdmin((tx) =>
          tx.execute(sql`UPDATE certification SET issued_on = '2026-01-01', expires_on = '2026-01-01',
            certificate_number = 'QMS-1' WHERE id = ${pursued.id}`),
        ),
      ),
    ).toBe('23514');
    const issued = await asAdmin((tx) =>
      r.certifications.update(tx, pursued.id, 1, {
        certificateNumber: 'QMS-0042',
        issuedOn: day('2026-01-15'),
        expiresOn: day('2029-01-14'),
        unitIds: [w.stonebridge],
      }),
    );
    expect(issued).toMatchObject({
      certificateNumber: 'QMS-0042',
      unitIds: [w.stonebridge],
      version: 2,
    });
    expect(await asAdmin((tx) => r.certifications.get(tx, pursued.id))).toEqual(issued);
    expect(await asAdmin((tx) => r.certifications.archive(tx, pursued.id, 2))).toMatchObject({
      unitIds: [w.stonebridge],
    });
    expect(
      await asAdmin((tx) => r.certifications.get(tx, '01920000-0000-7000-8000-0000000000ab')),
    ).toBeNull();
  });

  it('list certificates with unit scope: their own units, or none and the system’s', async () => {
    const [riverbend, systemWide] = await asAdmin(async (tx) => [
      await r.certifications.create(tx, newCertificate([w.riverbend])),
      await r.certifications.create(tx, { ...newCertificate([]), standardId: w.iso14001 }),
    ]);
    const ids = async (f: r.CertificationFilter) =>
      (
        await t.db.withTenant(clientUser(), (tx) =>
          r.certifications.list(tx, w.kestrel, { managementSystemIds: [ms.id], ...f }),
        )
      ).items.map((c) => c.id);
    expect(await ids({})).toEqual([riverbend!.id, systemWide!.id]);
    expect(await ids({ standardIds: [w.iso14001] })).toEqual([systemWide!.id]);
    expect(await ids({ scope: { unitIds: [w.stonebridge], personId: w.ownerId } })).toEqual([
      systemWide!.id,
    ]);
    expect(await ids({ scope: { unitIds: [w.riverbend], personId: null } })).toEqual([
      riverbend!.id,
      systemWide!.id,
    ]);
    expect(await ids({ includeArchived: true, count: true, limit: 1 })).toHaveLength(1);
  });

  it('list external audits by start date, with state, type and date filters', async () => {
    const audit = (type: 'STAGE_1' | 'STAGE_2', startOn: string) => ({
      clientId: w.kestrel,
      managementSystemId: ms.id,
      standardIds: [w.iso9001, w.iso14001],
      type,
      body: 'Osprey Certification',
      leadAuditorName: null,
      startOn: day(startOn),
      endOn: day(startOn),
      recommendation: null,
      responseDueOn: null,
      state: 'PLANNED' as const,
      cancelReason: null,
    });
    const [late, early] = await asAdmin(async (tx) => [
      await r.externalAudits.create(tx, audit('STAGE_2', '2027-02-01')),
      await r.externalAudits.create(tx, audit('STAGE_1', '2026-12-01')),
    ]);
    const ids = async (f: r.ExternalAuditFilter) =>
      (await asAdmin((tx) => r.externalAudits.list(tx, w.kestrel, f))).items.map((a) => a.id);
    expect(await ids({})).toEqual([early!.id, late!.id]);
    expect(await ids({ from: '2027-01-01' })).toEqual([late!.id]);
    expect(await ids({ to: '2026-12-31', type: ['STAGE_1'] })).toEqual([early!.id]);
    expect(await ids({ state: ['HELD'] })).toEqual([]);
    expect(await ids({ managementSystemIds: [ms.id], limit: 1, count: true })).toEqual([early!.id]);
    expect(
      await t.db.withTenant(
        clientUser(),
        async (tx) =>
          (
            await r.externalAudits.list(tx, w.kestrel, {
              scope: { unitIds: [w.ospreyUnit], personId: w.ownerId },
            })
          ).items.length,
      ),
    ).toBe(0);
    const cancelled = await asAdmin((tx) =>
      r.externalAudits.update(tx, late!.id, 1, {
        state: 'CANCELLED',
        cancelReason: 'Moved to May.',
      }),
    );
    expect(cancelled.state).toBe('CANCELLED');
    expect(await asAdmin((tx) => r.externalAudits.require(tx, late!.id))).toEqual(cancelled);
    for (const statement of [
      sql`UPDATE external_audit SET cancel_reason = null WHERE id = ${late!.id}`,
      sql`UPDATE external_audit SET state = 'CLOSED' WHERE id = ${early!.id}`,
      sql`UPDATE external_audit SET end_on = '2026-11-30' WHERE id = ${early!.id}`,
      sql`UPDATE external_audit SET standard_ids = '{}' WHERE id = ${early!.id}`,
    ]) {
      expect(await failure(asAdmin((tx) => tx.execute(statement)))).toBe('23514');
    }
    expect(await asAdmin((tx) => r.externalAudits.archive(tx, early!.id, 1))).toMatchObject({
      version: 2,
    });
  });
});

describe('ISO files', () => {
  let ms: ManagementSystem;
  let rowId: string;
  let auditId: string;
  const key = (subject: string, id: string, n: string) =>
    `evidence/${firmId}/${w.kestrel}/iso/${subject}/${id}/${n}`;
  const file = (subject: r.NewIsoFile['subject'], n: string) => ({
    clientId: w.kestrel,
    subject,
    fileName: `${n}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    sha256: SHA,
    storageKey: key(subject.type, subject.id, n),
    uploadedById: w.ownerId,
  });

  beforeAll(async () => {
    ms = await asAdmin((tx) => r.managementSystems.create(tx, newSystem({ name: 'Files' })));
    rowId = (await asAdmin((tx) => r.clauseAssessments.addForStandards(tx, ms, [w.iso9001])))[0]!
      .id;
    auditId = (
      await asAdmin((tx) =>
        r.externalAudits.create(tx, {
          clientId: w.kestrel,
          managementSystemId: ms.id,
          standardIds: [w.iso9001],
          type: 'SURVEILLANCE_1',
          body: 'Osprey Certification',
          leadAuditorName: 'A. Auditor',
          startOn: day('2026-09-01'),
          endOn: day('2026-09-02'),
          recommendation: null,
          responseDueOn: null,
          state: 'PLANNED',
          cancelReason: null,
        }),
      )
    ).id;
  });

  it('are created PENDING on exactly one subject, and viewed without their storage key', async () => {
    const created = await asAdmin((tx) =>
      r.isoFiles.create(tx, file({ type: 'clause_assessment', id: rowId }, 'gap')),
    );
    expect(created).toMatchObject({
      scanStatus: 'PENDING',
      clauseAssessmentId: rowId,
      riskItemId: null,
      archivedAt: null,
      removeReason: null,
    });
    const view = r.isoFileView(created);
    expect(view.subject).toEqual({ type: 'clause_assessment', id: rowId });
    expect(view).not.toHaveProperty('storageKey');
    expect(view).not.toHaveProperty('clauseAssessmentId');
    expect(await asAdmin((tx) => r.isoFiles.get(tx, created.id))).toEqual(created);
    expect(r.isoFileSubject(created)).toEqual({ type: 'clause_assessment', id: rowId });
  });

  it('refuse no subject, two subjects, a subject not stored yet, and a key outside the account prefix', async () => {
    const insert = (row: string | null, audit: string | null, n: string) =>
      asAdmin((tx) =>
        tx.execute(sql`INSERT INTO iso_file (client_id, clause_assessment_id, external_audit_id, file_name, mime_type,
            size_bytes, sha256, storage_key, uploaded_by_id)
          VALUES (${w.kestrel}, ${row}, ${audit}, 'x.pdf', 'application/pdf', 1, ${SHA},
            ${key('raw', auditId, n)}, ${w.ownerId})`),
      );
    expect(await failure(insert(null, null, 'none'))).toBe('23514');
    expect(await failure(insert(rowId, auditId, 'two'))).toBe('23514');
    expect(await failure(insert(null, auditId, 'one'))).toBe('resolved');
    expect(
      await failure(
        asAdmin((tx) => r.isoFiles.create(tx, file({ type: 'risk_item', id: rowId }, 'risk'))),
      ),
    ).toBe('VALIDATION');
    expect(
      await failure(
        asAdmin((tx) =>
          r.isoFiles.create(tx, {
            ...file({ type: 'external_audit', id: auditId }, 'report'),
            storageKey: `evidence/${firmId}/${w.osprey}/iso/external_audit/${auditId}/report`,
          }),
        ),
      ),
    ).toBe('VALIDATION');
    expect(
      await failure(
        asAdmin((tx) =>
          r.isoFiles.create(tx, {
            ...file({ type: 'external_audit', id: auditId }, 'big'),
            sizeBytes: 0,
          }),
        ),
      ),
    ).toBe('VALIDATION');
  });

  it('list by subject, scan oldest first without instances, archive with a reason, and feed the client archive', async () => {
    const [report, minutes] = await asAdmin(async (tx) => [
      await r.isoFiles.create(tx, file({ type: 'external_audit', id: auditId }, 'report')),
      await r.isoFiles.create(tx, file({ type: 'external_audit', id: auditId }, 'minutes')),
    ]);
    const subject = { type: 'external_audit' as const, id: auditId };
    const listed = await asAdmin((tx) => r.isoFiles.forSubject(tx, subject));
    expect(listed.map((f) => f.fileName)).toEqual(['x.pdf', 'report.pdf', 'minutes.pdf']);

    const pending = await asSystem((tx) => r.isoFiles.pendingScan(tx, 200));
    expect(pending.length).toBeGreaterThanOrEqual(4);
    expect(pending.map((f) => f.createdAt)).toEqual([...pending.map((f) => f.createdAt)].sort());
    expect(await asSystem((tx) => r.isoFiles.pendingScan(tx, 1))).toHaveLength(1);
    expect(await failure(asSystem((tx) => r.isoFiles.pendingScan(tx, 0)))).toBe('VALIDATION');

    const clean = await asSystem((tx) => r.isoFiles.setScanStatus(tx, report!.id, 'CLEAN'));
    expect(clean.scanStatus).toBe('CLEAN');
    expect(
      (await asSystem((tx) => r.isoFiles.pendingScan(tx, 200))).map((f) => f.id),
    ).not.toContain(report!.id);

    const removed = await asAdmin((tx) => r.isoFiles.archive(tx, minutes!.id, 'Wrong visit.'));
    expect(removed).toMatchObject({ removeReason: 'Wrong visit.' });
    expect(removed.archivedAt).not.toBeNull();
    expect(await failure(asAdmin((tx) => r.isoFiles.archive(tx, minutes!.id, 'Again.')))).toBe(
      'NOT_FOUND',
    );
    expect(await failure(asAdmin((tx) => r.isoFiles.archive(tx, report!.id, '')))).toBe(
      'VALIDATION',
    );
    expect(
      (await asAdmin((tx) => r.isoFiles.forSubject(tx, subject))).map((f) => f.fileName),
    ).toEqual(['x.pdf', 'report.pdf']);
    expect(
      (await asAdmin((tx) => r.isoFiles.forSubject(tx, subject, { includeRemoved: true }))).length,
    ).toBe(3);
    expect(
      await failure(
        asAdmin((tx) =>
          tx.execute(sql`UPDATE iso_file SET remove_reason = null WHERE id = ${minutes!.id}`),
        ),
      ),
    ).toBe('23514');

    const archive = await asAdmin((tx) => r.isoFiles.cleanForClient(tx, w.kestrel));
    expect(archive.clean.map((f) => f.id)).toEqual([report!.id]);
    expect(archive.clean[0]!.storageKey).toBe(key('external_audit', auditId, 'report'));
    expect(archive.withheld).toBeGreaterThanOrEqual(2);
    expect(await asAdmin((tx) => r.isoFiles.cleanForClient(tx, w.osprey))).toEqual({
      clean: [],
      withheld: 0,
    });
    // A client user of another client sees none of them.
    expect(
      await t.db.withTenant({ ...clientUser(), clientIds: [w.osprey] }, (tx) =>
        r.isoFiles.forSubject(tx, subject),
      ),
    ).toEqual([]);
    expect(await asAdmin((tx) => r.isoFiles.require(tx, report!.id))).toMatchObject({
      scanStatus: 'CLEAN',
    });
  });
});
