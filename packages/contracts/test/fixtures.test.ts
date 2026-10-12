import { describe, expect, it } from 'vitest';
import {
  fixtureId,
  type FixtureSet,
  loadDueDates,
  loadExpected,
  loadFixtureSet,
  uuidV5,
} from '../src/fixtures/index.js';
import { Id, RecurrenceRule, WorkflowState } from '../src/index.js';
import { buildFirmB } from '../scripts/fixtures/firm-b.js';
import { score, statusIds, type ScoredInstance } from '../src/mock/derive.js';

const firmA = loadFixtureSet('firm-a.sample');
const firmB = loadFixtureSet('firm-b.synthetic');
const dueDates = loadDueDates();
const expected = loadExpected();

/** Every entity with an id in a set, with its collection name. */
function entities(set: FixtureSet): { collection: string; entity: Record<string, unknown> }[] {
  return Object.entries(set).flatMap(([collection, value]) =>
    Array.isArray(value)
      ? value.map((entity) => ({ collection, entity: entity as Record<string, unknown> }))
      : typeof value === 'object'
        ? [{ collection, entity: value as Record<string, unknown> }]
        : [],
  );
}

/** Fields that reference another entity, by the collection they point into. */
const REFERENCES: Record<string, string> = {
  clientId: 'clients',
  companyId: 'companies',
  locationId: 'locations',
  unitId: 'units',
  departmentId: 'departments',
  personId: 'people',
  actId: 'acts',
  categoryId: 'categories',
  obligationId: 'obligations',
  assignmentId: 'assignments',
  instanceId: 'instances',
  ownerId: 'people',
  approverId: 'people',
  defaultOwnerId: 'people',
  defaultApproverId: 'people',
  authorId: 'people',
  actorId: 'people',
  uploadedById: 'people',
};

function scoredInstances(set: FixtureSet): ScoredInstance[] {
  const assignment = new Map(set.assignments.map((a) => [a.id, a]));
  const obligation = new Map(set.obligations.map((o) => [o.id, o]));
  return set.instances.map((i) => ({
    id: i.id,
    dueDate: i.dueDate,
    workflowState: i.workflowState,
    completedOn: i.completedOn,
    criticality: obligation.get(assignment.get(i.assignmentId)!.obligationId)!.criticality,
  }));
}

describe.each([
  ['firm A', firmA],
  ['firm B', firmB],
])('%s fixture set', (_, set) => {
  it('keeps every row in one firm', () => {
    for (const { collection, entity } of entities(set)) {
      if (collection === 'firm') continue;
      expect(entity.firmId, collection).toBe(set.firm.id);
    }
  });

  it('has unique ids that are valid UUIDs', () => {
    const ids = entities(set).map(({ entity }) => entity.id as string);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(Id.safeParse(id).success).toBe(true);
  });

  it('only references entities in the same set', () => {
    const byCollection = new Map<string, Set<string>>();
    for (const { collection, entity } of entities(set)) {
      if (!byCollection.has(collection)) byCollection.set(collection, new Set());
      byCollection.get(collection)!.add(entity.id as string);
    }
    for (const { collection, entity } of entities(set)) {
      for (const [field, target] of Object.entries(REFERENCES)) {
        const value = entity[field];
        if (typeof value === 'string') {
          expect(byCollection.get(target)?.has(value), `${collection}.${field}`).toBe(true);
        }
      }
      for (const field of ['unitIds', 'consultantClientIds'] as const) {
        const target = field === 'unitIds' ? 'units' : 'clients';
        for (const value of (entity[field] as string[] | null | undefined) ?? []) {
          expect(byCollection.get(target)?.has(value), `${collection}.${field}`).toBe(true);
        }
      }
    }
  });

  it('has one instance per assignment and period start', () => {
    const keys = set.instances.map((i) => `${i.assignmentId}|${i.periodStart}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('copies client and unit from the assignment onto each instance', () => {
    const assignment = new Map(set.assignments.map((a) => [a.id, a]));
    for (const i of set.instances) {
      expect(i.clientId).toBe(assignment.get(i.assignmentId)!.clientId);
      expect(i.unitId).toBe(assignment.get(i.assignmentId)!.unitId);
    }
  });
});

describe('fixture ids', () => {
  it('are RFC 9562 version 5 UUIDs', () => {
    // RFC 9562 appendix A.4 test vector: "www.example.com" in the DNS namespace.
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('come from natural keys, so every module gets the same id', () => {
    expect(firmA.obligations.find((o) => o.externalRef === 'TAX-CL-033-6067-60218')!.id).toBe(
      fixtureId('obligation:TAX-CL-033-6067-60218'),
    );
    expect(
      firmA.instances.some((i) => i.id === fixtureId('instance:TAX-CL-033-6067-60218:2022-04-07')),
    ).toBe(true);
  });

  it('never repeat between firms', () => {
    const a = new Set(entities(firmA).map(({ entity }) => entity.id));
    const shared = entities(firmB).filter(({ entity }) => a.has(entity.id));
    expect(shared).toEqual([]);
  });
});

describe('firm A (sample register, recommended profile)', () => {
  it('has the counts in fixtures.md §3', () => {
    expect(firmA.obligations).toHaveLength(119);
    expect(firmA.instances).toHaveLength(422);
    expect(firmA.acts).toHaveLength(33);
    expect(firmA.categories).toHaveLength(10);
    expect(firmA.departments).toHaveLength(9);
    expect(firmA.assignments).toHaveLength(119);
    const states = Object.fromEntries(WorkflowState.options.map((s) => [s, 0]));
    for (const i of firmA.instances) states[i.workflowState]! += 1;
    expect(states).toMatchObject({ APPROVED: 209, OPEN: 201, NOT_APPLICABLE: 12 });
  });

  it('names a fictional client, company and sites, not the real ones from the register (fixtures.md §7)', () => {
    expect(firmA.clients.map((c) => c.name)).toEqual(['Kestrel Metals Group']);
    expect(firmA.companies.map((c) => c.name)).toEqual(['Kestrel Aluminium']);
    expect(firmA.locations.map((l) => l.city)).toEqual(['Kestrelganj']);
    const files = JSON.stringify([firmA, expected, dueDates]);
    expect(files).not.toMatch(/hindalco|birla|aditya|belur|renukoot|hirakud/i);
  });

  it('replaces every person from the register with a pseudonym (fixtures.md §7)', () => {
    const imported = firmA.people.filter((p) => p.email === null);
    expect(imported).toHaveLength(21);
    for (const p of imported) expect(p.displayName).toMatch(/^(Owner|Approver) \d{2}$/);
    for (const p of firmA.people.filter((x) => x.email !== null)) {
      expect(p.email).toMatch(/@demo-advisory\.example$/);
    }
  });

  it('folds the two duplicate periods into import comments', () => {
    expect(expected.findings.duplicatePeriods).toEqual([
      { externalRef: 'HRS-CL-014-3059-30387', dueDate: '2022-04-30' },
      { externalRef: 'HRS-CL-005-3174-30354', dueDate: '2022-04-30' },
    ]);
    for (const { externalRef, dueDate } of expected.findings.duplicatePeriods) {
      const id = fixtureId(`instance:${externalRef}:${dueDate}`);
      expect(
        firmA.comments.some(
          (c) => c.instanceId === id && c.kind === 'IMPORT' && c.body.startsWith('Duplicate row'),
        ),
      ).toBe(true);
    }
  });

  it('proposes completedOn = dueDate for the complied row with no date', () => {
    expect(expected.findings.compliedWithoutDate).toEqual([
      { externalRef: 'ENV-117-0031', dueDate: '2022-09-30' },
    ]);
    const row = firmA.instances.find(
      (i) => i.id === fixtureId('instance:ENV-117-0031:2022-09-30'),
    )!;
    expect(row).toMatchObject({ workflowState: 'APPROVED', completedOn: '2022-09-30' });
  });

  it('lists the six non-standard ids', () => {
    expect([...expected.findings.unparsedExternalRefs].sort()).toEqual([
      'ENV-117-0031',
      'INT-FA-1-1',
      'INT-H-047-0016',
      'INT-H-048-0002',
      'INT-H-050-0002',
      'INT-H-056-0001',
    ]);
  });
});

describe('firm-a.expected.json', () => {
  const recommended = expected.profiles.recommended;

  it('matches the profile table in fixtures.md §3', () => {
    expect(expected.profiles.raw.counts).toEqual({
      obligations: 119,
      instances: 424,
      workflowStates: { OPEN: 201, SUBMITTED: 0, SENT_BACK: 0, APPROVED: 211, NOT_APPLICABLE: 12 },
      acts: 36,
      categories: 12,
      departments: 10,
      people: 21,
      assignments: 121,
    });
    expect(recommended.counts).toEqual({
      obligations: 119,
      instances: 422,
      workflowStates: { OPEN: 201, SUBMITTED: 0, SENT_BACK: 0, APPROVED: 209, NOT_APPLICABLE: 12 },
      acts: 33,
      categories: 10,
      departments: 9,
      people: 21,
      assignments: 119,
    });
  });

  it('matches the score table in fixtures.md §4', () => {
    const table = recommended.scores.map((s) => [
      s.asOf,
      s.counts.COMPLIED,
      s.counts.NOT_APPLICABLE,
      s.counts.OVERDUE,
      s.counts.DUE_SOON,
      s.counts.UPCOMING,
      s.due,
      s.weightedNumerator,
      s.weightedDenominator,
      s.score,
      s.onTimeRate,
    ]);
    expect(table).toEqual([
      ['2022-09-30', 209, 12, 0, 0, 201, 194, 525, 525, 100, 100],
      ['2022-12-15', 209, 12, 3, 1, 197, 212, 561, 573, 97.9, 98.1],
      ['2023-03-31', 209, 12, 125, 76, 0, 410, 562, 1096, 51.3, 51],
    ]);
  });

  it('agrees with firm-a.sample.json', () => {
    const instances = scoredInstances(firmA);
    for (const s of recommended.scores) expect(score(instances, s.asOf)).toEqual(s);
    for (const { asOf, ids } of expected.instanceIds) {
      expect(ids).toEqual(statusIds(instances, asOf));
    }
  });

  it('has breakdowns whose rows add up to the client total', () => {
    for (const b of expected.breakdowns) {
      const total = recommended.scores.find((s) => s.asOf === b.asOf)!;
      const sum = (pick: (r: (typeof b.rows)[number]) => number) =>
        b.rows.reduce((n, r) => n + pick(r), 0);
      expect(
        sum((r) => r.result.due),
        `${b.by} ${b.asOf}`,
      ).toBe(total.due);
      expect(sum((r) => r.result.weightedDenominator)).toBe(total.weightedDenominator);
      expect(sum((r) => r.result.counts.OVERDUE)).toBe(total.counts.OVERDUE);
    }
    expect(
      expected.breakdowns.filter((b) => b.asOf === '2023-03-31').map((b) => b.rows.length),
    ).toEqual([9, 33, 5]);
  });
});

describe('firm-a.due-dates.json', () => {
  it('has every obligation and every distinct due date', () => {
    expect(dueDates).toHaveLength(119);
    expect(dueDates.reduce((n, d) => n + d.dueDates.length, 0)).toBe(422);
    expect(new Set(dueDates.map((d) => d.externalRef))).toEqual(
      new Set(firmA.obligations.map((o) => o.externalRef)),
    );
  });

  it('stores the expected rule on the obligation when it is exact', () => {
    for (const entry of dueDates) {
      const obligation = firmA.obligations.find((o) => o.externalRef === entry.externalRef)!;
      if (entry.exact) expect(obligation.recurrenceRule).toEqual(entry.expectedRule);
      else expect(obligation.recurrenceRule.kind).toBe('FIXED_DATES');
      expect(entry.exact && entry.expectedRule === null).toBe(false);
    }
  });

  it('lists the drifting monthly obligations as inexact (fixtures.md §3.6)', () => {
    const inexact = dueDates.filter((d) => d.expectedRule !== null && !d.exact);
    expect(inexact.map((d) => d.expectedRule?.kind)).toEqual(Array(4).fill('MONTHLY'));
  });
});

describe('firm B (synthetic)', () => {
  it('is what the generator produces', () => {
    expect(firmB).toEqual(JSON.parse(JSON.stringify(buildFirmB())));
  });

  it('covers every recurrence kind, Central and State Acts', () => {
    const kinds = new Set(firmB.obligations.map((o) => o.recurrenceRule.kind));
    for (const option of RecurrenceRule.def.options) {
      expect(kinds).toContain(option.shape.kind.value);
    }
    expect(firmB.obligations).toHaveLength(15);
    expect(new Set(firmB.acts.map((a) => a.stateCode))).toEqual(new Set([null, 'MH', 'KA', 'TN']));
  });

  it('has instances in every workflow state, both submission kinds, and complied late', () => {
    expect(new Set(firmB.instances.map((i) => i.workflowState))).toEqual(
      new Set(WorkflowState.options),
    );
    expect(new Set(firmB.instances.map((i) => i.pendingKind))).toEqual(
      new Set([null, 'COMPLETION', 'NA']),
    );
    expect(
      firmB.instances.some((i) => i.workflowState === 'APPROVED' && i.completedOn! > i.dueDate),
    ).toBe(true);
    expect(firmB.instances.filter((i) => i.dueDateOverridden)).toHaveLength(1);
    expect(firmB.comments.some((c) => c.kind === 'REOPEN')).toBe(true);
  });

  it('spans 29 February 2024 and both FY boundaries', () => {
    const covers = (date: string) =>
      firmB.instances.some((i) => i.periodStart <= date && date <= i.dueDate);
    expect(firmB.instances.some((i) => i.dueDate === '2024-02-29')).toBe(true);
    expect(covers('2024-04-01')).toBe(true);
    expect(covers('2025-04-01')).toBe(true);
  });

  it('has evidence in every scan state, and clean evidence where it is required', () => {
    expect(new Set(firmB.evidence.map((e) => e.scanStatus))).toEqual(
      new Set(['PENDING', 'CLEAN', 'INFECTED', 'FAILED']),
    );
    const required = new Set(firmB.obligations.filter((o) => o.evidenceRequired).map((o) => o.id));
    const assignment = new Map(firmB.assignments.map((a) => [a.id, a]));
    const approved = firmB.instances.filter(
      (i) =>
        i.workflowState === 'APPROVED' &&
        required.has(assignment.get(i.assignmentId)!.obligationId),
    );
    expect(approved.length).toBeGreaterThan(0);
    for (const i of approved) {
      expect(firmB.evidence.some((e) => e.instanceId === i.id && e.scanStatus === 'CLEAN')).toBe(
        true,
      );
    }
  });

  it('has people for every role and person status', () => {
    expect(new Set(firmB.memberships.map((m) => m.role)).size).toBe(6);
    expect(new Set(firmB.people.map((p) => p.status)).size).toBe(4);
    const viewers = firmB.memberships.filter((m) => m.role === 'VIEWER').map((m) => m.expiresAt!);
    expect(viewers.some((t) => t < '2026-01-01')).toBe(true);
    expect(viewers.some((t) => t > '2027-01-01')).toBe(true);
    const consultants = firmB.memberships.filter((m) => m.role === 'CONSULTANT');
    const northwind = firmB.clients.find((c) => c.name === 'Northwind Foods Group')!;
    expect(consultants.some((m) => !m.consultantClientIds!.includes(northwind.id))).toBe(true);
    expect(firmB.memberships.some((m) => m.role === 'OWNER' && m.unitIds?.length === 1)).toBe(true);
  });

  it('has a client whose financial year starts in January', () => {
    expect(firmB.clients.map((c) => c.settings.fyStartMonth).sort()).toEqual([1, 4]);
  });

  it('writes an audit event for every showcased state change', () => {
    const actions = new Set(firmB.auditEvents.map((e) => e.action));
    for (const action of ['TRANSITION', 'REASSIGN', 'DUE_DATE_CHANGE', 'EVIDENCE_ADD']) {
      expect(actions).toContain(action);
    }
  });
});
