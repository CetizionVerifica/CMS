import {
  AuditChecklistItem,
  AuditFinding,
  AuditProgramme,
  FindingType,
  Id,
  InternalAudit,
  InternalAuditState,
  IsoAction,
  IsoActionState,
  IsoActionSubject,
  IsoActionSubjectType,
  IsoStandardCode,
  LocalDate,
  ManagementReview,
  ManagementReviewState,
  NcSeverity,
  NcSource,
  NcState,
  Nonconformity,
  Objective,
  ObjectiveReading,
  ReviewInput,
  ReviewOutput,
  RiskControl,
  RiskItem,
  RiskKind,
} from '@canopy/contracts';
import { and, asc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { TenantTx } from '../database.js';
import { rethrow, validate } from '../errors.js';
import * as s from '../schema/index.js';
import { containsPattern, entity, type NewEntity } from './crud.js';
import {
  anyOf,
  inScope,
  keysetPage,
  linkedRecord,
  pageShape,
  systemUnitsMatch,
  unitOrSystemMatch,
  uuids,
  UnitScope,
  type IsoPage,
  type Link,
  type Patch,
} from './iso-shared.js';

/**
 * The ISO add-on's records, part 2 (docs/iso/model.md §3.5-3.13; ISO-2e): risk items and controls, objectives and
 * readings, audit programmes, internal audits, checklists, findings, nonconformities, actions and management reviews.
 * As in part 1 (iso.ts), M16 reads and writes them under the request's tenant context and checks roles, the feature
 * switch, state machines and people; list filters apply the unit scope of docs/iso/plan.md §3.3 in SQL when the
 * caller passes one. A child record (control, reading, checklist row, finding, action, review input or output) takes
 * its parent's scope: its by-parent reads take none, since M16 has checked the parent.
 */

/** A by-value filter: undefined is no filter, an empty list matches nothing. */
function oneOf(column: PgColumn, values: readonly string[] | undefined): SQL | undefined {
  if (values === undefined) return undefined;
  return values.length ? inArray(column, [...values]) : sql`false`;
}

const onOrAfter = (column: PgColumn, day: string | undefined) =>
  day ? sql`${column} >= ${day}` : undefined;
const onOrBefore = (column: PgColumn, day: string | undefined) =>
  day ? sql`${column} <= ${day}` : undefined;

/** A list page's result, with its total when asked. */
function pageOf<T>(items: T[], nextCursor: string | null, total: number | undefined): IsoPage<T> {
  return { items, nextCursor, ...(total !== undefined && { total }) };
}

// ---------- unit scope (plan §3.3) ----------

const named = (table: string, parent: string, column: PgColumn) => (personId: string) =>
  sql`exists (select 1 from ${sql.identifier(table)} j where j.${sql.identifier(parent)} = ${column} and j.archived_at is null and j.person_id = ${personId})`;

/** A risk item: its unit, or (none) its system's units; or its owner. */
function riskScope(scope: UnitScope): SQL {
  const r = s.riskItem;
  return inScope(scope, unitOrSystemMatch(r.unitId, r.managementSystemId, scope.unitIds), [
    r.ownerId,
  ])!;
}

/** An objective: its system's units, or its owner. */
function objectiveScope(scope: UnitScope): SQL {
  const o = s.objective;
  return inScope(scope, systemUnitsMatch(o.managementSystemId, scope.unitIds), [o.ownerId])!;
}

/**
 * An internal audit: its own units, or (none) its programme's system's units; or a person it names (lead, auditor,
 * auditee, reported-to).
 */
function internalAuditScope(scope: UnitScope): SQL {
  const a = s.internalAudit;
  const units = uuids(scope.unitIds);
  const own = sql`(exists (select 1 from internal_audit_unit u where u.internal_audit_id = ${a.id} and u.archived_at is null and u.unit_id = any(${units}))
    or (not exists (select 1 from internal_audit_unit u where u.internal_audit_id = ${a.id} and u.archived_at is null)
      and exists (select 1 from audit_programme p where p.id = ${a.programmeId} and ${systemUnitsMatch(sql`p.management_system_id`, scope.unitIds)})))`;
  return inScope(scope, own, [
    a.leadAuditorId,
    named('internal_audit_person', 'internal_audit_id', a.id),
  ])!;
}

/** An external audit: its system's units. */
function externalAuditScope(scope: UnitScope): SQL {
  return systemUnitsMatch(s.externalAudit.managementSystemId, scope.unitIds);
}

/** A nonconformity: its unit, or (none) its system's units; or its owner, approver or an investigator. */
function nonconformityScope(scope: UnitScope): SQL {
  const n = s.nonconformity;
  return inScope(scope, unitOrSystemMatch(n.unitId, n.managementSystemId, scope.unitIds), [
    n.ownerId,
    n.approverId,
    named('nonconformity_person', 'nonconformity_id', n.id),
  ])!;
}

/** A management review: its system's units, or its chair or an attendee. */
function reviewScope(scope: UnitScope): SQL {
  const m = s.managementReview;
  return inScope(scope, systemUnitsMatch(m.managementSystemId, scope.unitIds), [
    m.chairId,
    named('management_review_person', 'management_review_id', m.id),
  ])!;
}

/** A finding takes its audit's scope. */
function findingScope(scope: UnitScope): SQL {
  const f = s.auditFinding;
  return or(
    sql`exists (select 1 from ${s.internalAudit} where ${eq(s.internalAudit.id, f.internalAuditId)} and ${internalAuditScope(scope)})`,
    sql`exists (select 1 from ${s.externalAudit} where ${eq(s.externalAudit.id, f.externalAuditId)} and ${externalAuditScope(scope)})`,
  )!;
}

/** An action takes its subject's scope, or names its owner. */
function actionScope(scope: UnitScope): SQL {
  const a = s.isoAction;
  const subject = (
    table:
      | typeof s.nonconformity
      | typeof s.riskItem
      | typeof s.objective
      | typeof s.auditFinding
      | typeof s.managementReview,
    column: PgColumn,
    inside: SQL,
  ) => sql`exists (select 1 from ${table} where ${eq(table.id, column)} and ${inside})`;
  return inScope(
    scope,
    or(
      subject(s.nonconformity, a.nonconformityId, nonconformityScope(scope)),
      subject(s.riskItem, a.riskItemId, riskScope(scope)),
      subject(s.objective, a.objectiveId, objectiveScope(scope)),
      subject(s.auditFinding, a.auditFindingId, findingScope(scope)),
      subject(s.managementReview, a.managementReviewId, reviewScope(scope)),
    )!,
    [a.ownerId],
  )!;
}

// ---------- risk items and controls ----------

const riskEntity = entity<RiskItem>({ table: s.riskItem, schema: RiskItem });
const controlEntity = entity<RiskControl>({ table: s.riskControl, schema: RiskControl });

export const RiskItemFilter = z.strictObject({
  ...pageShape,
  managementSystemIds: z.array(Id).optional(),
  kind: z.array(RiskKind).optional(),
  /** Items on any of these units. */
  unitIds: z.array(Id).optional(),
  ownerId: Id.optional(),
  significant: z.boolean().optional(),
  climateRelated: z.boolean().optional(),
  /** Items whose review is due on or before this date. */
  reviewDueTo: LocalDate.optional(),
  includeArchived: z.boolean().optional(),
  scope: UnitScope.optional(),
});
export type RiskItemFilter = z.input<typeof RiskItemFilter>;

export const riskItems = {
  get: riskEntity.get,
  require: riskEntity.require,
  /** A client's risk items, oldest first. Unit scope: their unit, or (none) the system's; or their owner. */
  async list(
    tx: TenantTx,
    clientId: string,
    filter: RiskItemFilter = {},
  ): Promise<IsoPage<RiskItem>> {
    const f = validate(RiskItemFilter, filter);
    const r = s.riskItem;
    const { items, nextCursor, total } = await keysetPage(tx, {
      table: r,
      id: r.id,
      sort: r.id,
      page: f,
      parse: riskEntity.parse,
      where: [
        eq(r.clientId, clientId),
        f.includeArchived ? undefined : isNull(r.archivedAt),
        anyOf(r.managementSystemId, f.managementSystemIds),
        oneOf(r.kind, f.kind),
        anyOf(r.unitId, f.unitIds),
        f.ownerId ? eq(r.ownerId, f.ownerId) : undefined,
        f.significant === undefined ? undefined : eq(r.significant, f.significant),
        f.climateRelated === undefined ? undefined : eq(r.climateRelated, f.climateRelated),
        onOrBefore(r.reviewDueOn, f.reviewDueTo),
        f.scope && riskScope(f.scope),
      ],
    });
    return pageOf(items, nextCursor, total);
  },
  create: (tx: TenantTx, input: NewEntity<RiskItem>) => riskEntity.create(tx, input),
  update: (
    tx: TenantTx,
    id: string,
    version: number,
    patch: Patch<RiskItem, 'managementSystemId' | 'kind'>,
  ) => riskEntity.update(tx, id, version, patch),
  archive: riskEntity.archive,
};

export const riskControls = {
  get: controlEntity.get,
  require: controlEntity.require,
  /** A risk item's controls in place, oldest first. */
  forRiskItem: (tx: TenantTx, riskItemId: string): Promise<RiskControl[]> =>
    controlEntity.findAll(tx, { riskItemId }).then(byId),
  create: (tx: TenantTx, input: NewEntity<RiskControl>) => controlEntity.create(tx, input),
  update: (
    tx: TenantTx,
    id: string,
    version: number,
    patch: Patch<RiskControl, 'riskItemId' | 'sourceActionId'>,
  ) => controlEntity.update(tx, id, version, patch),
  archive: controlEntity.archive,
};

/** Rows in id (creation) order. */
function byId<T extends { id: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- objectives and readings ----------

const OBJECTIVE_RISK_ITEMS: Link = {
  table: s.objectiveRiskItem,
  parent: 'objectiveId',
  value: 'riskItemId',
  max: 100,
};

const objectiveRecord = linkedRecord<
  Objective,
  NewEntity<Objective>,
  Patch<Objective, 'managementSystemId'>
>({
  table: s.objective,
  schema: Objective,
  links: { riskItemIds: OBJECTIVE_RISK_ITEMS },
});
const readingEntity = entity<ObjectiveReading>({
  table: s.objectiveReading,
  schema: ObjectiveReading,
});

export const ObjectiveFilter = z.strictObject({
  ...pageShape,
  managementSystemIds: z.array(Id).optional(),
  /** Objectives of this standard. */
  standard: IsoStandardCode.optional(),
  ownerId: Id.optional(),
  /** true: not closed; false: closed. */
  open: z.boolean().optional(),
  includeArchived: z.boolean().optional(),
  scope: UnitScope.optional(),
});
export type ObjectiveFilter = z.input<typeof ObjectiveFilter>;

export const objectives = {
  get: objectiveRecord.get,
  require: objectiveRecord.require,
  /** A client's objectives by due date. Unit scope: the system's units, or their owner. */
  async list(
    tx: TenantTx,
    clientId: string,
    filter: ObjectiveFilter = {},
  ): Promise<IsoPage<Objective>> {
    const f = validate(ObjectiveFilter, filter);
    const o = s.objective;
    const page = await keysetPage(tx, {
      table: o,
      id: o.id,
      sort: o.dueOn,
      page: f,
      parse: objectiveRecord.parseRow,
      where: [
        eq(o.clientId, clientId),
        f.includeArchived ? undefined : isNull(o.archivedAt),
        anyOf(o.managementSystemId, f.managementSystemIds),
        f.standard ? sql`${o.standards} @> array[${f.standard}]::iso_standard_code[]` : undefined,
        f.ownerId ? eq(o.ownerId, f.ownerId) : undefined,
        f.open === undefined ? undefined : f.open ? isNull(o.closedOn) : isNotNull(o.closedOn),
        f.scope && objectiveScope(f.scope),
      ],
    });
    return pageOf(await objectiveRecord.complete(tx, page.items), page.nextCursor, page.total);
  },
  /** `riskItemIds` are `objective_risk_item` rows; a patch's list replaces the live ones. */
  create: objectiveRecord.create,
  update: objectiveRecord.update,
  archive: objectiveRecord.archive,
};

export const objectiveReadings = {
  get: readingEntity.get,
  require: readingEntity.require,
  /** An objective's readings by period. */
  async forObjective(tx: TenantTx, objectiveId: string): Promise<ObjectiveReading[]> {
    const r = s.objectiveReading;
    const rows = await tx
      .select()
      .from(r)
      .where(and(eq(r.objectiveId, objectiveId), isNull(r.archivedAt)))
      .orderBy(asc(r.periodStart), asc(r.id))
      .catch(rethrow);
    return rows.map((row) => readingEntity.parse(row));
  },
  create: (tx: TenantTx, input: NewEntity<ObjectiveReading>) => readingEntity.create(tx, input),
  update: (
    tx: TenantTx,
    id: string,
    version: number,
    patch: Patch<ObjectiveReading, 'objectiveId'>,
  ) => readingEntity.update(tx, id, version, patch),
  archive: readingEntity.archive,
};

// ---------- audit programmes and internal audits ----------

const programmeEntity = entity<AuditProgramme>({ table: s.auditProgramme, schema: AuditProgramme });

const auditPeople = (role: 'AUDITOR' | 'AUDITEE' | 'REPORTED_TO', max: number): Link => ({
  table: s.internalAuditPerson,
  parent: 'internalAuditId',
  value: 'personId',
  role,
  max,
});

const internalAuditRecord = linkedRecord<
  InternalAudit,
  NewEntity<InternalAudit>,
  Patch<InternalAudit, 'programmeId'>
>({
  table: s.internalAudit,
  schema: InternalAudit,
  links: {
    unitIds: { table: s.internalAuditUnit, parent: 'internalAuditId', value: 'unitId', max: 500 },
    auditorIds: auditPeople('AUDITOR', 20),
    auditeeIds: auditPeople('AUDITEE', 100),
    reportedToIds: auditPeople('REPORTED_TO', 20),
  },
});

export const auditProgrammes = {
  get: programmeEntity.get,
  require: programmeEntity.require,
  /** A system's programmes by FY. Unit scope: the system's units. */
  async list(
    tx: TenantTx,
    managementSystemId: string,
    filter: { includeArchived?: boolean; scope?: UnitScope } = {},
  ): Promise<AuditProgramme[]> {
    const f = validate(
      z.strictObject({ includeArchived: z.boolean().optional(), scope: UnitScope.optional() }),
      filter,
    );
    const p = s.auditProgramme;
    const rows = await tx
      .select()
      .from(p)
      .where(
        and(
          eq(p.managementSystemId, managementSystemId),
          f.includeArchived ? undefined : isNull(p.archivedAt),
          f.scope && inScope(f.scope, systemUnitsMatch(p.managementSystemId, f.scope.unitIds)),
        ),
      )
      .orderBy(asc(p.fy))
      .catch(rethrow);
    return rows.map((row) => programmeEntity.parse(row));
  },
  /** DUPLICATE when the system already has a programme for that FY. */
  create: (tx: TenantTx, input: NewEntity<AuditProgramme>) => programmeEntity.create(tx, input),
  update: (
    tx: TenantTx,
    id: string,
    version: number,
    patch: Patch<AuditProgramme, 'managementSystemId' | 'fy'>,
  ) => programmeEntity.update(tx, id, version, patch),
  archive: programmeEntity.archive,
};

export const InternalAuditFilter = z.strictObject({
  ...pageShape,
  programmeIds: z.array(Id).optional(),
  managementSystemIds: z.array(Id).optional(),
  state: z.array(InternalAuditState).optional(),
  /** On `plannedStart`, inclusive. */
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  /** Audits naming this person as lead, auditor, auditee or reported-to. */
  personId: Id.optional(),
  includeArchived: z.boolean().optional(),
  scope: UnitScope.optional(),
});
export type InternalAuditFilter = z.input<typeof InternalAuditFilter>;

export const internalAudits = {
  get: internalAuditRecord.get,
  require: internalAuditRecord.require,
  /**
   * A client's internal audits by planned start. Unit scope: their own units, or (none) their programme's system's;
   * or a person they name.
   */
  async list(
    tx: TenantTx,
    clientId: string,
    filter: InternalAuditFilter = {},
  ): Promise<IsoPage<InternalAudit>> {
    const f = validate(InternalAuditFilter, filter);
    const a = s.internalAudit;
    const page = await keysetPage(tx, {
      table: a,
      id: a.id,
      sort: a.plannedStart,
      page: f,
      parse: internalAuditRecord.parseRow,
      where: [
        eq(a.clientId, clientId),
        f.includeArchived ? undefined : isNull(a.archivedAt),
        anyOf(a.programmeId, f.programmeIds),
        f.managementSystemIds &&
          (f.managementSystemIds.length
            ? sql`exists (select 1 from audit_programme p where p.id = ${a.programmeId} and p.management_system_id = any(${uuids(f.managementSystemIds)}))`
            : sql`false`),
        oneOf(a.state, f.state),
        onOrAfter(a.plannedStart, f.from),
        onOrBefore(a.plannedStart, f.to),
        f.personId
          ? or(
              eq(a.leadAuditorId, f.personId),
              named('internal_audit_person', 'internal_audit_id', a.id)(f.personId),
            )
          : undefined,
        f.scope && internalAuditScope(f.scope),
      ],
    });
    return pageOf(await internalAuditRecord.complete(tx, page.items), page.nextCursor, page.total);
  },
  /**
   * `unitIds`, `auditorIds`, `auditeeIds` and `reportedToIds` are join rows; a patch's list replaces the live ones.
   * The result is checked against the contract with its lists, so a REPORT naming nobody to report to fails.
   */
  create: internalAuditRecord.create,
  update: internalAuditRecord.update,
  archive: internalAuditRecord.archive,
};

// ---------- checklists and findings ----------

const checklistEntity = entity<AuditChecklistItem>({
  table: s.auditChecklistItem,
  schema: AuditChecklistItem,
});
const findingEntity = entity<AuditFinding>({ table: s.auditFinding, schema: AuditFinding });

export const auditChecklistItems = {
  get: checklistEntity.get,
  require: checklistEntity.require,
  /** An audit's checklist in id order (UUIDv7: roughly the order its rows were added). */
  forAudit: (tx: TenantTx, internalAuditId: string): Promise<AuditChecklistItem[]> =>
    checklistEntity.findAll(tx, { internalAuditId }).then(byId),
  create: (tx: TenantTx, input: NewEntity<AuditChecklistItem>) => checklistEntity.create(tx, input),
  createMany: (tx: TenantTx, inputs: readonly NewEntity<AuditChecklistItem>[]) =>
    checklistEntity.createMany(tx, inputs),
  update: (
    tx: TenantTx,
    id: string,
    version: number,
    patch: Patch<AuditChecklistItem, 'internalAuditId'>,
  ) => checklistEntity.update(tx, id, version, patch),
  archive: checklistEntity.archive,
};

export const AuditFindingFilter = z.strictObject({
  ...pageShape,
  internalAuditIds: z.array(Id).optional(),
  externalAuditIds: z.array(Id).optional(),
  type: z.array(FindingType).optional(),
  includeArchived: z.boolean().optional(),
  scope: UnitScope.optional(),
});
export type AuditFindingFilter = z.input<typeof AuditFindingFilter>;

export const auditFindings = {
  get: findingEntity.get,
  require: findingEntity.require,
  /** One audit's findings, oldest first. */
  forAudit: (
    tx: TenantTx,
    audit: { internalAuditId: string } | { externalAuditId: string },
  ): Promise<AuditFinding[]> => findingEntity.findAll(tx, audit).then(byId),
  /** The finding that raised an NC, if one did (the link is on the finding only, model §3.9). */
  async forNonconformity(tx: TenantTx, nonconformityId: string): Promise<AuditFinding | null> {
    const [row] = await findingEntity.findAll(tx, { nonconformityId });
    return row ?? null;
  },
  /** A client's findings, oldest first. Unit scope: their audit's. */
  async list(
    tx: TenantTx,
    clientId: string,
    filter: AuditFindingFilter = {},
  ): Promise<IsoPage<AuditFinding>> {
    const f = validate(AuditFindingFilter, filter);
    const a = s.auditFinding;
    const { items, nextCursor, total } = await keysetPage(tx, {
      table: a,
      id: a.id,
      sort: a.id,
      page: f,
      parse: findingEntity.parse,
      where: [
        eq(a.clientId, clientId),
        f.includeArchived ? undefined : isNull(a.archivedAt),
        anyOf(a.internalAuditId, f.internalAuditIds),
        anyOf(a.externalAuditId, f.externalAuditIds),
        oneOf(a.type, f.type),
        f.scope && findingScope(f.scope),
      ],
    });
    return pageOf(items, nextCursor, total);
  },
  /** An NC finding's nonconformity is created first, in the same transaction (model §3.9). */
  create: (tx: TenantTx, input: NewEntity<AuditFinding>) => findingEntity.create(tx, input),
  update: (
    tx: TenantTx,
    id: string,
    version: number,
    patch: Patch<AuditFinding, 'internalAuditId' | 'externalAuditId' | 'nonconformityId'>,
  ) => findingEntity.update(tx, id, version, patch),
  archive: findingEntity.archive,
};

// ---------- nonconformities ----------

/** Incident fields (model §3.11) and their `nonconformity` columns; investigators are join rows. */
const INCIDENT_COLUMNS = {
  occurredAt: 'incidentOccurredAt',
  location: 'incidentLocation',
  type: 'incidentType',
  outcome: 'incidentOutcome',
  personCategory: 'incidentPersonCategory',
  lostDays: 'incidentLostDays',
  reportable: 'incidentReportable',
  statutoryInstanceId: 'statutoryInstanceId',
  workerParticipation: 'incidentWorkerParticipation',
} as const;

const NC_LINKS = {
  investigatorIds: {
    table: s.nonconformityPerson,
    parent: 'nonconformityId',
    value: 'personId',
    max: 20,
  },
  relatedRiskItemIds: {
    table: s.nonconformityRiskItem,
    parent: 'nonconformityId',
    value: 'riskItemId',
    role: 'RELATED',
    max: 50,
  },
  updatedRiskItemIds: {
    table: s.nonconformityRiskItem,
    parent: 'nonconformityId',
    value: 'riskItemId',
    role: 'UPDATED',
    max: 50,
  },
  changedDocumentIds: {
    table: s.nonconformityDocument,
    parent: 'nonconformityId',
    value: 'documentId',
    max: 50,
  },
} satisfies Record<string, Link>;

type NewNonconformity = Omit<NewEntity<Nonconformity>, 'number'>;

const ncRecord = linkedRecord<
  Nonconformity,
  NewNonconformity,
  Patch<Nonconformity, 'managementSystemId' | 'number'>
>({
  table: s.nonconformity,
  schema: Nonconformity,
  links: NC_LINKS,
  fromRow: (row) => {
    const out: Record<string, unknown> = { ...row };
    const incident: Record<string, unknown> = {};
    for (const [field, column] of Object.entries(INCIDENT_COLUMNS)) {
      const value = out[column];
      incident[field] = value instanceof Date ? value.toISOString() : value;
      delete out[column];
    }
    return { ...out, incident: row.incidentType === null ? null : incident };
  },
  toRow: (input) => {
    if (!('incident' in input)) return input;
    const { incident, ...out } = input as { incident: Record<string, unknown> | null };
    for (const [field, column] of Object.entries(INCIDENT_COLUMNS)) {
      const value = incident === null ? null : incident[field];
      (out as Record<string, unknown>)[column] =
        field === 'occurredAt' && typeof value === 'string' ? new Date(value) : value;
    }
    return out;
  },
  assemble: ({ investigatorIds, ...row }) => ({
    ...row,
    incident: row.incident === null ? null : { ...(row.incident as object), investigatorIds },
  }),
  lists: (input) => {
    const { relatedRiskItemIds, updatedRiskItemIds, changedDocumentIds, ...fields } = input as {
      relatedRiskItemIds?: string[];
      updatedRiskItemIds?: string[];
      changedDocumentIds?: string[];
      incident?: { investigatorIds: string[] } | null;
    };
    const investigatorIds =
      fields.incident === undefined ? undefined : (fields.incident?.investigatorIds ?? []);
    return {
      fields,
      lists: { investigatorIds, relatedRiskItemIds, updatedRiskItemIds, changedDocumentIds },
    };
  },
});

export const NonconformityFilter = z.strictObject({
  ...pageShape,
  managementSystemIds: z.array(Id).optional(),
  state: z.array(NcState).optional(),
  source: z.array(NcSource).optional(),
  severity: z.array(NcSeverity).optional(),
  ownerId: Id.optional(),
  approverId: Id.optional(),
  unitIds: z.array(Id).optional(),
  /** On `reportedOn`, inclusive. */
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  /** Case-insensitive substring of the description. */
  q: z.string().trim().min(1).max(200).optional(),
  includeArchived: z.boolean().optional(),
  scope: UnitScope.optional(),
});
export type NonconformityFilter = z.input<typeof NonconformityFilter>;

export const nonconformities = {
  get: ncRecord.get,
  require: ncRecord.require,
  /** One by its per-client number. */
  async byNumber(tx: TenantTx, clientId: string, number: number): Promise<Nonconformity | null> {
    const n = s.nonconformity;
    const rows = await ncRecord.all(tx, and(eq(n.clientId, clientId), eq(n.number, number)));
    return rows[0] ?? null;
  },
  /**
   * A client's nonconformities by number. Unit scope: their unit, or (none) the system's; or their owner, approver
   * or an investigator.
   */
  async list(
    tx: TenantTx,
    clientId: string,
    filter: NonconformityFilter = {},
  ): Promise<IsoPage<Nonconformity>> {
    const f = validate(NonconformityFilter, filter);
    const n = s.nonconformity;
    const text = f.q?.trim();
    const page = await keysetPage(tx, {
      table: n,
      id: n.id,
      sort: n.number,
      page: f,
      parse: ncRecord.parseRow,
      where: [
        eq(n.clientId, clientId),
        f.includeArchived ? undefined : isNull(n.archivedAt),
        anyOf(n.managementSystemId, f.managementSystemIds),
        oneOf(n.state, f.state),
        oneOf(n.source, f.source),
        oneOf(n.severity, f.severity),
        f.ownerId ? eq(n.ownerId, f.ownerId) : undefined,
        f.approverId ? eq(n.approverId, f.approverId) : undefined,
        anyOf(n.unitId, f.unitIds),
        onOrAfter(n.reportedOn, f.from),
        onOrBefore(n.reportedOn, f.to),
        text ? ilike(n.description, containsPattern(text)) : undefined,
        f.scope && nonconformityScope(f.scope),
      ],
    });
    return pageOf(await ncRecord.complete(tx, page.items), page.nextCursor, page.total);
  },
  /**
   * The database numbers it: the next number of its client, from 1 (a trigger, migration 0041). Investigators, risk
   * items and changed documents are join rows; a patch's list replaces the live ones, and `incident: null` clears the
   * incident and its investigators.
   */
  create: ncRecord.create,
  update: ncRecord.update,
  archive: ncRecord.archive,
};

// ---------- actions ----------

/** The `iso_action` subject column of each subject type (model §3.12): exactly one is set on a row. */
const ACTION_SUBJECTS = {
  NONCONFORMITY: 'nonconformityId',
  RISK_ITEM: 'riskItemId',
  OBJECTIVE: 'objectiveId',
  AUDIT_FINDING: 'auditFindingId',
  MANAGEMENT_REVIEW: 'managementReviewId',
} as const satisfies Record<IsoActionSubjectType, keyof typeof s.isoAction.$inferSelect>;

const actionEntity = entity<IsoAction>({
  table: s.isoAction,
  schema: IsoAction,
  fromRow: (row) => {
    const out: Record<string, unknown> = { ...row };
    let subject: IsoActionSubject | null = null;
    for (const [type, field] of Object.entries(ACTION_SUBJECTS)) {
      if (out[field] !== null)
        subject = { type: type as IsoActionSubjectType, id: out[field] as string };
      delete out[field];
    }
    return { ...out, subject };
  },
  toRow: (input) => {
    if (!('subject' in input)) return input;
    const { subject, ...out } = input as { subject: IsoActionSubject };
    return { ...out, [ACTION_SUBJECTS[subject.type]]: subject.id };
  },
});

export const IsoActionFilter = z.strictObject({
  ...pageShape,
  subjectTypes: z.array(IsoActionSubjectType).optional(),
  ownerId: Id.optional(),
  state: z.array(IsoActionState).optional(),
  /** Actions due on or before this date. */
  dueTo: LocalDate.optional(),
  includeArchived: z.boolean().optional(),
  scope: UnitScope.optional(),
});
export type IsoActionFilter = z.input<typeof IsoActionFilter>;

export const isoActions = {
  get: actionEntity.get,
  require: actionEntity.require,
  /** A subject's actions by due date. */
  async forSubject(
    tx: TenantTx,
    subject: IsoActionSubject,
    options: { includeArchived?: boolean } = {},
  ): Promise<IsoAction[]> {
    const { type, id } = validate(IsoActionSubject, subject);
    const a = s.isoAction;
    const rows = await tx
      .select()
      .from(a)
      .where(
        and(
          eq(a[ACTION_SUBJECTS[type]], id),
          options.includeArchived ? undefined : isNull(a.archivedAt),
        ),
      )
      .orderBy(asc(a.dueOn), asc(a.id))
      .catch(rethrow);
    return rows.map((row) => actionEntity.parse(row));
  },
  /** A client's actions by due date. Unit scope: their subject's, or their owner. */
  async list(
    tx: TenantTx,
    clientId: string,
    filter: IsoActionFilter = {},
  ): Promise<IsoPage<IsoAction>> {
    const f = validate(IsoActionFilter, filter);
    const a = s.isoAction;
    const { items, nextCursor, total } = await keysetPage(tx, {
      table: a,
      id: a.id,
      sort: a.dueOn,
      page: f,
      parse: actionEntity.parse,
      where: [
        eq(a.clientId, clientId),
        f.includeArchived ? undefined : isNull(a.archivedAt),
        f.subjectTypes &&
          (f.subjectTypes.length
            ? or(...f.subjectTypes.map((type) => isNotNull(a[ACTION_SUBJECTS[type]])))
            : sql`false`),
        f.ownerId ? eq(a.ownerId, f.ownerId) : undefined,
        oneOf(a.state, f.state),
        onOrBefore(a.dueOn, f.dueTo),
        f.scope && actionScope(f.scope),
      ],
    });
    return pageOf(items, nextCursor, total);
  },
  /** The subject must be in the same client (composite key: NOT_FOUND otherwise). */
  create: (tx: TenantTx, input: NewEntity<IsoAction>) => actionEntity.create(tx, input),
  update: (tx: TenantTx, id: string, version: number, patch: Patch<IsoAction, 'subject'>) =>
    actionEntity.update(tx, id, version, patch),
  archive: actionEntity.archive,
};

// ---------- management reviews ----------

const reviewRecord = linkedRecord<
  ManagementReview,
  NewEntity<ManagementReview>,
  Patch<ManagementReview, 'managementSystemId'>
>({
  table: s.managementReview,
  schema: ManagementReview,
  links: {
    attendeeIds: {
      table: s.managementReviewPerson,
      parent: 'managementReviewId',
      value: 'personId',
      max: 100,
    },
  },
});
const inputEntity = entity<ReviewInput>({ table: s.reviewInput, schema: ReviewInput });
const outputEntity = entity<ReviewOutput>({ table: s.reviewOutput, schema: ReviewOutput });

export const ManagementReviewFilter = z.strictObject({
  ...pageShape,
  managementSystemIds: z.array(Id).optional(),
  state: z.array(ManagementReviewState).optional(),
  /** On `plannedOn`, inclusive. */
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  includeArchived: z.boolean().optional(),
  scope: UnitScope.optional(),
});
export type ManagementReviewFilter = z.input<typeof ManagementReviewFilter>;

export const managementReviews = {
  get: reviewRecord.get,
  require: reviewRecord.require,
  /** A client's reviews by planned date. Unit scope: the system's units, or their chair or an attendee. */
  async list(
    tx: TenantTx,
    clientId: string,
    filter: ManagementReviewFilter = {},
  ): Promise<IsoPage<ManagementReview>> {
    const f = validate(ManagementReviewFilter, filter);
    const m = s.managementReview;
    const page = await keysetPage(tx, {
      table: m,
      id: m.id,
      sort: m.plannedOn,
      page: f,
      parse: reviewRecord.parseRow,
      where: [
        eq(m.clientId, clientId),
        f.includeArchived ? undefined : isNull(m.archivedAt),
        anyOf(m.managementSystemId, f.managementSystemIds),
        oneOf(m.state, f.state),
        onOrAfter(m.plannedOn, f.from),
        onOrBefore(m.plannedOn, f.to),
        f.scope && reviewScope(f.scope),
      ],
    });
    return pageOf(await reviewRecord.complete(tx, page.items), page.nextCursor, page.total);
  },
  /** `attendeeIds` are join rows; a patch's list replaces the live ones. */
  create: reviewRecord.create,
  update: reviewRecord.update,
  archive: reviewRecord.archive,
};

/**
 * Adds a review's input or output rows: one per key of these standards' definitions that the review has no row
 * for yet, a key shared by several standards once (the definition of the lowest standard code). Returns the ids.
 * The keys hold among live rows only (migration 0043), so the arbiter names the same predicate.
 */
async function addReviewRows(
  tx: TenantTx,
  kind: 'input' | 'output',
  review: { id: string; clientId: string },
  standardIds: readonly string[],
): Promise<string[]> {
  const ids = validate(z.array(Id).min(1).max(3), [...standardIds]);
  const table = sql.identifier(`review_${kind}`);
  const defs = sql.identifier(`iso_review_${kind}_def`);
  const def = sql.identifier(`${kind}_def_id`);
  const { rows } = await tx
    .execute(
      sql`INSERT INTO ${table} (client_id, management_review_id, ${def})
        SELECT DISTINCT ON (d.key) ${review.clientId}::uuid, ${review.id}::uuid, d.id
        FROM ${defs} d JOIN iso_standard st ON st.id = d.standard_id
        WHERE d.standard_id = any(${uuids(ids)}) AND d.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM ${table} x JOIN ${defs} d2 ON d2.id = x.${def}
            WHERE x.management_review_id = ${review.id}::uuid AND x.archived_at IS NULL AND d2.key = d.key)
        ORDER BY d.key, st.code, d.id
        ON CONFLICT (management_review_id, ${def}) WHERE archived_at IS NULL DO NOTHING
        RETURNING id`,
    )
    .catch(rethrow);
  return (rows as { id: string }[]).map((r) => r.id);
}

export const reviewInputs = {
  get: inputEntity.get,
  require: inputEntity.require,
  forReview: (tx: TenantTx, managementReviewId: string): Promise<ReviewInput[]> =>
    inputEntity.findAll(tx, { managementReviewId }).then(byId),
  /** The rows of a new review, or of standards added to it (model §3.13). Returns the rows added. */
  async addForReview(
    tx: TenantTx,
    review: { id: string; clientId: string },
    standardIds: readonly string[],
  ): Promise<ReviewInput[]> {
    const added = await addReviewRows(tx, 'input', review, standardIds);
    return added.length ? byId(await inputEntity.all(tx, inArray(s.reviewInput.id, added))) : [];
  },
  update: (tx: TenantTx, id: string, version: number, patch: { notes: string | null }) =>
    inputEntity.update(tx, id, version, patch),
};

export const reviewOutputs = {
  get: outputEntity.get,
  require: outputEntity.require,
  forReview: (tx: TenantTx, managementReviewId: string): Promise<ReviewOutput[]> =>
    outputEntity.findAll(tx, { managementReviewId }).then(byId),
  async addForReview(
    tx: TenantTx,
    review: { id: string; clientId: string },
    standardIds: readonly string[],
  ): Promise<ReviewOutput[]> {
    const added = await addReviewRows(tx, 'output', review, standardIds);
    return added.length ? byId(await outputEntity.all(tx, inArray(s.reviewOutput.id, added))) : [];
  },
  update: (tx: TenantTx, id: string, version: number, patch: { decision: string | null }) =>
    outputEntity.update(tx, id, version, patch),
};
