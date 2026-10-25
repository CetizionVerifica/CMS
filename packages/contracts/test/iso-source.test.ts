// The core mock with the ISO add-on (docs/iso/plan.md §4.4-4.6): while it is off, ISO activities (instances under
// STANDARD acts) with their evidence, the STANDARD library rows and the assignments on them leave every core list, and
// every core route naming one answers 403 FEATURE_NOT_ENABLED; while it is on, the register, queues, vault and
// calendar take `source` (LAW, ISO, absent = both). Statutory numbers count STATUTE-act instances either way.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoCatalogueId } from '../src/fixtures/index.js';
import { instanceKind } from '../src/mock/core.js';
import type { Row } from '../src/mock/store.js';
import { Act } from '../src/schemas/library.js';
import { Assignment, ComplianceInstance, Evidence } from '../src/schemas/work.js';
import {
  type App,
  base,
  BENGALURU,
  type Call,
  call,
  fails,
  FIRM_B,
  firmB,
  type Id,
  isoApp,
  NORTHWIND,
  NOW,
  ok,
  PERSON,
  PUNE,
  seedId,
  setFeatures,
  TODAY,
} from './iso-harness.js';

interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}
interface RegisterRow {
  id: string;
  version: number;
  actId: string;
  unitId: string;
  ownerId: string;
  status: string;
  workflowState: string;
}
interface EvidenceRow {
  id: string;
  instanceId: string;
}
interface Score {
  instanceIds: Record<string, string[]>;
  counts: Record<string, number>;
}
interface PortfolioRow {
  clientId: string;
  result: Score;
  dueThisWeek: number;
  dueThisWeekFilter?: Record<string, unknown>;
  lastActivityAt: string | null;
}
interface BreakdownView {
  rows: { key: string; result: Score }[];
}

/** No features for this request: the add-on is off (`X-Mock-Features`, empty = none). */
const OFF = { 'x-mock-features': '' };
const iso = (key: string) => isoCatalogueId(FIRM_B, key);
const ACT = {
  ISO_9001: iso('act:ISO_9001'),
  ISO_14001: iso('act:ISO_14001'),
  ISO_45001: iso('act:ISO_45001'),
  IMS: iso('act:IMS'),
};
const obligationId = (key: string) => iso(`obligation:${key}`);

let app: App;
const firm = () => firmB(app);

/** STANDARD work seeded for this suite (the fixtures may hold more; assertions name these ids). */
const W = {} as {
  safety: string;
  hr: string;
  pune: Row<'assignments'>;
  blr: Row<'assignments'>;
  /** Pune, OPEN, due this week (rohan owns, nisha approves). */
  open: string;
  /** Pune, SUBMITTED for completion. */
  submitted: string;
  /** Pune, OPEN, overdue. */
  overdue: string;
  /** Pune, APPROVED. */
  approved: string;
  /** Bengaluru only, OPEN, due this week (sameer owns, divya approves). */
  blrOpen: string;
  evOpen: string;
  evBlr: string;
  /** A STATUTE instance SUBMITTED at Pune for nisha. */
  tds: string;
  /** A STANDARD act seeded for merges. */
  extraAct: string;
};

function seedIsoWork(): void {
  const d = firm().data;
  const dept = (name: string) =>
    d.departments.find((x) => x.clientId === NORTHWIND && x.name === name)!.id;
  W.safety = dept('Safety');
  W.hr = dept('Human Resources');
  const assign = (unitId: string, key: string, ownerId: string, approverId: string) => {
    const row: Row<'assignments'> = {
      ...base(),
      unitId,
      obligationId: obligationId(key),
      departmentId: W.safety,
      defaultOwnerId: ownerId,
      defaultApproverId: approverId,
      applicability: 'APPLICABLE',
      naReason: null,
      activeFrom: '2024-04-01',
      activeTo: null,
    };
    Assignment.parse(row);
    d.assignments.push(row);
    return row;
  };
  W.pune = assign(PUNE, 'WORKPLACE-INSPECTION', PERSON.rohan, PERSON.nisha);
  W.blr = assign(BENGALURU, 'EMERGENCY-DRILL', PERSON.sameer, PERSON.divya);
  const instance = (
    a: Row<'assignments'>,
    [periodStart, periodEnd]: [string, string],
    dueDate: string,
    fields: Partial<Row<'instances'>> = {},
  ) => {
    const row: Row<'instances'> = {
      ...base(),
      unitId: a.unitId,
      assignmentId: a.id,
      periodStart,
      periodEnd,
      dueDate,
      workflowState: 'OPEN',
      pendingKind: null,
      completedOn: null,
      naReason: null,
      ownerId: a.defaultOwnerId,
      approverId: a.defaultApproverId,
      submittedAt: null,
      approvedAt: null,
      dueDateOverridden: false,
      ...fields,
    };
    ComplianceInstance.parse(row);
    d.instances.push(row);
    return row.id;
  };
  W.open = instance(W.pune, ['2024-11-01', '2024-11-30'], '2024-11-18');
  W.submitted = instance(W.pune, ['2024-10-01', '2024-10-31'], '2024-10-31', {
    workflowState: 'SUBMITTED',
    pendingKind: 'COMPLETION',
    completedOn: '2024-10-30',
    submittedAt: '2024-10-30T09:00:00Z',
  });
  W.overdue = instance(W.pune, ['2024-09-01', '2024-09-30'], '2024-09-30');
  W.approved = instance(W.pune, ['2024-08-01', '2024-08-31'], '2024-08-31', {
    workflowState: 'APPROVED',
    completedOn: '2024-08-30',
    submittedAt: '2024-08-30T09:00:00Z',
    approvedAt: '2024-08-31T09:00:00Z',
  });
  W.blrOpen = instance(W.blr, ['2024-04-01', '2024-09-30'], '2024-11-20');
  const evidence = (instanceId: string, fileName: string, uploadedById: string) => {
    const id = seedId();
    const row: Row<'evidence'> = {
      id,
      firmId: FIRM_B,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      instanceId,
      clientId: NORTHWIND,
      fileName,
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      sha256: 'a'.repeat(64),
      scanStatus: 'CLEAN',
      uploadedById,
      storageKey: `${FIRM_B}/${NORTHWIND}/${instanceId}/${id}`,
    };
    Evidence.parse(row);
    d.evidence.push(row);
    return id;
  };
  W.evOpen = evidence(W.open, 'workplace-inspection-2024-11.pdf', PERSON.rohan);
  W.evBlr = evidence(W.blrOpen, 'emergency-drill-2024-h1.pdf', PERSON.sameer);
  W.tds = d.instances.find(
    (i) =>
      i.clientId === NORTHWIND &&
      i.unitId === PUNE &&
      i.workflowState === 'SUBMITTED' &&
      i.approverId === PERSON.nisha &&
      instanceKind(firm(), i) === 'STATUTE',
  )!.id;
  const extra: Row<'acts'> = {
    id: seedId(),
    firmId: FIRM_B,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    version: 1,
    name: 'Seeded management standard',
    shortName: null,
    jurisdiction: 'CENTRAL',
    stateCode: null,
    aliases: [],
    kind: 'STANDARD',
  };
  Act.parse(extra);
  d.acts.push(extra);
  W.extraAct = extra.id;
}

beforeAll(async () => {
  app = await isoApp();
  seedIsoWork();
});
afterAll(async () => {
  await app.close();
});

// ---------- helpers ----------

const standardActIds = () =>
  new Set(
    firm()
      .data.acts.filter((a) => a.kind === 'STANDARD')
      .map((a) => a.id),
  );
const isStandard = (row: { actId: string }) => standardActIds().has(row.actId);
const standardInstance = (id: string) =>
  instanceKind(
    firm(),
    firm().data.instances.find((i) => i.id === id)!,
  ) === 'STANDARD';
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const SEEDED = () => [W.open, W.submitted, W.overdue, W.approved, W.blrOpen];
const SEEDED_PUNE = () => [W.open, W.submitted, W.overdue, W.approved];
const versionOf = (id: string) => firm().data.instances.find((i) => i.id === id)!.version;

/** Every page of a paged list, by following `nextCursor`. */
async function all<T>(id: Id, request: Call): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await ok<Page<T>>(app, id, {
      ...request,
      query: { limit: '200', ...request.query, ...(cursor === undefined ? {} : { cursor }) },
    });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return items;
}

const register = (
  as: string,
  query: Record<string, string> = {},
  headers?: Record<string, string>,
) => all<RegisterRow>('listInstances', { as, query, headers });

/** A STATUTE act of firm B's library. */
const statuteAct = () => firm().data.acts.find((a) => a.name === 'Factories Act, 1948')!;

/** A create body for an obligation of the firm's own under `actId`. */
function obligationBody(actId: string) {
  return {
    externalRef: 'OWN-ISO-001',
    domain: 'OTHER',
    jurisdiction: 'CENTRAL',
    stateCode: null,
    actId,
    title: 'Toolbox talk record',
    description: 'A record of each toolbox talk.',
    applicabilityText: null,
    criticality: 'LOW',
    timelineType: 'TIME_BASED',
    recurrenceRule: { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 },
    ruleStatus: 'CONFIRMED',
    evidenceRequired: true,
    forms: [],
    logSheets: [],
  };
}

/** 403 FEATURE_NOT_ENABLED naming the ISO add-on. */
async function notEnabled(id: Id, request: Call) {
  const { error } = await fails(app, id, request, 'FEATURE_NOT_ENABLED', 403);
  expect(error.details).toEqual({ feature: 'isoManagement' });
}

// ---------- the register ----------

describe('the register and its source filter', () => {
  it('lists both kinds with the add-on on, and LAW or ISO when asked', async () => {
    const both = await register(PERSON.meera);
    const law = await register(PERSON.meera, { source: 'LAW' });
    const isoRows = await register(PERSON.meera, { source: 'ISO' });
    expect(ids(both)).toEqual(expect.arrayContaining(SEEDED()));
    expect(both.some((r) => !isStandard(r))).toBe(true);
    expect(law.length).toBeGreaterThan(0);
    expect(law.every((r) => !isStandard(r))).toBe(true);
    expect(isoRows.every(isStandard)).toBe(true);
    expect(ids(isoRows)).toEqual(expect.arrayContaining(SEEDED()));
    expect(new Set([...ids(law), ...ids(isoRows)])).toEqual(new Set(ids(both)));
    expect(law.length + isoRows.length).toBe(both.length);
    // `total` agrees with the pages, and `source` combines with the other filters.
    const counted = await ok<Page<RegisterRow>>(app, 'listInstances', {
      query: { source: 'ISO', count: 'true', limit: '1' },
    });
    expect(counted.total).toBe(isoRows.length);
    const puneIso = await register(PERSON.meera, { source: 'ISO', unitId: PUNE });
    expect(ids(puneIso)).toEqual(expect.arrayContaining(SEEDED_PUNE()));
    expect(ids(puneIso)).not.toContain(W.blrOpen);
    const overdue = await register(PERSON.meera, { source: 'ISO', status: 'OVERDUE' });
    expect(ids(overdue)).toContain(W.overdue);
    expect(ids(overdue)).not.toContain(W.open);
  });

  it('leaves ISO activities out with the add-on off and ignores source', async () => {
    const lawOn = ids(await register(PERSON.meera, { source: 'LAW' }));
    for (const query of [{}, { source: 'LAW' }, { source: 'ISO' }] as Record<string, string>[]) {
      const off = await register(PERSON.meera, query, OFF);
      expect(off.every((r) => !isStandard(r))).toBe(true);
      expect(ids(off)).toEqual(lawOn);
    }
  });

  it('keeps unit scope for ISO activities: Pune-only people do not see a Bengaluru-only one', async () => {
    for (const as of [PERSON.rohan, PERSON.nisha]) {
      const rows = ids(await register(as, { source: 'ISO' }));
      expect(rows).toEqual(expect.arrayContaining(SEEDED_PUNE()));
      expect(rows).not.toContain(W.blrOpen);
    }
    for (const as of [PERSON.sameer, PERSON.divya, PERSON.kabir, PERSON.vikram, PERSON.arjun]) {
      expect(ids(await register(as, { source: 'ISO' }))).toEqual(expect.arrayContaining(SEEDED()));
    }
    expect(ids(await register(PERSON.vikram, {}, OFF))).not.toContain(W.open);
    await fails(
      app,
      'listInstances',
      { as: PERSON.leela, query: { limit: '10' } },
      'NOT_FOUND',
      404,
    );
  });

  it('accepts the register filters with source in an export, on or off', async () => {
    for (const headers of [{}, OFF]) {
      const job = await ok<{ kind: string; params: { filters: string } }>(app, 'createExport', {
        as: PERSON.kabir,
        body: { kind: 'REGISTER_XLSX', filters: 'source=ISO&unitId=' + PUNE },
        headers,
      });
      expect(job.params.filters).toBe(`source=ISO&unitId=${PUNE}`);
    }
    await fails(
      app,
      'createExport',
      { as: PERSON.kabir, body: { kind: 'REGISTER_XLSX', filters: 'source=BOTH' } },
      'VALIDATION',
      400,
    );
  });
});

// ---------- queues, vault and calendar ----------

describe('the queues, the vault and the calendar', () => {
  type Query = Record<string, string>;
  const queue = (id: 'myApprovals' | 'myTasks', as: string, query: Query = {}, headers = {}) =>
    all<RegisterRow>(id, { as, query, headers });

  it('lists an ISO approval for its approver and the client admin, by source, only while on', async () => {
    for (const as of [PERSON.nisha, PERSON.kabir]) {
      expect(ids(await queue('myApprovals', as))).toEqual(
        expect.arrayContaining([W.submitted, W.tds]),
      );
      const isoRows = await queue('myApprovals', as, { source: 'ISO' });
      expect(ids(isoRows)).toContain(W.submitted);
      expect(isoRows.every(isStandard)).toBe(true);
      const law = await queue('myApprovals', as, { source: 'LAW' });
      expect(ids(law)).toContain(W.tds);
      expect(law.every((r) => !isStandard(r))).toBe(true);
      for (const query of [{}, { source: 'ISO' }] as Record<string, string>[]) {
        expect(ids(await queue('myApprovals', as, query, OFF))).toEqual(ids(law));
      }
    }
    // Someone else's approval is not in the queue, whatever its source.
    expect(ids(await queue('myApprovals', PERSON.divya, { source: 'ISO' }))).not.toContain(
      W.submitted,
    );
  });

  it("lists an owner's ISO tasks by source, only while on", async () => {
    const both = ids(await queue('myTasks', PERSON.rohan));
    expect(both).toEqual(expect.arrayContaining([W.open, W.overdue]));
    expect(both).not.toContain(W.blrOpen);
    const isoRows = await queue('myTasks', PERSON.rohan, { source: 'ISO' });
    expect(ids(isoRows)).toEqual(expect.arrayContaining([W.open, W.overdue]));
    expect(isoRows.every(isStandard)).toBe(true);
    const law = await queue('myTasks', PERSON.rohan, { source: 'LAW' });
    expect(law.every((r) => !isStandard(r))).toBe(true);
    expect(law.length).toBeGreaterThan(0);
    expect(ids(await queue('myTasks', PERSON.rohan, { source: 'ISO' }, OFF))).toEqual(ids(law));
    expect(ids(await queue('myTasks', PERSON.sameer, { source: 'ISO' }))).toContain(W.blrOpen);
  });

  it('keeps ISO evidence in the vault by source, only while on, within unit scope', async () => {
    const vault = (as: string, query: Query = {}, headers = {}) =>
      all<EvidenceRow>('evidenceVault', { as, query, headers });
    const both = await vault(PERSON.meera);
    expect(ids(both)).toEqual(expect.arrayContaining([W.evOpen, W.evBlr]));
    const isoRows = await vault(PERSON.meera, { source: 'ISO' });
    expect(ids(isoRows)).toEqual(expect.arrayContaining([W.evOpen, W.evBlr]));
    expect(isoRows.every((e) => standardInstance(e.instanceId))).toBe(true);
    const law = await vault(PERSON.meera, { source: 'LAW' });
    expect(law.length).toBeGreaterThan(0);
    expect(law.some((e) => standardInstance(e.instanceId))).toBe(false);
    expect(law.length + isoRows.length).toBe(both.length);
    for (const query of [{}, { source: 'ISO' }] as Record<string, string>[]) {
      expect(ids(await vault(PERSON.meera, query, OFF))).toEqual(ids(law));
    }
    const rohan = ids(await vault(PERSON.rohan, { source: 'ISO' }));
    expect(rohan).toContain(W.evOpen);
    expect(rohan).not.toContain(W.evBlr);
  });

  it('shows ISO activities on the calendar by source, only while on', async () => {
    const days = async (as: string, query: Record<string, string> = {}, headers = {}) => {
      const view = await ok<{ items: { date: string; items: RegisterRow[] }[] }>(app, 'calendar', {
        as,
        query: { from: '2024-11-01', to: '2024-11-30', ...query },
        headers,
      });
      return view.items.flatMap((d) => d.items);
    };
    expect(ids(await days(PERSON.meera))).toEqual(expect.arrayContaining([W.open, W.blrOpen]));
    const isoRows = await days(PERSON.meera, { source: 'ISO' });
    expect(ids(isoRows)).toEqual(expect.arrayContaining([W.open, W.blrOpen]));
    expect(isoRows.every(isStandard)).toBe(true);
    const law = await days(PERSON.meera, { source: 'LAW' });
    expect(law.every((r) => !isStandard(r))).toBe(true);
    for (const query of [{}, { source: 'ISO' }] as Record<string, string>[]) {
      expect(ids(await days(PERSON.meera, query, OFF))).toEqual(ids(law));
    }
    const nisha = ids(await days(PERSON.nisha, { source: 'ISO' }));
    expect(nisha).toContain(W.open);
    expect(nisha).not.toContain(W.blrOpen);
  });
});

// ---------- statutory numbers ----------

describe('statutory numbers', () => {
  const seededIn = (score: Score) =>
    Object.values(score.instanceIds)
      .flat()
      .filter((id) => standardInstance(id));

  it('count STATUTE acts only in the portfolio, whose due-this-week link says Law while on', async () => {
    const on = await ok<{ items: PortfolioRow[] }>(app, 'portfolio', { as: PERSON.meera });
    const off = await ok<{ items: PortfolioRow[] }>(app, 'portfolio', {
      as: PERSON.meera,
      headers: OFF,
    });
    expect(on.items.map((r) => r.clientId)).toEqual(off.items.map((r) => r.clientId));
    for (const [i, row] of on.items.entries()) {
      const other = off.items[i]!;
      expect(seededIn(row.result)).toEqual([]);
      expect(row.result).toEqual(other.result);
      expect(row.dueThisWeek).toBe(other.dueThisWeek);
      expect(row.lastActivityAt).toBe(other.lastActivityAt);
      expect(row.dueThisWeekFilter).toEqual({ ...other.dueThisWeekFilter, source: 'LAW' });
      expect(other.dueThisWeekFilter).not.toHaveProperty('source');
    }
    // Each link lists exactly its count; without `source` the register would also list the ISO activities.
    const northwind = on.items.find((r) => r.clientId === NORTHWIND)!;
    const filter = northwind.dueThisWeekFilter as {
      dueFrom: string;
      dueTo: string;
      workflowState: string[];
      source: string;
    };
    const query = {
      dueFrom: filter.dueFrom,
      dueTo: filter.dueTo,
      workflowState: filter.workflowState.join(','),
    };
    expect(await register(PERSON.meera, { ...query, source: filter.source })).toHaveLength(
      northwind.dueThisWeek,
    );
    const unfiltered = ids(await register(PERSON.meera, query));
    expect(unfiltered).toEqual(expect.arrayContaining([W.open, W.blrOpen]));
    expect(unfiltered.length).toBeGreaterThan(northwind.dueThisWeek);
    const offRow = off.items.find((r) => r.clientId === NORTHWIND)!;
    expect(await register(PERSON.meera, query, OFF)).toHaveLength(offRow.dueThisWeek);
  });

  it('count STATUTE acts only in the overview, its lists included', async () => {
    for (const as of [PERSON.meera, PERSON.rohan, PERSON.nisha]) {
      const read = (headers = {}) =>
        ok<{ result: Score; upcoming: RegisterRow[]; myTasks: RegisterRow[] }>(
          app,
          'clientOverview',
          { as, query: { fy: '2024-25' }, headers },
        );
      const on = await read();
      expect(on).toEqual(await read(OFF));
      expect(seededIn(on.result)).toEqual([]);
      expect([...on.upcoming, ...on.myTasks].some(isStandard)).toBe(false);
    }
  });

  it('count STATUTE acts only in every breakdown and report', async () => {
    const reads: [Id, Record<string, string>][] = [
      ...['department', 'act', 'criticality', 'unit', 'owner'].map(
        (by): [Id, Record<string, string>] => ['breakdown', { fy: '2024-25', by }],
      ),
      ['actReport', { fy: '2024-25' }],
      ['departmentReport', { fy: '2024-25' }],
    ];
    for (const [id, query] of reads) {
      const on = await ok<BreakdownView>(app, id, { as: PERSON.kabir, query });
      expect(on).toEqual(
        await ok<BreakdownView>(app, id, { as: PERSON.kabir, query, headers: OFF }),
      );
      expect(on.rows.length).toBeGreaterThan(0);
      expect(on.rows.some((r) => standardActIds().has(r.key))).toBe(false);
      expect(on.rows.flatMap((r) => seededIn(r.result))).toEqual([]);
    }
    const overdue = await ok<{ result: Score; items: RegisterRow[] }>(app, 'overdueReport', {
      as: PERSON.divya,
      query: { fy: '2024-25' },
    });
    expect(overdue).toEqual(
      await ok(app, 'overdueReport', { as: PERSON.divya, query: { fy: '2024-25' }, headers: OFF }),
    );
    expect(ids(overdue.items)).not.toContain(W.overdue);
    expect(overdue.items.some(isStandard)).toBe(false);
    // The ISO activity is overdue in the register, so only the report leaves it out.
    expect(ids(await register(PERSON.divya, { status: 'OVERDUE' }))).toContain(W.overdue);
  });
});

// ---------- routes naming an ISO activity ----------

describe('routes naming an ISO activity', () => {
  it('answer 403 FEATURE_NOT_ENABLED while off, change nothing, and keep 404 and role checks first', async () => {
    // An upload ticket from while the add-on was on.
    const ticket = await ok<{ uploadId: string }>(app, 'evidenceUploadUrl', {
      as: PERSON.rohan,
      params: { id: W.open },
      body: { fileName: 'inspection.pdf', mimeType: 'application/pdf', sizeBytes: 100 },
    });
    await setFeatures(app, []);
    try {
      const events = firm().data.auditEvents.length;
      const comments = firm().data.comments.length;
      const v = (id: string) => versionOf(id);
      const routes: [Id, Call][] = [
        ['getInstance', { as: PERSON.vikram, params: { id: W.open } }],
        [
          'updateInstance',
          { params: { id: W.open }, body: { version: v(W.open), dueDate: TODAY, reason: 'Moved' } },
        ],
        [
          'submitInstance',
          {
            as: PERSON.rohan,
            params: { id: W.open },
            body: { version: v(W.open), completedOn: TODAY, comment: 'Done' },
          },
        ],
        [
          'requestNa',
          { as: PERSON.rohan, params: { id: W.open }, body: { version: v(W.open), reason: 'No' } },
        ],
        [
          'approveInstance',
          { as: PERSON.nisha, params: { id: W.submitted }, body: { version: v(W.submitted) } },
        ],
        [
          'sendBackInstance',
          {
            as: PERSON.kabir,
            params: { id: W.submitted },
            body: { version: v(W.submitted), reason: 'Redo' },
          },
        ],
        [
          'reopenInstance',
          { params: { id: W.approved }, body: { version: v(W.approved), reason: 'Again' } },
        ],
        ['listComments', { as: PERSON.rohan, params: { id: W.open }, query: { limit: '10' } }],
        ['createComment', { as: PERSON.rohan, params: { id: W.open }, body: { body: 'Note' } }],
        [
          'evidenceUploadUrl',
          {
            as: PERSON.rohan,
            params: { id: W.open },
            body: { fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
          },
        ],
        [
          'confirmEvidence',
          {
            as: PERSON.rohan,
            params: { id: W.open },
            body: { uploadId: ticket.uploadId, fileName: 'inspection.pdf', sha256: 'b'.repeat(64) },
          },
        ],
        ['listInstanceEvidence', { as: PERSON.nisha, params: { id: W.open } }],
        ['evidenceDownloadUrl', { as: PERSON.vikram, params: { id: W.evOpen } }],
        [
          'removeEvidence',
          { as: PERSON.rohan, params: { id: W.evOpen }, body: { reason: 'Wrong' } },
        ],
        ['instanceAudit', { params: { id: W.open }, query: { limit: '10' } }],
      ];
      for (const [id, request] of routes) await notEnabled(id, request);
      // Off hides and refuses; it never deletes or changes.
      expect(firm().data.auditEvents).toHaveLength(events);
      expect(firm().data.comments).toHaveLength(comments);
      expect(firm().data.evidence.find((e) => e.id === W.evOpen)!.archivedAt).toBeNull();
      expect(firm().pendingUploads.has(ticket.uploadId)).toBe(true);
      expect(firm().data.instances.find((i) => i.id === W.submitted)!.workflowState).toBe(
        'SUBMITTED',
      );
      // Someone who cannot see the instance learns nothing of its kind; a role check still comes first.
      await fails(
        app,
        'getInstance',
        { as: PERSON.rohan, params: { id: W.blrOpen } },
        'NOT_FOUND',
        404,
      );
      await fails(
        app,
        'getInstance',
        { as: PERSON.leela, params: { id: W.open } },
        'NOT_FOUND',
        404,
      );
      await fails(
        app,
        'evidenceDownloadUrl',
        { as: PERSON.nisha, params: { id: W.evBlr } },
        'NOT_FOUND',
        404,
      );
      await fails(
        app,
        'submitInstance',
        {
          as: PERSON.vikram,
          params: { id: W.open },
          body: { version: v(W.open), completedOn: TODAY, comment: 'Done' },
        },
        'FORBIDDEN',
        403,
      );
      // STATUTE instances are untouched by the switch.
      await ok(app, 'getInstance', { as: PERSON.vikram, params: { id: W.tds } });
    } finally {
      await setFeatures(app, ['isoManagement']);
    }
    // The ticket still confirms once the add-on is back on.
    await ok(app, 'confirmEvidence', {
      as: PERSON.rohan,
      params: { id: W.open },
      body: { uploadId: ticket.uploadId, fileName: 'inspection.pdf', sha256: 'b'.repeat(64) },
    });
  });

  it('refuse ISO ids per item in a bulk approve while off, and approve them while on', async () => {
    const items = [
      { id: W.submitted, version: versionOf(W.submitted) },
      { id: W.tds, version: versionOf(W.tds) },
    ];
    const off = await ok<{
      results: { id: string; ok: boolean; error?: { code: string } }[];
    }>(app, 'bulkApprove', { as: PERSON.kabir, body: { items }, headers: OFF });
    expect(off.results).toEqual([
      {
        id: W.submitted,
        ok: false,
        error: { code: 'FEATURE_NOT_ENABLED', message: expect.any(String) },
      },
      expect.objectContaining({ id: W.tds, ok: true }),
    ]);
    expect(firm().data.instances.find((i) => i.id === W.submitted)!.workflowState).toBe(
      'SUBMITTED',
    );
    // The approver's own ISO item goes through while on.
    const on = await ok<{ results: { id: string; ok: boolean; item?: RegisterRow }[] }>(
      app,
      'bulkApprove',
      { as: PERSON.nisha, body: { items: [{ id: W.submitted, version: versionOf(W.submitted) }] } },
    );
    expect(on.results).toEqual([expect.objectContaining({ id: W.submitted, ok: true })]);
    expect(on.results[0]!.item!.workflowState).toBe('APPROVED');
    const event = firm()
      .data.auditEvents.filter((e) => e.entityId === W.submitted)
      .at(-1)!;
    expect(event).toMatchObject({ action: 'TRANSITION', actorId: PERSON.nisha });
  });

  it('work as for any instance while on, and the client audit trail keeps them while off', async () => {
    const detail = await ok<{ allowedActions: string[]; version: number }>(app, 'getInstance', {
      as: PERSON.rohan,
      params: { id: W.open },
    });
    expect(detail.allowedActions).toEqual(expect.arrayContaining(['SUBMIT', 'REQUEST_NA']));
    await ok(app, 'createComment', {
      as: PERSON.rohan,
      params: { id: W.open },
      body: { body: 'Inspection walk done' },
    });
    const comments = await ok<Page<{ body: string }>>(app, 'listComments', {
      as: PERSON.nisha,
      params: { id: W.open },
      query: { limit: '10' },
    });
    expect(comments.items.map((c) => c.body)).toContain('Inspection walk done');
    const evidence = await ok<{ items: EvidenceRow[] }>(app, 'listInstanceEvidence', {
      as: PERSON.vikram,
      params: { id: W.open },
    });
    expect(ids(evidence.items)).toContain(W.evOpen);
    await ok(app, 'evidenceDownloadUrl', { as: PERSON.vikram, params: { id: W.evOpen } });
    const submitted = await ok<{ version: number; workflowState: string }>(app, 'submitInstance', {
      as: PERSON.rohan,
      params: { id: W.open },
      body: { version: detail.version, completedOn: TODAY, comment: 'Inspected' },
    });
    expect(submitted.workflowState).toBe('SUBMITTED');
    const sentBack = await ok<{ version: number; workflowState: string }>(app, 'sendBackInstance', {
      as: PERSON.nisha,
      params: { id: W.open },
      body: { version: submitted.version, reason: 'Attach the checklist' },
    });
    expect(sentBack.workflowState).toBe('SENT_BACK');
    const na = await ok<{ version: number }>(app, 'requestNa', {
      as: PERSON.rohan,
      params: { id: W.open },
      body: { version: sentBack.version, reason: 'Plant shut for the month' },
    });
    const approved = await ok<{ version: number; workflowState: string }>(app, 'approveInstance', {
      as: PERSON.kabir,
      params: { id: W.open },
      body: { version: na.version },
    });
    expect(approved.workflowState).toBe('NOT_APPLICABLE');
    const reopened = await ok<{ version: number; workflowState: string }>(app, 'reopenInstance', {
      as: PERSON.arjun,
      params: { id: W.open },
      body: { version: approved.version, reason: 'Plant reopened' },
    });
    expect(reopened.workflowState).toBe('OPEN');
    await ok(app, 'updateInstance', {
      as: PERSON.kabir,
      params: { id: W.open },
      body: { version: reopened.version, dueDate: '2024-11-22', reason: 'Audit week' },
    });
    await ok(app, 'removeEvidence', {
      as: PERSON.rohan,
      params: { id: W.evOpen },
      body: { reason: 'Superseded' },
    });
    const trail = await ok<Page<{ action: string }>>(app, 'instanceAudit', {
      as: PERSON.nisha,
      params: { id: W.open },
      query: { limit: '50' },
    });
    expect(trail.items.map((e) => e.action)).toEqual(
      expect.arrayContaining(['TRANSITION', 'DUE_DATE_CHANGE', 'EVIDENCE_ADD', 'EVIDENCE_REMOVE']),
    );
    // Off, the instance's own trail is refused but the client trail still lists its events.
    await notEnabled('instanceAudit', {
      params: { id: W.open },
      query: { limit: '50' },
      headers: OFF,
    });
    const client = await ok<Page<{ entityId: string; action: string }>>(app, 'clientAudit', {
      as: PERSON.vikram,
      query: { entityId: W.open, limit: '50' },
      headers: OFF,
    });
    expect(client.items.map((e) => e.action)).toEqual(
      expect.arrayContaining(['TRANSITION', 'DUE_DATE_CHANGE']),
    );
  });
});

// ---------- the library ----------

describe('the library', () => {
  it('lists STANDARD acts and their obligations only while on', async () => {
    const acts = (as: string, headers = {}) =>
      all<{ id: string; kind?: string }>('listActs', { as, headers });
    const on = ids(await acts(PERSON.meera));
    expect(on).toEqual(expect.arrayContaining(Object.values(ACT)));
    const off = await acts(PERSON.meera, OFF);
    expect(off.some((a) => a.kind === 'STANDARD')).toBe(false);
    expect(ids(off)).toEqual(on.filter((id) => !standardActIds().has(id)));
    // Client roles see the acts their clients use: the ISO ones only while on.
    const kabir = ids(await acts(PERSON.kabir));
    expect(kabir).toEqual(expect.arrayContaining([ACT.ISO_45001, ACT.IMS]));
    expect(ids(await acts(PERSON.kabir, OFF)).some((id) => standardActIds().has(id))).toBe(false);

    const obligations = (as: string, query: Record<string, string> = {}, headers = {}) =>
      all<{ id: string; actId: string }>('listObligations', { as, query, headers });
    const standardObligations = [
      'WORKPLACE-INSPECTION',
      'EMERGENCY-DRILL',
      'CUSTOMER-SATISFACTION',
    ].map(obligationId);
    expect(ids(await obligations(PERSON.meera))).toEqual(
      expect.arrayContaining(standardObligations),
    );
    expect((await obligations(PERSON.meera, {}, OFF)).some(isStandard)).toBe(false);
    expect(await obligations(PERSON.meera, { actId: ACT.IMS }, OFF)).toEqual([]);
    expect(ids(await obligations(PERSON.rohan))).toContain(obligationId('WORKPLACE-INSPECTION'));
    expect((await obligations(PERSON.rohan, {}, OFF)).some(isStandard)).toBe(false);

    const categories = async (as: string, headers = {}) =>
      (await all<{ name: string }>('listCategories', { as, headers })).map((c) => c.name);
    expect(await categories(PERSON.kabir)).toContain('ISO management systems');
    expect(await categories(PERSON.kabir, OFF)).not.toContain('ISO management systems');
  });

  it('refuses STANDARD rows by id while off, after the visibility check', async () => {
    const workplace = obligationId('WORKPLACE-INSPECTION');
    const act = firm().data.acts.find((a) => a.id === ACT.ISO_9001)!;
    const statute = firm().data.obligations.find((o) => o.externalRef === 'SLC-EHS-002')!;
    const ob = (id: string) => firm().data.obligations.find((o) => o.id === id)!;
    await ok(app, 'getObligation', { as: PERSON.vikram, params: { id: workplace } });
    const refusals: [Id, Call][] = [
      ['getObligation', { params: { id: workplace } }],
      ['getObligation', { as: PERSON.kabir, params: { id: workplace } }],
      [
        'updateObligation',
        {
          params: { id: workplace },
          body: { version: ob(workplace).version, criticality: 'HIGH' },
        },
      ],
      [
        'updateObligation',
        { params: { id: statute.id }, body: { version: statute.version, actId: ACT.ISO_45001 } },
      ],
      [
        'archiveObligation',
        { params: { id: workplace }, body: { version: ob(workplace).version, reason: 'Gone' } },
      ],
      ['pushObligation', { params: { id: workplace }, body: { clientIds: [NORTHWIND] } }],
      [
        'createObligation',
        {
          body: {
            ...obligationBody(ACT.ISO_45001),
            categoryId: statute.categoryId,
          },
        },
      ],
      ['updateAct', { params: { id: act.id }, body: { version: act.version, shortName: 'QMS' } }],
      [
        'mergeActs',
        { params: { id: act.id }, body: { version: act.version, sourceIds: [W.extraAct] } },
      ],
      [
        'mergeActs',
        {
          params: { id: statuteAct().id },
          body: { version: statuteAct().version, sourceIds: [W.extraAct] },
        },
      ],
    ];
    for (const [id, request] of refusals) await notEnabled(id, { ...request, headers: OFF });
    // Not used in Harbour: a Harbour owner gets 404 whatever the switch, so nothing is learnt of its kind.
    await fails(
      app,
      'getObligation',
      { as: PERSON.joseph, params: { id: workplace }, headers: OFF },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'getObligation',
      { as: PERSON.joseph, params: { id: workplace } },
      'NOT_FOUND',
      404,
    );
    // A role check still comes first.
    await fails(
      app,
      'updateAct',
      {
        as: PERSON.kabir,
        params: { id: act.id },
        body: { version: act.version, shortName: 'QMS' },
        headers: OFF,
      },
      'FORBIDDEN',
      403,
    );
    expect(firm().data.acts.find((a) => a.id === W.extraAct)!.archivedAt).toBeNull();
    expect(ob(workplace).archivedAt).toBeNull();
    expect(ob(statute.id).actId).toBe(statute.actId);
  });

  it('allows STANDARD rows while on, and refuses to mix kinds whatever the switch', async () => {
    const workplace = obligationId('WORKPLACE-INSPECTION');
    const ob = (id: string) => firm().data.obligations.find((o) => o.id === id)!;
    const act = (id: string) => firm().data.acts.find((a) => a.id === id)!;
    // Staff may edit a copied activity and add their own under a STANDARD act.
    const edited = await ok<{ criticality: string; libraryVersion: number }>(
      app,
      'updateObligation',
      {
        as: PERSON.arjun,
        params: { id: workplace },
        body: { version: ob(workplace).version, criticality: 'HIGH' },
      },
    );
    expect(edited.criticality).toBe('HIGH');
    const pushed = await ok<{ assignmentsUpdated: number }>(app, 'pushObligation', {
      params: { id: workplace },
      body: { clientIds: [NORTHWIND] },
    });
    expect(pushed.assignmentsUpdated).toBeGreaterThanOrEqual(1);
    const own = await ok<{ id: string; actId: string; version: number }>(app, 'createObligation', {
      body: { ...obligationBody(ACT.ISO_45001), categoryId: ob(workplace).categoryId },
    });
    expect(own.actId).toBe(ACT.ISO_45001);
    const moved = await ok<{ actId: string; version: number }>(app, 'updateObligation', {
      params: { id: own.id },
      body: { version: own.version, actId: ACT.IMS },
    });
    expect(moved.actId).toBe(ACT.IMS);
    await ok(app, 'archiveObligation', {
      params: { id: own.id },
      body: { version: moved.version, reason: 'Duplicate of the drill' },
    });
    // No moves between kinds, either way.
    const statute = ob(firm().data.obligations.find((o) => o.externalRef === 'SLC-EHS-002')!.id);
    await fails(
      app,
      'updateObligation',
      { params: { id: statute.id }, body: { version: statute.version, actId: ACT.ISO_45001 } },
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'updateObligation',
      { params: { id: workplace }, body: { version: ob(workplace).version, actId: statute.actId } },
      'VALIDATION',
      400,
    );
    // A STANDARD act stays CENTRAL.
    const qms = act(ACT.ISO_9001);
    await fails(
      app,
      'updateAct',
      {
        params: { id: qms.id },
        body: { version: qms.version, jurisdiction: 'STATE', stateCode: 'MH' },
      },
      'VALIDATION',
      400,
    );
    const renamed = await ok<{ shortName: string; kind: string }>(app, 'updateAct', {
      params: { id: qms.id },
      body: { version: qms.version, shortName: 'QMS' },
    });
    expect(renamed).toMatchObject({ shortName: 'QMS', kind: 'STANDARD' });
    // Acts of different kinds never merge; two STANDARD acts may.
    for (const [target, source] of [
      [ACT.IMS, statuteAct().id],
      [statuteAct().id, W.extraAct],
    ] as const) {
      await fails(
        app,
        'mergeActs',
        { params: { id: target }, body: { version: act(target).version, sourceIds: [source] } },
        'VALIDATION',
        400,
      );
    }
    const merged = await ok<{ aliases: string[] }>(app, 'mergeActs', {
      params: { id: ACT.IMS },
      body: { version: act(ACT.IMS).version, sourceIds: [W.extraAct] },
    });
    expect(merged.aliases).toContain('Seeded management standard');
    // Names are unique per kind: a STATUTE act may share a STANDARD act's name, on or off.
    const named = await ok<{ id: string; kind?: string }>(app, 'createAct', {
      as: PERSON.arjun,
      body: { name: 'ISO 14001 environmental management', jurisdiction: 'CENTRAL' },
      headers: OFF,
    });
    expect(named.kind).toBeUndefined();
    await fails(
      app,
      'createAct',
      { body: { name: 'ISO 14001 environmental management', jurisdiction: 'CENTRAL' } },
      'DUPLICATE',
      409,
    );
  });
});

// ---------- assignments ----------

describe('assignments', () => {
  /** A new assignment of a STANDARD activity not yet assigned at Bengaluru in Human Resources. */
  const newAssignment = () => {
    const taken = new Set(
      firm()
        .data.assignments.filter(
          (a) => a.archivedAt === null && a.unitId === BENGALURU && a.departmentId === W.hr,
        )
        .map((a) => a.obligationId),
    );
    const activity = firm().data.obligations.find(
      (o) => o.archivedAt === null && standardActIds().has(o.actId) && !taken.has(o.id),
    )!;
    return {
      unitId: BENGALURU,
      obligationId: activity.id,
      departmentId: W.hr,
      defaultOwnerId: PERSON.sameer,
      defaultApproverId: PERSON.divya,
      activeFrom: '2024-04-01',
    };
  };
  const assignedAt = (obligation: string, unitId: string) =>
    firm().data.assignments.filter((a) => a.obligationId === obligation && a.unitId === unitId)
      .length;

  it('lists those on STANDARD obligations only while on', async () => {
    const list = (as: string, query: Record<string, string> = {}, headers = {}) =>
      all<{ id: string; obligationId: string }>('listAssignments', { as, query, headers });
    for (const as of [PERSON.meera, PERSON.kabir, PERSON.rohan]) {
      expect(ids(await list(as))).toEqual(expect.arrayContaining([W.pune.id, W.blr.id]));
      const off = await list(as, {}, OFF);
      expect(ids(off)).not.toContain(W.pune.id);
      expect(off.length).toBeGreaterThan(0);
    }
    expect(
      await list(PERSON.meera, { obligationId: obligationId('WORKPLACE-INSPECTION') }, OFF),
    ).toEqual([]);
  });

  it('refuses one on a STANDARD obligation by id, in a create and per bulk item while off', async () => {
    const pune = firm().data.assignments.find((a) => a.id === W.pune.id)!;
    const create = newAssignment();
    const before = assignedAt(create.obligationId, BENGALURU);
    const refusals: [Id, Call][] = [
      ['createAssignment', { as: PERSON.kabir, body: create }],
      [
        'updateAssignment',
        { params: { id: pune.id }, body: { version: pune.version, activeTo: '2025-03-31' } },
      ],
      [
        'setAssignmentApplicability',
        {
          params: { id: pune.id },
          body: { version: pune.version, applicability: 'NOT_APPLICABLE', reason: 'Not here' },
        },
      ],
      [
        'archiveAssignment',
        { params: { id: pune.id }, body: { version: pune.version, reason: 'Gone' } },
      ],
    ];
    for (const [id, request] of refusals) await notEnabled(id, { ...request, headers: OFF });
    // A role check still comes first; a STATUTE item of a bulk create still goes through.
    await fails(
      app,
      'createAssignment',
      { as: PERSON.vikram, body: create, headers: OFF },
      'FORBIDDEN',
      403,
    );
    const statute = firm().data.obligations.find((o) => o.externalRef === 'SLC-EHS-002')!;
    const bulk = await ok<{ results: { index: number; ok: boolean; error?: { code: string } }[] }>(
      app,
      'bulkCreateAssignments',
      {
        body: {
          items: [create, { ...create, obligationId: statute.id, departmentId: W.safety }],
        },
        headers: OFF,
      },
    );
    expect(bulk.results.map((r) => [r.index, r.ok, r.error?.code])).toEqual([
      [0, false, 'FEATURE_NOT_ENABLED'],
      [1, true, undefined],
    ]);
    expect(assignedAt(create.obligationId, BENGALURU)).toBe(before);
    expect(pune.archivedAt).toBeNull();
  });

  it('creates and changes one on a STANDARD obligation while on, whose instances join the ISO register', async () => {
    const created = await ok<{ id: string; version: number }>(app, 'createAssignment', {
      as: PERSON.kabir,
      body: newAssignment(),
    });
    const generated = firm().data.instances.filter((i) => i.assignmentId === created.id);
    expect(generated.length).toBeGreaterThan(0);
    expect(ids(await register(PERSON.sameer, { source: 'ISO' }))).toEqual(
      expect.arrayContaining(ids(generated)),
    );
    expect(ids(await register(PERSON.sameer, { source: 'LAW' }))).not.toContain(generated[0]!.id);
    const updated = await ok<{ version: number }>(app, 'updateAssignment', {
      params: { id: created.id },
      body: { version: created.version, activeTo: '2025-03-31' },
    });
    const na = await ok<{ version: number; applicability: string }>(
      app,
      'setAssignmentApplicability',
      {
        as: PERSON.arjun,
        params: { id: created.id },
        body: { version: updated.version, applicability: 'NOT_APPLICABLE', reason: 'No data yet' },
      },
    );
    expect(na.applicability).toBe('NOT_APPLICABLE');
    await ok(app, 'archiveAssignment', {
      params: { id: created.id },
      body: { version: na.version, reason: 'Assigned by mistake' },
    });
    const events = firm()
      .data.auditEvents.filter((e) => e.entityId === created.id)
      .map((e) => e.action);
    expect(events).toEqual(['CREATE', 'UPDATE', 'APPLICABILITY_CHANGE', 'ARCHIVE']);
  });
});

it('reads a header-less request with the firm features, and the add-on can be switched for the firm', async () => {
  // The firm switch and the per-request header agree.
  await setFeatures(app, []);
  try {
    expect(ids(await register(PERSON.meera, { source: 'ISO' }))).not.toContain(W.overdue);
    await notEnabled('getInstance', { params: { id: W.overdue } });
  } finally {
    await setFeatures(app, ['isoManagement']);
  }
  expect(ids(await register(PERSON.meera, { source: 'ISO' }))).toContain(W.overdue);
  expect((await call(app, 'getInstance', { params: { id: W.overdue } })).status).toBe(200);
});
