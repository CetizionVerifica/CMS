// Firm B's ISO fixture (docs/iso/packages.md ISO-1 "Fixtures", docs/contracts/fixtures.md §8): Northwind Foods Group's
// integrated management system. Checks the generated file against its generator, every reference and cross-record
// rule (docs/iso/model.md §1, §3, §4), that each state the fixture promises is there, and that the mock store holds it.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NonconformityView, ObjectiveView } from '../src/api/iso.js';
import { ISO_ENTITY_TYPES, type IsoEntityType, type IsoStandardCode } from '../src/enums.js';
import {
  FIRM_B_AS_OF,
  fixtureId,
  isoCatalogueId,
  isoCatalogueRows,
  type IsoFixtureSet,
  loadFixtureSet,
  loadIsoCatalogue,
  loadIsoFixtureSet,
} from '../src/fixtures/index.js';
import {
  ClauseNaState,
  ClauseStatus,
  DocumentStatus,
  DocumentType,
  INCIDENT_SOURCES,
  InternalAuditState,
  IsoActionState,
  IsoActionSubjectType,
  NC_FINDING_TYPES,
  NcState,
  ReviewInputKey,
  ReviewOutputKey,
  RevisionState,
  RiskKind,
} from '../src/schemas/iso.js';
import { buildFirmBIso } from '../scripts/fixtures/firm-b-iso.js';
import { buildIsoCatalogue } from '../scripts/fixtures/iso-catalogue.js';
import {
  type App,
  BENGALURU,
  FIRM_B,
  firmB,
  HARBOUR,
  isoApp,
  NORTHWIND,
  ok,
  PERSON,
  PUNE,
} from './iso-harness.js';

const iso = loadIsoFixtureSet();
const raw = JSON.parse(
  readFileSync(new URL('../fixtures/firm-b.iso.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const firmA = loadFixtureSet('firm-a.sample');
const register = loadFixtureSet('firm-b.synthetic');
const catalogue = isoCatalogueRows(iso.firmId, iso.catalogueCopiedAt);

type TableName = Exclude<keyof IsoFixtureSet, 'source' | 'firmId' | 'catalogueCopiedAt'>;
const TABLES = Object.keys(iso).filter((key) =>
  Array.isArray(iso[key as keyof IsoFixtureSet]),
) as TableName[];
const rowsOf = (table: TableName) => iso[table] as unknown as Record<string, unknown>[];
const allRows = () => TABLES.flatMap((table) => rowsOf(table).map((row) => ({ table, row })));

const system = iso.managementSystems[0]!;
const standardCode = (standardId: string) =>
  catalogue.standards.find((s) => s.id === standardId)!.code;
const clauseOf = (id: string) => catalogue.clauses.find((c) => c.id === id);
const clauseKey = (id: string) => {
  const c = clauseOf(id)!;
  return `${standardCode(c.standardId)}:${c.number}`;
};
const byId = <T extends { id: string }>(rows: readonly T[], id: string) =>
  rows.find((r) => r.id === id);
const count = <T>(values: readonly T[]) => new Set(values).size;
const states = <T, K extends keyof T>(rows: readonly T[], field: K) =>
  [...new Set(rows.map((r) => r[field]))].sort();
const instant = (date: string) => `${date}T23:59:59Z`;
const AS_OF_END = instant(FIRM_B_AS_OF);

describe('iso.catalogue.json', () => {
  const file = JSON.parse(
    readFileSync(new URL('../fixtures/iso.catalogue.json', import.meta.url), 'utf8'),
  ) as unknown;

  it('is what the generator writes', () => {
    expect(JSON.parse(JSON.stringify(buildIsoCatalogue()))).toEqual(file);
  });

  it('has the 201 clauses of catalogue.md, 137 of them assessable', () => {
    const { clauses } = loadIsoCatalogue();
    const per = (code: IsoStandardCode) => clauses.filter((c) => c.standard === code).length;
    expect(clauses).toHaveLength(201);
    expect([per('ISO_9001'), per('ISO_14001'), per('ISO_45001')]).toEqual([94, 48, 59]);
    expect(clauses.filter((c) => c.assessable)).toHaveLength(137);
  });
});

describe('firm-b.iso.json', () => {
  it('is what the generator writes', () => {
    expect(JSON.parse(JSON.stringify(buildFirmBIso()))).toEqual(raw);
  });

  it('is firm B’s, with its catalogue copy recorded', () => {
    expect(iso.firmId).toBe(FIRM_B);
    expect(register.firm.id).toBe(FIRM_B);
    expect(iso.catalogueCopiedAt).toBe('2024-04-02T04:30:00Z');
  });

  it('keeps every row in firm B’s Northwind Foods Group: nothing for Harbour or firm A', () => {
    const rows = allRows();
    expect(rows.length).toBeGreaterThan(300);
    for (const { table, row } of rows) {
      expect(row.firmId, table).toBe(FIRM_B);
      expect(row.clientId, table).toBe(NORTHWIND);
    }
    expect(rows.some(({ row }) => row.clientId === HARBOUR)).toBe(false);
    expect(rows.some(({ row }) => row.firmId === firmA.firm.id)).toBe(false);
  });

  it('has unique ids that no other fixture row or catalogue row uses', () => {
    const ids = allRows().map(({ row }) => row.id as string);
    expect(count(ids)).toBe(ids.length);
    const elsewhere = new Set(
      [firmA, register].flatMap((set) =>
        Object.values(set).flatMap((value) =>
          Array.isArray(value) ? value.map((r) => (r as { id: string }).id) : [],
        ),
      ),
    );
    for (const rows of Object.values(catalogue)) {
      for (const r of [rows].flat()) elsewhere.add((r as { id: string }).id);
    }
    expect(ids.filter((id) => elsewhere.has(id))).toEqual([]);
    // Deterministic: the same natural key always gives the same id.
    expect(system.id).toBe(fixtureId('firm-b:iso:system:ims'));
  });

  it('names only Northwind’s units, inside the management system', () => {
    const northwindUnits = register.units.filter((u) => u.clientId === NORTHWIND).map((u) => u.id);
    expect([...system.unitIds].sort()).toEqual([...northwindUnits].sort());
    for (const { table, row } of allRows()) {
      const units = [
        ...(typeof row.unitId === 'string' ? [row.unitId] : []),
        ...((row.unitIds as string[] | undefined) ?? []),
      ];
      for (const unit of units) expect(system.unitIds, table).toContain(unit);
    }
  });

  it('names people who hold a live role in Northwind covering the record’s unit (model §1.5)', () => {
    const memberships = register.memberships.filter((m) => m.archivedAt === null);
    const works = (personId: string, unitIds: readonly string[]) => {
      const person = byId(register.people, personId);
      if (person === undefined || person.status === 'DISABLED') return false;
      return memberships.some((m) => {
        if (m.personId !== personId || m.expiresAt !== null) return false;
        if (m.role === 'FIRM_ADMIN') return true;
        if (m.role === 'CONSULTANT') return m.consultantClientIds!.includes(NORTHWIND);
        if (m.clientId !== NORTHWIND || m.role === 'VIEWER') return false;
        return (
          m.unitIds === null || unitIds.length === 0 || m.unitIds.some((u) => unitIds.includes(u))
        );
      });
    };
    const named: { where: string; personId: string | null; unitIds: string[] }[] = [];
    const add = (where: string, ids: readonly (string | null)[], unitId: string | null = null) => {
      for (const personId of ids) named.push({ where, personId, unitIds: unitId ? [unitId] : [] });
    };
    for (const a of iso.clauseAssessments) {
      add('checklist', [a.ownerId, a.naRequestedById, a.naDecidedById]);
    }
    for (const d of iso.documents) add('document', [d.ownerId, d.approverId]);
    for (const r of iso.revisions) add('revision', [r.preparedById, r.approvedById]);
    for (const r of iso.riskItems) add('risk', [r.ownerId], r.unitId);
    for (const o of iso.objectives) add('objective', [o.ownerId]);
    for (const r of iso.readings) add('reading', [r.recordedById]);
    for (const a of iso.internalAudits) {
      const people = [a.leadAuditorId, ...a.auditorIds, ...a.auditeeIds, ...a.reportedToIds];
      for (const personId of people) named.push({ where: 'audit', personId, unitIds: a.unitIds });
    }
    for (const n of iso.nonconformities) {
      add(
        'nonconformity',
        [
          n.reportedById,
          n.ownerId,
          n.approverId,
          n.dispositionAuthorisedById,
          ...(n.incident?.investigatorIds ?? []),
        ],
        n.unitId,
      );
    }
    for (const a of iso.actions) add('action', [a.ownerId], subjectUnit(a.subject));
    for (const r of iso.managementReviews) add('review', [r.chairId, ...r.attendeeIds]);
    for (const f of iso.files) add('file', [f.uploadedById]);
    for (const a of iso.assignments)
      add('assignment', [a.defaultOwnerId, a.defaultApproverId], a.unitId);
    for (const i of iso.instances) add('instance', [i.ownerId, i.approverId], i.unitId);
    for (const e of iso.evidence) add('evidence', [e.uploadedById]);
    for (const e of iso.auditEvents) add('audit event', [e.actorId]);
    const checked = named.filter((n) => n.personId !== null);
    expect(checked.length).toBeGreaterThan(300);
    for (const n of checked)
      expect(works(n.personId!, n.unitIds), `${n.where} ${n.personId}`).toBe(true);
  });

  it('uses only clauses of the system’s standards', () => {
    const lists: [string, readonly string[]][] = [
      ['checklist', iso.clauseAssessments.map((a) => a.clauseId)],
      ['documents', iso.documents.flatMap((d) => d.clauseIds)],
      ['audits', iso.internalAudits.flatMap((a) => a.clauseIds)],
      ['checklist items', iso.auditChecklistItems.map((c) => c.clauseId)],
      ['findings', iso.findings.flatMap((f) => f.clauseIds)],
      ['nonconformities', iso.nonconformities.flatMap((n) => n.clauseIds)],
    ];
    for (const [where, ids] of lists) {
      for (const id of ids) expect(system.standardIds, where).toContain(clauseOf(id)?.standardId);
    }
    // An NC's standards name the standards of its clauses.
    for (const n of iso.nonconformities) {
      for (const id of n.clauseIds) {
        expect(n.standards).toContain(standardCode(clauseOf(id)!.standardId));
      }
    }
    for (const o of [...iso.objectives, ...iso.managementReviews]) {
      for (const code of o.standards) expect(system.standardIds).toContain(standardOf(code));
    }
    for (const a of iso.externalAudits) {
      for (const id of a.standardIds) expect(system.standardIds).toContain(id);
    }
    for (const c of iso.certifications) expect(system.standardIds).toContain(c.standardId);
  });
});

/** The one unit an action's subject sits in, when it has one. */
function subjectUnit(subject: { type: string; id: string }): string | null {
  switch (subject.type) {
    case 'NONCONFORMITY':
      return byId(iso.nonconformities, subject.id)!.unitId;
    case 'RISK_ITEM':
      return byId(iso.riskItems, subject.id)!.unitId;
    case 'AUDIT_FINDING':
      return byId(iso.findings, subject.id)!.unitId;
    default:
      return null;
  }
}

function standardOf(code: IsoStandardCode): string {
  return catalogue.standards.find((s) => s.code === code)!.id;
}

describe('the checklist', () => {
  it('has one row per assessable clause of the three standards, and none for other clauses', () => {
    const assessable = catalogue.clauses
      .filter((c) => c.assessable && system.standardIds.includes(c.standardId))
      .map((c) => c.id);
    expect(system.standardIds.map(standardCode)).toEqual(['ISO_9001', 'ISO_14001', 'ISO_45001']);
    expect(iso.clauseAssessments.map((a) => a.clauseId).sort()).toEqual([...assessable].sort());
    for (const a of iso.clauseAssessments) expect(a.managementSystemId).toBe(system.id);
  });

  it('has rows in every status and every N/A state, N/A only on clauses that allow exclusion', () => {
    expect(states(iso.clauseAssessments, 'status')).toEqual([...ClauseStatus.options].sort());
    expect(states(iso.clauseAssessments, 'naState')).toEqual([...ClauseNaState.options].sort());
    const na = iso.clauseAssessments.filter((a) => a.naState !== 'NONE');
    for (const a of na)
      expect(clauseOf(a.clauseId)!.exclusionAllowed, clauseKey(a.clauseId)).toBe(true);
    const approved = na.filter((a) => a.naState === 'APPROVED').map((a) => clauseKey(a.clauseId));
    expect(approved).toContain('ISO_9001:8.3.1');
    expect(approved.every((key) => key.startsWith('ISO_9001:8.3.'))).toBe(true);
    // A rejected request restored the status before it.
    const rejected = na.find((a) => a.naState === 'REJECTED')!;
    expect(rejected).toMatchObject({ status: 'PARTIAL', statusBeforeNa: null });
    expect(rejected.naDecidedById).not.toBe(rejected.naRequestedById);
  });

  it('records the climate decision, so clause 4.1 may be IMPLEMENTED', () => {
    expect(system).toMatchObject({ climateChangeRelevant: true, climateDecidedOn: '2024-05-06' });
    const fourOne = iso.clauseAssessments.filter((a) => clauseOf(a.clauseId)!.number === '4.1');
    expect(fourOne.map((a) => a.status)).toEqual(['IMPLEMENTED', 'IMPLEMENTED', 'IMPLEMENTED']);
    // Climate-related context and risk, so the engine finds no climate gap (model §5.1).
    expect(iso.contextItems.some((c) => c.climateRelated)).toBe(true);
    expect(iso.riskItems.some((r) => r.climateRelated)).toBe(true);
    expect(states(iso.contextItems, 'kind')).toEqual([
      'EXTERNAL_ISSUE',
      'INTERESTED_PARTY',
      'INTERNAL_ISSUE',
    ]);
  });
});

describe('documents and revisions', () => {
  it('has revisions in every state and documents of every status', () => {
    expect(states(iso.revisions, 'state')).toEqual([...RevisionState.options].sort());
    expect(states(iso.documents, 'status')).toEqual([...DocumentStatus.options].sort());
    expect(states(iso.documents, 'type')).toEqual([...DocumentType.options].sort());
  });

  it('points each document at its APPROVED revision, with at most one open revision', () => {
    for (const d of iso.documents) {
      const revisions = iso.revisions.filter((r) => r.documentId === d.id);
      expect(revisions.length, d.code).toBeGreaterThan(0);
      const approved = revisions.filter((r) => r.state === 'APPROVED');
      expect(approved.length, d.code).toBeLessThanOrEqual(1);
      expect(d.currentRevisionId, d.code).toBe(approved[0]?.id ?? null);
      expect(
        revisions.filter((r) => ['DRAFT', 'IN_REVIEW'].includes(r.state)).length,
      ).toBeLessThanOrEqual(1);
      for (const r of revisions) {
        // The document's approver approves; an external edition has no internal approver.
        if (r.approvedById !== null) expect(r.approvedById).toBe(d.approverId);
        if (d.type === 'EXTERNAL') {
          expect(r.approvedById).toBeNull();
          expect(['DRAFT', 'APPROVED', 'SUPERSEDED']).toContain(r.state);
        }
      }
    }
  });

  it('has an ACTIVE policy approved and linked to clause 5.2 of every standard', () => {
    const policy = iso.documents.find((d) => d.type === 'POLICY' && d.status === 'ACTIVE')!;
    expect(policy.currentRevisionId).not.toBeNull();
    expect(policy.clauseIds.map(clauseKey).sort()).toEqual([
      'ISO_14001:5.2',
      'ISO_45001:5.2',
      'ISO_9001:5.2.1',
      'ISO_9001:5.2.2',
    ]);
    const external = iso.documents.find((d) => d.type === 'EXTERNAL')!;
    expect(external.issuer).not.toBeNull();
    expect(byId(iso.revisions, external.currentRevisionId!)!.state).toBe('APPROVED');
  });

  it('gives each submitted revision exactly one live CLEAN file, and a draft at most one live file', () => {
    for (const r of iso.revisions) {
      const live = iso.files.filter((f) => f.documentRevisionId === r.id && f.archivedAt === null);
      if (r.state === 'DRAFT') expect(live.length).toBeLessThanOrEqual(1);
      else
        expect(
          live.map((f) => f.scanStatus),
          r.revision,
        ).toEqual(['CLEAN']);
    }
  });
});

describe('risks, objectives and their actions', () => {
  it('has items of every kind, stores the engine’s ratings and significance (model §1.7, §5.1)', () => {
    expect(states(iso.riskItems, 'kind')).toEqual([...RiskKind.options].sort());
    for (const r of iso.riskItems) {
      expect(r.rating).toBe(r.likelihood * r.severity);
      expect(r.residualRating).toBe(
        r.residualLikelihood === null ? null : r.residualLikelihood * r.residualSeverity!,
      );
      const byRule = r.rating >= 12 || r.obligationIds.length > 0;
      expect(r.significant, r.description).toBe(r.significantOverride ?? byRule);
      // Residual scores are kept only while treatment actions are open (model §3.5).
      const open = iso.actions.some((a) => a.subject.id === r.id && a.state === 'OPEN');
      expect(r.residualLikelihood !== null, r.description).toBe(open);
    }
    expect(iso.riskItems.some((r) => r.climateRelated)).toBe(true);
    expect(iso.riskItems.some((r) => r.significantOverride !== null)).toBe(true);
    // Linked to statutory obligations of firm B's register.
    const linked = iso.riskItems.filter((r) => r.obligationIds.length > 0);
    expect(linked.length).toBeGreaterThan(0);
    for (const id of linked.flatMap((r) => r.obligationIds)) {
      expect(byId(register.obligations, id)).toBeDefined();
    }
  });

  it('gives hazard controls a hierarchy, and a control from an action matches the done action', () => {
    for (const c of iso.riskControls) {
      const item = byId(iso.riskItems, c.riskItemId)!;
      if (item.kind === 'HAZARD') expect(c.hierarchy).not.toBeNull();
      if (c.sourceActionId !== null) {
        const action = byId(iso.actions, c.sourceActionId)!;
        expect(action).toMatchObject({
          state: 'DONE',
          subject: { type: 'RISK_ITEM', id: item.id },
        });
        expect(action.controlHierarchy).toBe(c.hierarchy);
      }
    }
    for (const a of iso.actions.filter((x) => x.subject.type === 'RISK_ITEM')) {
      if (byId(iso.riskItems, a.subject.id)!.kind === 'HAZARD')
        expect(a.controlHierarchy).not.toBeNull();
    }
  });

  it('has objectives on track, off track and closed, with readings and plans', () => {
    const [energy, complaints, training] = iso.objectives;
    expect(training).toMatchObject({ closedOn: '2024-10-04', outcome: 'ACHIEVED' });
    for (const o of [energy!, complaints!]) {
      expect(o.closedOn).toBeNull();
      expect(iso.readings.filter((r) => r.objectiveId === o.id)).toHaveLength(2);
      expect(iso.actions.some((a) => a.subject.id === o.id && a.state !== 'CANCELLED')).toBe(true);
    }
    for (const r of iso.readings) expect(r.periodEnd <= FIRM_B_AS_OF).toBe(true);
  });

  it('has actions on every subject type, each OPEN, DONE and CANCELLED, on subjects that exist', () => {
    const subjects: Record<string, readonly { id: string }[]> = {
      NONCONFORMITY: iso.nonconformities,
      RISK_ITEM: iso.riskItems,
      OBJECTIVE: iso.objectives,
      AUDIT_FINDING: iso.findings,
      MANAGEMENT_REVIEW: iso.managementReviews,
    };
    for (const type of IsoActionSubjectType.options) {
      const actions = iso.actions.filter((a) => a.subject.type === type);
      expect(states(actions, 'state'), type).toEqual([...IsoActionState.options].sort());
      for (const a of actions) expect(byId(subjects[type]!, a.subject.id), a.text).toBeDefined();
    }
    for (const a of iso.actions) {
      if (a.state === 'DONE') expect(a.doneOn! <= FIRM_B_AS_OF).toBe(true);
      if (a.subject.type === 'AUDIT_FINDING') {
        // Only OBSERVATION and OFI findings take actions (model §3.9).
        expect(['OBSERVATION', 'OFI']).toContain(byId(iso.findings, a.subject.id)!.type);
      }
      if (a.outputKey !== null) {
        const review = byId(iso.managementReviews, a.subject.id)!;
        const defs = iso.reviewOutputs
          .filter((o) => o.managementReviewId === review.id)
          .map((o) => byId(catalogue.reviewOutputDefs, o.outputDefId)!.key);
        expect(defs).toContain(a.outputKey);
      }
    }
  });
});

describe('audits, findings and nonconformities', () => {
  it('has an FY 2024-25 programme with an internal audit in every state', () => {
    expect(iso.auditProgrammes.map((p) => p.fy)).toEqual(['2024-25']);
    expect(states(iso.internalAudits, 'state')).toEqual([...InternalAuditState.options].sort());
    for (const a of iso.internalAudits) expect(a.programmeId).toBe(iso.auditProgrammes[0]!.id);
  });

  it('answers every clause of a reported audit, and links each FINDING row to a finding of its audit', () => {
    for (const a of iso.internalAudits) {
      const items = iso.auditChecklistItems.filter((c) => c.internalAuditId === a.id);
      for (const c of items) expect(a.clauseIds).toContain(c.clauseId);
      if (a.state === 'REPORTED' || a.state === 'CLOSED') {
        for (const id of a.clauseIds) {
          expect(items.find((c) => c.clauseId === id)?.result, a.title).not.toBeNull();
        }
      }
      if (a.state === 'PLANNED' || a.state === 'CANCELLED') expect(items).toEqual([]);
    }
    const reported = iso.internalAudits.find((a) => a.state === 'REPORTED')!;
    const rows = iso.auditChecklistItems.filter((c) => c.internalAuditId === reported.id);
    expect(states(rows, 'result')).toEqual(['CONFORMS', 'FINDING', 'NOT_AUDITED']);
    expect(iso.findings.some((f) => f.internalAuditId === reported.id)).toBe(true);
    for (const c of iso.auditChecklistItems.filter((x) => x.result === 'FINDING')) {
      expect(byId(iso.findings, c.findingId!)!.internalAuditId).toBe(c.internalAuditId);
    }
  });

  it('links each NC finding to its nonconformity and each audit nonconformity to one finding', () => {
    for (const f of iso.findings) {
      const ncType = (NC_FINDING_TYPES as readonly string[]).includes(f.type);
      expect(f.nonconformityId !== null).toBe(ncType);
      if (f.nonconformityId === null) continue;
      const nc = byId(iso.nonconformities, f.nonconformityId)!;
      expect(nc.source).toBe(f.internalAuditId === null ? 'EXTERNAL_AUDIT' : 'INTERNAL_AUDIT');
      expect(nc.severity).toBe(f.type === 'MAJOR_NC' ? 'MAJOR' : 'MINOR');
      expect(nc.clauseIds).toEqual(f.clauseIds);
      expect(nc.unitId).toBe(f.unitId);
    }
    for (const nc of iso.nonconformities) {
      const from = iso.findings.filter((f) => f.nonconformityId === nc.id);
      const fromAudit = nc.source === 'INTERNAL_AUDIT' || nc.source === 'EXTERNAL_AUDIT';
      expect(from.length, nc.description).toBe(fromAudit ? 1 : 0);
    }
    const sources = iso.nonconformities.map((n) => n.source);
    expect(sources).toContain('INTERNAL_AUDIT');
    expect(sources).toContain('EXTERNAL_AUDIT');
  });

  it('keeps audit states consistent with their nonconformities (model §4.3, §4.4)', () => {
    const ncsOf = (field: 'internalAuditId' | 'externalAuditId', id: string) =>
      iso.findings
        .filter((f) => f[field] === id && f.nonconformityId !== null)
        .map((f) => byId(iso.nonconformities, f.nonconformityId!)!);
    for (const a of iso.internalAudits.filter((x) => x.state === 'CLOSED')) {
      for (const nc of ncsOf('internalAuditId', a.id)) expect(nc.state).not.toBe('OPEN');
    }
    for (const a of iso.externalAudits) {
      const ncs = ncsOf('externalAuditId', a.id);
      if (a.state === 'CLOSED' && ncs.length > 0) {
        expect(ncs.every((nc) => nc.state !== 'OPEN')).toBe(true);
      }
      if (a.state === 'PLANNED')
        expect(iso.findings.some((f) => f.externalAuditId === a.id)).toBe(false);
    }
    expect(
      iso.externalAudits.some((a) => iso.findings.some((f) => f.externalAuditId === a.id)),
    ).toBe(true);
    // An issued certificate, and its body's visits.
    const issued = iso.certifications.filter((c) => c.issuedOn !== null);
    expect(issued.length).toBeGreaterThan(0);
    for (const c of issued) expect(c.issuedOn! <= FIRM_B_AS_OF).toBe(true);
  });

  it('has nonconformities in every state, numbered from 1, with guards met (model §4.1)', () => {
    expect(states(iso.nonconformities, 'state')).toEqual([...NcState.options].sort());
    expect(iso.nonconformities.map((n) => n.number)).toEqual(
      iso.nonconformities.map((_, i) => i + 1),
    );
    const actionsOf = (id: string) => iso.actions.filter((a) => a.subject.id === id);
    for (const n of iso.nonconformities) {
      const actions = actionsOf(n.id);
      if (n.state === 'ACTIONS_PLANNED') expect(actions.some((a) => a.state === 'OPEN')).toBe(true);
      if (n.state === 'AWAITING_VERIFICATION' || n.state === 'CLOSED') {
        // SUBMIT: every action DONE or CANCELLED, one DONE (there is no SUBMIT_NO_ACTION here).
        expect(actions.every((a) => a.state !== 'OPEN')).toBe(true);
        expect(actions.some((a) => a.state === 'DONE')).toBe(true);
      }
      if (n.state === 'CLOSED' || n.state === 'CANCELLED') {
        expect(
          actions.every((a) => a.state !== 'OPEN'),
          'a locked NC has no open action',
        ).toBe(true);
      }
      expect(n.ownerId).not.toBe(n.approverId);
    }
  });

  it('has an incident with incident fields and no personal data, linked to its statutory notice', () => {
    const incidents = iso.nonconformities.filter((n) =>
      (INCIDENT_SOURCES as readonly string[]).includes(n.source),
    );
    expect(incidents.map((n) => n.source).sort()).toEqual(['INCIDENT', 'NEAR_MISS']);
    const injury = incidents.find((n) => n.source === 'INCIDENT')!;
    expect(injury.incident).toMatchObject({ outcome: 'LOST_TIME', reportable: true });
    const notice = byId(register.instances, injury.incident!.statutoryInstanceId!)!;
    expect(notice.unitId).toBe(injury.unitId);
    const act = register.acts.find(
      (a) =>
        a.id ===
        register.obligations.find(
          (o) =>
            o.id === register.assignments.find((x) => x.id === notice.assignmentId)!.obligationId,
        )!.actId,
    )!;
    expect(act.kind ?? 'STATUTE').toBe('STATUTE');
    // No person's name in any NC text field (model §3.11).
    const names = register.people.flatMap((p) => [p.displayName, p.displayName.split(' ')[0]!]);
    for (const n of iso.nonconformities) {
      const text = [
        n.description,
        n.containment,
        n.correction,
        n.rootCause,
        n.similarOccurrences,
        n.riskReview,
        n.systemChange,
        n.noActionReason,
        n.effectivenessNote,
        n.cancelReason,
        n.incident?.location,
      ].join(' ');
      for (const name of names) expect(text, n.description).not.toContain(name);
    }
    // A nonconformity raised by an activity instance names an instance on its unit.
    const raised = iso.nonconformities.find((n) => n.sourceInstanceId !== null)!;
    expect(byId(iso.instances, raised.sourceInstanceId!)!.unitId).toBe(raised.unitId);
  });
});

describe('the management review', () => {
  const review = iso.managementReviews[0]!;

  it('is held, over the three standards, with notes on one input per key', () => {
    expect(iso.managementReviews.map((r) => r.state)).toEqual(['HELD']);
    expect(review.standards).toEqual(['ISO_9001', 'ISO_14001', 'ISO_45001']);
    const inputs = iso.reviewInputs.filter((i) => i.managementReviewId === review.id);
    const keys = inputs.map((i) => byId(catalogue.reviewInputDefs, i.inputDefId)!.key);
    expect(keys).toEqual(ReviewInputKey.options);
    expect(inputs.every((i) => i.notes !== null)).toBe(true);
    // Each key's row names its first definition among the review's standards, as the mock creates them.
    for (const input of inputs) {
      const def = byId(catalogue.reviewInputDefs, input.inputDefId)!;
      const first = (['ISO_9001', 'ISO_14001', 'ISO_45001'] as const)
        .map((code) =>
          catalogue.reviewInputDefs.find(
            (d) => d.standardId === standardOf(code) && d.key === def.key,
          ),
        )
        .find((d) => d !== undefined)!;
      expect(input.inputDefId).toBe(first.id);
    }
  });

  it('has one output per key, decided but one, and its review actions', () => {
    const outputs = iso.reviewOutputs.filter((o) => o.managementReviewId === review.id);
    expect(outputs.map((o) => byId(catalogue.reviewOutputDefs, o.outputDefId)!.key)).toEqual(
      ReviewOutputKey.options,
    );
    expect(outputs.filter((o) => o.decision === null)).toHaveLength(1);
    expect(iso.actions.filter((a) => a.subject.id === review.id).length).toBeGreaterThan(0);
  });
});

describe('files and dates', () => {
  it('has CLEAN and PENDING files, one removed with its reason, each on one subject', () => {
    expect(states(iso.files, 'scanStatus')).toEqual(['CLEAN', 'PENDING']);
    expect(
      iso.files.filter((f) => f.archivedAt !== null).every((f) => f.removeReason !== null),
    ).toBe(true);
    expect(iso.files.some((f) => f.archivedAt !== null)).toBe(true);
    const subjects: Record<string, readonly { id: string }[]> = {
      documentRevisionId: iso.revisions,
      externalAuditId: iso.externalAudits,
      certificationId: iso.certifications,
      nonconformityId: iso.nonconformities,
    };
    for (const f of iso.files) {
      const [column, id] = Object.entries(f).find(
        ([key, value]) => key.endsWith('Id') && key in subjects && value !== null,
      )!;
      expect(byId(subjects[column]!, id as string), f.fileName).toBeDefined();
      expect(f.storageKey.startsWith(`evidence/${FIRM_B}/${NORTHWIND}/iso/`)).toBe(true);
    }
  });

  it('has nothing happen after FIRM_B_AS_OF', () => {
    const late: string[] = [];
    const check = (where: string, value: string | null | undefined) => {
      if (value == null) return;
      if ((value.length === 10 ? instant(value) : value) > AS_OF_END)
        late.push(`${where} ${value}`);
    };
    for (const { table, row } of allRows()) {
      for (const field of [
        'createdAt',
        'updatedAt',
        'archivedAt',
        'uploadedAt',
        'approvedAt',
        'submittedAt',
        'naDecidedAt',
        'completedOn',
        'reportedOn',
        'closedOn',
        'doneOn',
        'heldOn',
        'issuedOn',
        'lastReviewedOn',
        'climateDecidedOn',
      ]) {
        check(`${table}.${field}`, row[field] as string | null | undefined);
      }
    }
    for (const n of iso.nonconformities) check('incident', n.incident?.occurredAt);
    for (const e of iso.auditEvents) check('audit event', e.at);
    for (const r of iso.readings) check('reading', r.periodEnd);
    for (const a of iso.internalAudits.filter(
      (x) => x.state !== 'PLANNED' && x.state !== 'CANCELLED',
    )) {
      check('audit start', a.plannedStart);
    }
    for (const a of iso.externalAudits.filter((x) => x.state !== 'PLANNED'))
      check('visit', a.endOn);
    expect(late).toEqual([]);
  });

  it('names no real client, company or plant (tooling/client-names.json)', () => {
    const denied = JSON.parse(
      readFileSync(new URL('../../../tooling/client-names.json', import.meta.url), 'utf8'),
    ) as { names: string[]; words: string[] };
    const text = JSON.stringify(raw).toLowerCase();
    for (const name of denied.names) expect(text).not.toContain(name);
    for (const word of denied.words) expect(text).not.toMatch(new RegExp(`\\b${word}\\b`));
  });
});

describe('the audit trail sample (ISO-1b, ISO-1a3)', () => {
  const TABLE = {
    management_system: 'managementSystems',
    certification: 'certifications',
    external_audit: 'externalAudits',
    context_item: 'contextItems',
    clause_assessment: 'clauseAssessments',
    controlled_document: 'documents',
    document_revision: 'revisions',
    risk_item: 'riskItems',
    risk_control: 'riskControls',
    objective: 'objectives',
    objective_reading: 'readings',
    audit_programme: 'auditProgrammes',
    internal_audit: 'internalAudits',
    audit_checklist_item: 'auditChecklistItems',
    audit_finding: 'findings',
    nonconformity: 'nonconformities',
    iso_action: 'actions',
    management_review: 'managementReviews',
  } as const satisfies Record<IsoEntityType, TableName>;
  const recordOf = (e: (typeof iso.auditEvents)[number]) =>
    rowsOf(TABLE[e.entityType as IsoEntityType]).find((r) => r.id === e.entityId);

  it('names every ISO entity type, oldest first, each event on a Northwind record of its type', () => {
    const types = new Set(iso.auditEvents.map((e) => e.entityType));
    expect([...types].sort()).toEqual([...ISO_ENTITY_TYPES].sort());
    const at = iso.auditEvents.map((e) => e.at);
    expect(at).toEqual([...at].sort());
    for (const e of iso.auditEvents) {
      expect(e.actorKind, e.id).toBe('PERSON');
      expect(recordOf(e)?.clientId, `${e.entityType} ${e.entityId}`).toBe(NORTHWIND);
    }
  });

  it('writes each CREATE when its record was created, and one CREATE per record at most', () => {
    const creates = iso.auditEvents.filter((e) => e.action === 'CREATE');
    expect(count(creates.map((e) => e.entityId))).toBe(creates.length);
    for (const e of creates) expect(e.at, e.entityType).toBe(recordOf(e)!.createdAt);
    // The system's set-up writes its checklist rows in the same request.
    const setUp = creates.find((e) => e.entityType === 'management_system')!;
    const rows = creates.filter((e) => e.requestId === setUp.requestId);
    expect(rows).toHaveLength(1 + iso.clauseAssessments.length);
  });

  it('starts each created record where its route starts it', () => {
    // A CREATE records the values a create route sets itself, whatever the record holds now.
    const START: Partial<Record<IsoEntityType, Record<string, unknown>>> = {
      management_system: { status: 'PLANNING' },
      clause_assessment: { status: 'NOT_STARTED' },
      document_revision: { action: 'DRAFT_REVISION', state: 'DRAFT' },
      risk_item: { lastReviewedOn: null, significantOverride: null, significanceReason: null },
      objective: { closedOn: null, outcome: null },
      internal_audit: { state: 'PLANNED' },
      nonconformity: { action: 'RAISE', state: 'OPEN' },
      iso_action: { state: 'OPEN' },
      management_review: { state: 'PLANNED' },
    };
    for (const e of iso.auditEvents.filter((x) => x.action === 'CREATE')) {
      const start = START[e.entityType as IsoEntityType];
      if (start !== undefined) expect(e.after, e.entityType).toMatchObject(start);
    }
  });

  it('takes one form’s first revision from draft to approval by two different people', () => {
    const steps = iso.auditEvents.filter((e) => e.entityType === 'document_revision');
    expect(steps.map((e) => e.after?.action)).toEqual(['DRAFT_REVISION', 'SUBMIT', 'APPROVE']);
    expect(new Set(steps.map((e) => e.entityId)).size).toBe(1);
    const revision = byId(iso.revisions, steps[0]!.entityId)!;
    expect(revision.state).toBe('APPROVED');
    expect(steps[1]!.actorId).toBe(revision.preparedById);
    expect(steps[2]!.actorId).toBe(revision.approvedById);
    expect(steps[2]!.actorId).not.toBe(steps[1]!.actorId);
  });

  it('has the step that set each entered date or settled each record, on the day its row says (ISO-1a3)', () => {
    const day = (instantAt: string) => instantAt.slice(0, 10);
    const steps = (type: IsoEntityType, id: string) =>
      iso.auditEvents.filter(
        (e) => e.entityType === type && e.entityId === id && e.action !== 'CREATE',
      );
    const only = (type: IsoEntityType, id: string, action: string) => {
      const found = steps(type, id);
      expect(
        found.map((e) => e.after?.action),
        `${type} ${id}`,
      ).toEqual([action]);
      return found[0]!;
    };
    for (const audit of iso.internalAudits.filter((a) => a.reportedOn !== null)) {
      const report = only('internal_audit', audit.id, 'REPORT');
      expect(day(report.at)).toBe(audit.reportedOn);
      expect(report.actorId).toBe(audit.leadAuditorId);
    }
    for (const audit of iso.externalAudits) {
      const held = ['HELD', 'RESPONDED', 'CLOSED'].includes(audit.state);
      if (!held) expect(steps('external_audit', audit.id)).toEqual([]);
      else expect(day(only('external_audit', audit.id, 'RECORD_HELD').at)).toBe(audit.endOn);
    }
    for (const objective of iso.objectives) {
      if (objective.closedOn === null) expect(steps('objective', objective.id)).toEqual([]);
      else expect(day(only('objective', objective.id, 'CLOSE').at)).toBe(objective.closedOn);
    }
    expect(iso.actions.filter((a) => a.state === 'DONE').length).toBeGreaterThan(0);
    expect(iso.actions.filter((a) => a.state === 'CANCELLED').length).toBeGreaterThan(0);
    for (const action of iso.actions) {
      if (action.state === 'OPEN') {
        expect(steps('iso_action', action.id)).toEqual([]);
        continue;
      }
      const settled = only(
        'iso_action',
        action.id,
        action.state === 'DONE' ? 'COMPLETE' : 'CANCEL',
      );
      expect(settled.at).toBe(action.updatedAt);
      if (action.state === 'DONE') expect(day(settled.at)).toBe(action.doneOn);
      else expect(settled.reason).toBe(action.cancelReason);
    }
    const climate = iso.auditEvents.filter(
      (e) => e.entityType === 'management_system' && e.action === 'UPDATE',
    );
    expect(climate).toHaveLength(1);
    expect(day(climate[0]!.at)).toBe(system.climateDecidedOn);
    expect(climate[0]!.after).toEqual({
      climateChangeRelevant: system.climateChangeRelevant,
      climateDecidedOn: system.climateDecidedOn,
    });
  });

  it('leaves out the window events the held review’s figures count', () => {
    // Context and risk UPDATEs and an NC's steps after RAISE: the review figures' event-day lists.
    for (const e of iso.auditEvents) {
      if (['context_item', 'risk_item', 'nonconformity'].includes(e.entityType)) {
        expect(e.action, e.entityType).toBe('CREATE');
      }
    }
  });

  it('copies no incident personal data and no finding description into an event (model §3.11)', () => {
    const text = JSON.stringify(iso.auditEvents);
    for (const nc of iso.nonconformities.filter((n) => n.incident !== null)) {
      expect(text).not.toContain(nc.incident!.location);
      expect(text).not.toContain(nc.description);
      expect(text).not.toContain(nc.incident!.occurredAt);
    }
    for (const f of iso.findings) expect(text).not.toContain(f.description);
  });
});

describe('the STANDARD activities on Northwind’s register', () => {
  const STANDARD_OBLIGATIONS = new Set(catalogue.obligations.map((o) => o.id));

  it('assigns catalogue activities to Northwind units, with a department, owner and approver', () => {
    const departments = register.departments
      .filter((d) => d.clientId === NORTHWIND)
      .map((d) => d.id);
    expect(iso.assignments.length).toBeGreaterThan(0);
    for (const a of iso.assignments) {
      expect(STANDARD_OBLIGATIONS.has(a.obligationId)).toBe(true);
      expect([PUNE, BENGALURU]).toContain(a.unitId);
      expect(departments).toContain(a.departmentId);
      expect([PERSON.rohan, PERSON.sameer]).toContain(a.defaultOwnerId);
      expect([PERSON.nisha, PERSON.divya]).toContain(a.defaultApproverId);
    }
    // Each standard's act and the integrated act have an activity on the register.
    const acts = iso.assignments.map(
      (a) => catalogue.obligations.find((o) => o.id === a.obligationId)!.actId,
    );
    expect(count(acts)).toBe(catalogue.acts.length);
    expect(
      iso.assignments.some(
        (a) => a.obligationId === isoCatalogueId(FIRM_B, 'obligation:EMERGENCY-DRILL'),
      ),
    ).toBe(true);
  });

  it('has FY 2024-25 instances in a mix of states, evidence on each done one', () => {
    const at = (i: (typeof iso.instances)[number]) => i.workflowState;
    for (const i of iso.instances) {
      const a = byId(iso.assignments, i.assignmentId)!;
      expect(i.unitId).toBe(a.unitId);
      expect(i.periodStart >= '2024-04-01' && i.periodEnd <= '2025-03-31').toBe(true);
    }
    expect(count(iso.instances.map((i) => `${i.assignmentId}|${i.periodStart}`))).toBe(
      iso.instances.length,
    );
    expect(states(iso.instances, 'workflowState')).toEqual(['APPROVED', 'OPEN', 'SUBMITTED']);
    const open = iso.instances.filter((i) => at(i) === 'OPEN');
    expect(open.some((i) => i.dueDate < FIRM_B_AS_OF)).toBe(true);
    expect(open.some((i) => i.dueDate >= FIRM_B_AS_OF)).toBe(true);
    expect(iso.instances.filter((i) => at(i) === 'SUBMITTED')).toHaveLength(1);
    for (const i of iso.instances.filter((x) => x.completedOn !== null)) {
      expect(iso.evidence.filter((e) => e.instanceId === i.id).map((e) => e.scanStatus)).toEqual([
        'CLEAN',
      ]);
    }
    for (const e of iso.evidence) expect(byId(iso.instances, e.instanceId)).toBeDefined();
  });

  it('stays out of the Pune approver’s queue and the first of the Pune owner’s open work (web e2e)', () => {
    // The register journeys bulk-approve everything waiting for Nisha and work Rohan's earliest open rows.
    expect(
      iso.instances.filter((i) => i.approverId === PERSON.nisha && i.workflowState === 'SUBMITTED'),
    ).toEqual([]);
    const rohansOpen = iso.instances.filter(
      (i) => i.ownerId === PERSON.rohan && i.workflowState === 'OPEN',
    );
    expect(rohansOpen.every((i) => i.dueDate >= '2024-11-30')).toBe(true);
    // Nothing due in the portfolio's "this week" (FIRM_B_AS_OF + 6 days).
    expect(
      iso.instances.filter((i) => i.dueDate >= FIRM_B_AS_OF && i.dueDate <= '2024-11-21'),
    ).toEqual([]);
    // The evidence vault's newest file stays firm B's own (it lists newest first).
    const newest = register.evidence
      .map((e) => e.createdAt)
      .sort()
      .at(-1)!;
    expect(iso.evidence.every((e) => e.createdAt < newest)).toBe(true);
  });
});

describe('the mock store', () => {
  let app: App;
  beforeAll(async () => {
    app = await isoApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('merges the set into firm B, with the catalogue copy, and gives firm A no ISO rows', () => {
    const firm = firmB(app);
    expect(firm.isoCatalogueCopiedAt).toBe(iso.catalogueCopiedAt);
    expect(firm.isoCatalogue.clauses).toHaveLength(loadIsoCatalogue().clauses.length);
    for (const table of TABLES) {
      const stored = new Set(
        (table in firm.iso
          ? (firm.iso[table as keyof typeof firm.iso] as { id: string }[])
          : (firm.data[table as 'assignments' | 'instances' | 'evidence'] as { id: string }[])
        ).map((r) => r.id),
      );
      for (const row of rowsOf(table)) expect(stored.has(row.id as string), table).toBe(true);
    }
    const other = app.store.firms.find((f) => f.data.firm.id !== FIRM_B)!;
    expect(Object.values(other.iso).every((rows) => rows.length === 0)).toBe(true);
    expect(other.isoCatalogueCopiedAt).toBeNull();
  });

  it('serves every fixture record through the ISO routes, in its response schema', async () => {
    const as = PERSON.meera;
    const one = async (id: Parameters<typeof ok>[1], params: Record<string, string>) =>
      ok<{ id: string }>(app, id, { as, params });
    const list = async (
      id: Parameters<typeof ok>[1],
      params: Record<string, string> = {},
      query: Record<string, string> = {},
    ) =>
      (await ok<{ items: { id: string }[] }>(app, id, { as, params, query })).items.map(
        (r) => r.id,
      );

    expect((await one('getIsoSystem', { id: system.id })).id).toBe(system.id);
    expect((await list('listIsoContextItems', { id: system.id })).sort()).toEqual(
      iso.contextItems.map((c) => c.id).sort(),
    );
    expect(await list('listIsoChecklist', { id: system.id })).toHaveLength(
      iso.clauseAssessments.length,
    );
    for (const d of iso.documents) {
      expect((await one('getIsoDocument', { id: d.id })).id).toBe(d.id);
      expect((await list('listIsoRevisions', { id: d.id })).sort()).toEqual(
        iso.revisions
          .filter((r) => r.documentId === d.id)
          .map((r) => r.id)
          .sort(),
      );
    }
    for (const r of iso.riskItems) {
      expect((await one('getIsoRisk', { id: r.id })).id).toBe(r.id);
      expect((await list('listIsoRiskControls', { id: r.id })).sort()).toEqual(
        iso.riskControls
          .filter((c) => c.riskItemId === r.id)
          .map((c) => c.id)
          .sort(),
      );
    }
    for (const o of iso.objectives) {
      expect((await one('getIsoObjective', { id: o.id })).id).toBe(o.id);
      expect(await list('listIsoReadings', { id: o.id })).toHaveLength(
        iso.readings.filter((r) => r.objectiveId === o.id).length,
      );
    }
    expect(await list('listIsoAuditProgrammes', {}, { managementSystemId: system.id })).toEqual([
      iso.auditProgrammes[0]!.id,
    ]);
    for (const a of iso.internalAudits) {
      expect((await one('getIsoInternalAudit', { id: a.id })).id).toBe(a.id);
      expect((await list('listIsoAuditChecklist', { id: a.id })).sort()).toEqual(
        iso.auditChecklistItems
          .filter((c) => c.internalAuditId === a.id)
          .map((c) => c.id)
          .sort(),
      );
      expect((await list('listIsoInternalFindings', { id: a.id })).sort()).toEqual(
        iso.findings
          .filter((f) => f.internalAuditId === a.id)
          .map((f) => f.id)
          .sort(),
      );
    }
    expect(
      (await list('listIsoCertifications', {}, { managementSystemId: system.id })).sort(),
    ).toEqual(iso.certifications.map((c) => c.id).sort());
    for (const a of iso.externalAudits) {
      expect((await one('getIsoExternalAudit', { id: a.id })).id).toBe(a.id);
      expect((await list('listIsoExternalFindings', { id: a.id })).sort()).toEqual(
        iso.findings
          .filter((f) => f.externalAuditId === a.id)
          .map((f) => f.id)
          .sort(),
      );
    }
    for (const n of iso.nonconformities) {
      expect((await one('getIsoNonconformity', { id: n.id })).id).toBe(n.id);
    }
    for (const a of iso.actions) expect((await one('getIsoAction', { id: a.id })).id).toBe(a.id);
    const review = iso.managementReviews[0]!;
    expect((await one('getIsoManagementReview', { id: review.id })).id).toBe(review.id);
    expect(await list('listIsoReviewInputs', { id: review.id })).toHaveLength(
      ReviewInputKey.options.length,
    );
    expect(await list('listIsoReviewOutputs', { id: review.id })).toHaveLength(
      ReviewOutputKey.options.length,
    );
    const policyFile = iso.files.find((f) => f.documentRevisionId !== null)!;
    expect(
      await list(
        'listIsoFiles',
        {},
        { subjectType: 'document_revision', subjectId: policyFile.documentRevisionId! },
      ),
    ).toContain(policyFile.id);
    await ok(app, 'getIsoOverview', { as, query: { managementSystemId: system.id } });
  });

  it('shows the derived state the data was built for', async () => {
    const objective = (key: string) =>
      ok<ObjectiveView>(app, 'getIsoObjective', {
        params: { id: fixtureId(`firm-b:iso:objective:${key}`) },
      });
    expect((await objective('energy')).progress.onTrack).toBe(true);
    expect((await objective('complaints')).progress.onTrack).toBe(false);
    const nc = await ok<NonconformityView>(app, 'getIsoNonconformity', {
      params: { id: fixtureId('firm-b:iso:nc:tray-change') },
    });
    expect(nc.status).toMatchObject({ timing: 'OVERDUE', overdueDays: 5 });
    expect(nc.findingId).toBe(fixtureId('firm-b:iso:finding:q2-tray-change'));
  });

  it('keeps unit scope: a Pune owner sees Pune records and not the Bengaluru near miss', async () => {
    const ncs = await ok<{ items: { id: string; unitId: string | null }[] }>(
      app,
      'listIsoNonconformities',
      { as: PERSON.rohan, query: { managementSystemId: system.id, limit: '100' } },
    );
    const nearMiss = iso.nonconformities.find((n) => n.source === 'NEAR_MISS')!;
    expect(nearMiss.unitId).toBe(BENGALURU);
    expect(ncs.items.map((n) => n.id)).not.toContain(nearMiss.id);
    expect(ncs.items.length).toBeGreaterThan(0);
  });

  it('lists the STANDARD instances in the register, for the units each person can see', async () => {
    const ims = isoCatalogueId(FIRM_B, 'act:IMS');
    const listed = async (as: string) =>
      (
        await ok<{ items: { id: string }[] }>(app, 'listInstances', {
          as,
          params: { clientId: NORTHWIND },
          query: { actId: ims, limit: '200' },
        })
      ).items.map((i) => i.id);
    const imsInstances = iso.instances.filter((i) => {
      const obligationId = byId(iso.assignments, i.assignmentId)!.obligationId;
      return catalogue.obligations.find((o) => o.id === obligationId)!.actId === ims;
    });
    expect((await listed(PERSON.meera)).sort()).toEqual(imsInstances.map((i) => i.id).sort());
    expect((await listed(PERSON.rohan)).sort()).toEqual(
      imsInstances
        .filter((i) => i.unitId === PUNE)
        .map((i) => i.id)
        .sort(),
    );
    // Divya's approvals queue holds the waiting activity.
    const waiting = await ok<{ items: { id: string }[] }>(app, 'listInstances', {
      as: PERSON.divya,
      params: { clientId: NORTHWIND },
      query: { approverId: 'me', workflowState: 'SUBMITTED', limit: '200' },
    });
    const submitted = iso.instances.find((i) => i.workflowState === 'SUBMITTED')!;
    expect(waiting.items.map((i) => i.id)).toContain(submitted.id);
  });
});
