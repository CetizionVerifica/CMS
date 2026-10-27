import {
  Certification,
  ClauseAssessment,
  ClauseNaState,
  ClauseStatus,
  ContextItem,
  ContextItemKind,
  ControlledDocument,
  DocumentRevision,
  DocumentStatus,
  DocumentType,
  ExternalAudit,
  ExternalAuditState,
  ExternalAuditType,
  Id,
  ISO_FILE_SUBJECT_COLUMNS,
  IsoClause,
  IsoFile,
  IsoFileSubject,
  IsoFileView,
  IsoReviewInputDef,
  IsoReviewOutputDef,
  IsoStandard,
  LocalDate,
  ManagementSystem,
  ManagementSystemStatus,
  ScanStatus,
  type IsoFileSubjectType,
} from '@canopy/contracts';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { TenantTx } from '../database.js';
import { DbError, rethrow, validate } from '../errors.js';
import * as s from '../schema/index.js';
import { instantsToDates } from './convert.js';
import { containsPattern, entity, pageLimit, type NewEntity } from './crud.js';
import {
  anyOf,
  CERTIFICATION_UNITS,
  inScope,
  keysetPage,
  linksOf,
  pageShape,
  RecordIds,
  setLinks,
  SYSTEM_UNITS,
  systemUnitsMatch,
  uuids,
  UnitScope,
  type IsoPage,
  type Patch,
} from './iso-shared.js';

export { UnitScope, type IsoPage } from './iso-shared.js';

/**
 * The ISO add-on's records, part 1 (docs/iso/model.md §2-3.4, §3.8, §6; ISO-2d; part 2 is iso-records.ts). The catalogue is the account's own
 * copy: every context reads it, only a system job writes it (RLS refuses any other). Client records are read and
 * written by M16 under the request's tenant context; list filters apply the unit scope of docs/iso/plan.md §3.3 in SQL
 * when the caller passes one. No repository here checks a role, a feature switch or a state machine: M16 does.
 */

// ---------- catalogue ----------

/** Catalogue rows may carry their id, so the copy can write a clause tree in one statement. */
type NewCatalogueRow<T> = Omit<T, 'firmId' | 'createdAt' | 'updatedAt' | 'archivedAt' | 'id'> & {
  id?: string;
};

const standardEntity = entity<IsoStandard, NewCatalogueRow<IsoStandard>>({
  table: s.isoStandard,
  schema: IsoStandard,
});
const clauseEntity = entity<IsoClause, NewCatalogueRow<IsoClause>>({
  table: s.isoClause,
  schema: IsoClause,
});
const inputDefEntity = entity<IsoReviewInputDef, NewCatalogueRow<IsoReviewInputDef>>({
  table: s.isoReviewInputDef,
  schema: IsoReviewInputDef,
});
const outputDefEntity = entity<IsoReviewOutputDef, NewCatalogueRow<IsoReviewOutputDef>>({
  table: s.isoReviewOutputDef,
  schema: IsoReviewOutputDef,
});

/** Clause numbers in reading order: 4.1 before 4.10, 9 before 10. */
const clauseOrder = sql`string_to_array(${s.isoClause.number}, '.')::int[]`;

export const IsoClauseFilter = z.strictObject({
  standardIds: z.array(Id).optional(),
  assessable: z.boolean().optional(),
});
export type IsoClauseFilter = z.input<typeof IsoClauseFilter>;

export const isoCatalogue = {
  /** The account's standards, live ones, by code then edition. */
  async standards(tx: TenantTx): Promise<IsoStandard[]> {
    const rows = await tx
      .select()
      .from(s.isoStandard)
      .where(isNull(s.isoStandard.archivedAt))
      .orderBy(asc(s.isoStandard.code), asc(s.isoStandard.edition))
      .catch(rethrow);
    return rows.map((r) => standardEntity.parse(r));
  },
  standard: standardEntity.get,
  /** Live clauses by standard (code, edition) and clause number. */
  async clauses(tx: TenantTx, filter: IsoClauseFilter = {}): Promise<IsoClause[]> {
    const f = validate(IsoClauseFilter, filter);
    const c = s.isoClause;
    const rows = await tx
      .select({ clause: c })
      .from(c)
      .innerJoin(s.isoStandard, eq(s.isoStandard.id, c.standardId))
      .where(
        and(
          isNull(c.archivedAt),
          anyOf(c.standardId, f.standardIds),
          f.assessable === undefined ? undefined : eq(c.assessable, f.assessable),
        ),
      )
      .orderBy(asc(s.isoStandard.code), asc(s.isoStandard.edition), clauseOrder)
      .catch(rethrow);
    return rows.map((r) => clauseEntity.parse(r.clause));
  },
  clause: clauseEntity.get,
  /** The review input and output definitions of these standards (all when left out), by standard and clause. */
  async reviewDefs(
    tx: TenantTx,
    filter: { standardIds?: readonly string[] } = {},
  ): Promise<{ inputs: IsoReviewInputDef[]; outputs: IsoReviewOutputDef[] }> {
    const ids = filter.standardIds && validate(z.array(Id), filter.standardIds);
    const read = async <T>(
      table: typeof s.isoReviewInputDef | typeof s.isoReviewOutputDef,
      parse: (row: Record<string, unknown>) => T,
    ): Promise<T[]> => {
      const rows = await tx
        .select()
        .from(table)
        .where(and(isNull(table.archivedAt), anyOf(table.standardId, ids)))
        .orderBy(
          asc(table.standardId),
          sql`string_to_array(${table.clauseNumber}, '.')::int[]`,
          asc(table.item),
          asc(table.id),
        )
        .catch(rethrow);
      return (rows as Record<string, unknown>[]).map(parse);
    };
    return {
      inputs: await read(s.isoReviewInputDef, inputDefEntity.parse),
      outputs: await read(s.isoReviewOutputDef, outputDefEntity.parse),
    };
  },
  // Writes: the catalogue copy only (ISO-9). RLS answers FORBIDDEN in any context but a system job.
  createStandard: standardEntity.create,
  createClauses: clauseEntity.createMany,
  createReviewInputDefs: inputDefEntity.createMany,
  createReviewOutputDefs: outputDefEntity.createMany,
};

// ---------- management systems ----------

const systemEntity = entity<ManagementSystem>({
  table: s.managementSystem,
  schema: ManagementSystem,
  fromRow: (row) => ({ unitIds: [], ...row }),
});

async function withSystemUnits(tx: TenantTx, systems: ManagementSystem[]) {
  const units = await linksOf(
    tx,
    SYSTEM_UNITS,
    systems.map((m) => m.id),
  );
  return systems.map((m) => ({ ...m, unitIds: units.get(m.id) ?? [] }));
}

export const ManagementSystemFilter = z.strictObject({
  ...pageShape,
  status: z.array(ManagementSystemStatus).optional(),
  /** Case-insensitive substring of the name. */
  q: z.string().trim().min(1).max(200).optional(),
  includeArchived: z.boolean().optional(),
  scope: UnitScope.optional(),
});
export type ManagementSystemFilter = z.input<typeof ManagementSystemFilter>;

export const managementSystems = {
  async get(tx: TenantTx, id: string): Promise<ManagementSystem | null> {
    const row = await systemEntity.get(tx, id);
    return row ? (await withSystemUnits(tx, [row]))[0]! : null;
  },
  async require(tx: TenantTx, id: string): Promise<ManagementSystem> {
    return (await withSystemUnits(tx, [await systemEntity.require(tx, id)]))[0]!;
  },
  /** A client's systems by name. */
  async list(
    tx: TenantTx,
    clientId: string,
    filter: ManagementSystemFilter = {},
  ): Promise<IsoPage<ManagementSystem>> {
    const f = validate(ManagementSystemFilter, filter);
    const m = s.managementSystem;
    const text = f.q?.trim();
    const page = await keysetPage(tx, {
      table: m,
      id: m.id,
      sort: m.name,
      page: f,
      parse: systemEntity.parse,
      where: [
        eq(m.clientId, clientId),
        f.includeArchived ? undefined : isNull(m.archivedAt),
        f.status && (f.status.length ? inArray(m.status, f.status) : sql`false`),
        text ? ilike(m.name, containsPattern(text)) : undefined,
        f.scope && inScope(f.scope, systemUnitsMatch(m.id, f.scope.unitIds)),
      ],
    });
    return {
      items: await withSystemUnits(tx, page.items),
      nextCursor: page.nextCursor,
      ...(page.total !== undefined && { total: page.total }),
    };
  },
  /** The system and its unit rows. Its checklist rows are `clauseAssessments.addForStandards`. */
  async create(tx: TenantTx, input: NewEntity<ManagementSystem>): Promise<ManagementSystem> {
    const { unitIds, ...row } = input;
    const created = await systemEntity.create(tx, { ...row, unitIds: [] });
    await setLinks(tx, SYSTEM_UNITS, { id: created.id, clientId: created.clientId }, unitIds);
    return managementSystems.require(tx, created.id);
  },
  /**
   * Optimistic update; `unitIds` replaces the live unit rows. `standardIds` may only grow and a climate decision never
   * returns to undecided: a trigger (migration 0040) refuses either as VALIDATION.
   */
  async update(
    tx: TenantTx,
    id: string,
    version: number,
    patch: Patch<ManagementSystem>,
  ): Promise<ManagementSystem> {
    const { unitIds, ...fields } = patch;
    const updated = await systemEntity.update(tx, id, version, fields);
    if (unitIds !== undefined) {
      await setLinks(tx, SYSTEM_UNITS, { id: id, clientId: updated.clientId }, unitIds);
    }
    return managementSystems.require(tx, id);
  },
  async archive(tx: TenantTx, id: string, version: number): Promise<ManagementSystem> {
    return (await withSystemUnits(tx, [await systemEntity.archive(tx, id, version)]))[0]!;
  },
};

// ---------- context ----------

export const contextEntity = entity<ContextItem>({ table: s.contextItem, schema: ContextItem });

export const ContextItemFilter = z.strictObject({
  kind: z.array(ContextItemKind).optional(),
  climateRelated: z.boolean().optional(),
  includeArchived: z.boolean().optional(),
  scope: UnitScope.optional(),
});
export type ContextItemFilter = z.input<typeof ContextItemFilter>;

export const contextItems = {
  get: contextEntity.get,
  require: contextEntity.require,
  /** A system's issues and interested parties, oldest first. */
  async list(
    tx: TenantTx,
    managementSystemId: string,
    filter: ContextItemFilter = {},
  ): Promise<ContextItem[]> {
    const f = validate(ContextItemFilter, filter);
    const c = s.contextItem;
    const rows = await tx
      .select()
      .from(c)
      .where(
        and(
          eq(c.managementSystemId, managementSystemId),
          f.includeArchived ? undefined : isNull(c.archivedAt),
          f.kind && (f.kind.length ? inArray(c.kind, f.kind) : sql`false`),
          f.climateRelated === undefined ? undefined : eq(c.climateRelated, f.climateRelated),
          f.scope && inScope(f.scope, systemUnitsMatch(c.managementSystemId, f.scope.unitIds)),
        ),
      )
      .orderBy(asc(c.id))
      .catch(rethrow);
    return rows.map((r) => contextEntity.parse(r));
  },
  create: (tx: TenantTx, input: NewEntity<ContextItem>) => contextEntity.create(tx, input),
  update: (
    tx: TenantTx,
    id: string,
    version: number,
    patch: Patch<ContextItem, 'managementSystemId' | 'kind'>,
  ) => contextEntity.update(tx, id, version, patch),
  archive: contextEntity.archive,
};

// ---------- clause checklist ----------

const assessmentEntity = entity<ClauseAssessment>({
  table: s.clauseAssessment,
  schema: ClauseAssessment,
  toRow: instantsToDates('naDecidedAt'),
});

/** A checklist row with what M16 needs to sort and show it (`ClauseAssessmentView` adds `allowedActions`). */
export type ClauseAssessmentRow = ClauseAssessment & {
  standardId: string;
  clauseNumber: string;
  clauseTitle: string;
  exclusionAllowed: boolean;
};

export const ChecklistFilter = z.strictObject({
  standardIds: z.array(Id).optional(),
  status: z.array(ClauseStatus).optional(),
  naState: z.array(ClauseNaState).optional(),
  ownerId: Id.optional(),
  scope: UnitScope.optional(),
});
export type ChecklistFilter = z.input<typeof ChecklistFilter>;

export const clauseAssessments = {
  get: assessmentEntity.get,
  require: assessmentEntity.require,
  /** A system's checklist by standard (code, edition) and clause number. */
  async list(
    tx: TenantTx,
    managementSystemId: string,
    filter: ChecklistFilter = {},
  ): Promise<ClauseAssessmentRow[]> {
    const f = validate(ChecklistFilter, filter);
    const a = s.clauseAssessment;
    const c = s.isoClause;
    const rows = await tx
      .select({
        row: a,
        standardId: c.standardId,
        clauseNumber: c.number,
        clauseTitle: c.title,
        exclusionAllowed: c.exclusionAllowed,
      })
      .from(a)
      .innerJoin(c, eq(c.id, a.clauseId))
      .innerJoin(s.isoStandard, eq(s.isoStandard.id, c.standardId))
      .where(
        and(
          eq(a.managementSystemId, managementSystemId),
          isNull(a.archivedAt),
          anyOf(c.standardId, f.standardIds),
          f.status && (f.status.length ? inArray(a.status, f.status) : sql`false`),
          f.naState && (f.naState.length ? inArray(a.naState, f.naState) : sql`false`),
          f.ownerId ? eq(a.ownerId, f.ownerId) : undefined,
          f.scope &&
            inScope(f.scope, systemUnitsMatch(a.managementSystemId, f.scope.unitIds), [a.ownerId]),
        ),
      )
      .orderBy(asc(s.isoStandard.code), asc(s.isoStandard.edition), clauseOrder)
      .catch(rethrow);
    return rows.map(({ row, ...clause }) => ({ ...assessmentEntity.parse(row), ...clause }));
  },
  /**
   * Adds a NOT_STARTED row for every live assessable clause of these standards that the system has no row for yet:
   * the rows of a new system, or of a standard added to it (model §3.3). Returns the rows added.
   */
  async addForStandards(
    tx: TenantTx,
    system: { id: string; clientId: string },
    standardIds: readonly string[],
  ): Promise<ClauseAssessment[]> {
    const ids = validate(z.array(Id).min(1).max(3), [...standardIds]);
    const { rows } = await tx
      .execute(
        sql`INSERT INTO clause_assessment (client_id, management_system_id, clause_id)
          SELECT ${system.clientId}::uuid, ${system.id}::uuid, c.id FROM iso_clause c
          WHERE c.standard_id = any(${uuids(ids)}) AND c.assessable AND c.archived_at IS NULL
          ON CONFLICT (management_system_id, clause_id) DO NOTHING
          RETURNING id`,
      )
      .catch(rethrow);
    const added = (rows as { id: string }[]).map((r) => r.id);
    return added.length ? assessmentEntity.all(tx, inArray(s.clauseAssessment.id, added)) : [];
  },
  update: (
    tx: TenantTx,
    id: string,
    version: number,
    patch: Patch<ClauseAssessment, 'managementSystemId' | 'clauseId'>,
  ) => assessmentEntity.update(tx, id, version, patch),
};

// ---------- documents ----------

const documentEntity = entity<ControlledDocument>({
  table: s.controlledDocument,
  schema: ControlledDocument,
});
const revisionEntity = entity<DocumentRevision>({
  table: s.documentRevision,
  schema: DocumentRevision,
  toRow: instantsToDates('approvedAt'),
});

export const DocumentFilter = z.strictObject({
  ...pageShape,
  /** Only these documents (ISO-2i): AND'd with the other filters and the scope; drops the ACTIVE-only default. */
  ids: RecordIds.optional(),
  managementSystemIds: z.array(Id).optional(),
  /** Case-insensitive substring of the code, title, issuer or external reference. */
  q: z.string().trim().min(1).max(200).optional(),
  type: z.array(DocumentType).optional(),
  /** Default: ACTIVE only (model §4.2), unless `ids` is given (a document in its first review is not ACTIVE). */
  status: z.array(DocumentStatus).optional(),
  ownerId: Id.optional(),
  approverId: Id.optional(),
  /** Documents serving any of these clauses. */
  clauseIds: z.array(Id).optional(),
  includeArchived: z.boolean().optional(),
  scope: UnitScope.optional(),
});
export type DocumentFilter = z.input<typeof DocumentFilter>;

export const controlledDocuments = {
  get: documentEntity.get,
  require: documentEntity.require,
  /**
   * A client's documents by code. Unit scope takes the system's units, or the document's owner or approver. The
   * current revision of a system document stays readable by every member of the client (model §4.2): M16 reads it by
   * id, outside this list's scope.
   */
  async list(
    tx: TenantTx,
    clientId: string,
    filter: DocumentFilter = {},
  ): Promise<IsoPage<ControlledDocument>> {
    const f = validate(DocumentFilter, filter);
    const d = s.controlledDocument;
    const text = f.q?.trim();
    const status = f.status ?? (f.ids ? undefined : ['ACTIVE']);
    const { items, nextCursor, total } = await keysetPage(tx, {
      table: d,
      id: d.id,
      sort: d.code,
      page: f,
      parse: documentEntity.parse,
      where: [
        eq(d.clientId, clientId),
        f.includeArchived ? undefined : isNull(d.archivedAt),
        anyOf(d.managementSystemId, f.managementSystemIds),
        anyOf(d.id, f.ids),
        status && (status.length ? inArray(d.status, status) : sql`false`),
        f.type && (f.type.length ? inArray(d.type, f.type) : sql`false`),
        f.ownerId ? eq(d.ownerId, f.ownerId) : undefined,
        f.approverId ? eq(d.approverId, f.approverId) : undefined,
        f.clauseIds && sql`${d.clauseIds} && ${uuids(f.clauseIds)}`,
        text
          ? or(
              ilike(d.code, containsPattern(text)),
              ilike(d.title, containsPattern(text)),
              ilike(d.issuer, containsPattern(text)),
              ilike(d.externalRef, containsPattern(text)),
            )
          : undefined,
        f.scope &&
          inScope(f.scope, systemUnitsMatch(d.managementSystemId, f.scope.unitIds), [
            d.ownerId,
            d.approverId,
          ]),
      ],
    });
    return { items, nextCursor, ...(total !== undefined && { total }) };
  },
  /** New documents have no revision yet (`currentRevisionId` null). */
  create: (tx: TenantTx, input: NewEntity<ControlledDocument>) => documentEntity.create(tx, input),
  /**
   * `currentRevisionId` must name an APPROVED revision of this document (a trigger refuses anything else as
   * VALIDATION), so APPROVE moves the revision first, then the document.
   */
  update: (
    tx: TenantTx,
    id: string,
    version: number,
    patch: Patch<ControlledDocument, 'managementSystemId'>,
  ) => documentEntity.update(tx, id, version, patch),
  archive: documentEntity.archive,
};

export const documentRevisions = {
  get: revisionEntity.get,
  require: revisionEntity.require,
  /** A document's revisions, newest first, superseded ones included. */
  async forDocument(tx: TenantTx, documentId: string): Promise<DocumentRevision[]> {
    const r = s.documentRevision;
    const rows = await tx
      .select()
      .from(r)
      .where(and(eq(r.documentId, documentId), isNull(r.archivedAt)))
      .orderBy(desc(r.id))
      .catch(rethrow);
    return rows.map((row) => revisionEntity.parse(row));
  },
  /** DUPLICATE when the document already has a revision in DRAFT or IN_REVIEW (model §4.2). */
  create: (tx: TenantTx, input: NewEntity<DocumentRevision>) => revisionEntity.create(tx, input),
  update: (
    tx: TenantTx,
    id: string,
    version: number,
    patch: Patch<DocumentRevision, 'documentId'>,
  ) => revisionEntity.update(tx, id, version, patch),
};

// ---------- certification and external audits ----------

const certificationEntity = entity<Certification>({
  table: s.certification,
  schema: Certification,
  fromRow: (row) => ({ unitIds: [], ...row }),
});

async function withCertificationUnits(tx: TenantTx, certificates: Certification[]) {
  const units = await linksOf(
    tx,
    CERTIFICATION_UNITS,
    certificates.map((c) => c.id),
  );
  return certificates.map((c) => ({ ...c, unitIds: units.get(c.id) ?? [] }));
}

export const CertificationFilter = z.strictObject({
  ...pageShape,
  managementSystemIds: z.array(Id).optional(),
  standardIds: z.array(Id).optional(),
  includeArchived: z.boolean().optional(),
  scope: UnitScope.optional(),
});
export type CertificationFilter = z.input<typeof CertificationFilter>;

export const certifications = {
  async get(tx: TenantTx, id: string): Promise<Certification | null> {
    const row = await certificationEntity.get(tx, id);
    return row ? (await withCertificationUnits(tx, [row]))[0]! : null;
  },
  async require(tx: TenantTx, id: string): Promise<Certification> {
    return (await withCertificationUnits(tx, [await certificationEntity.require(tx, id)]))[0]!;
  },
  /** A client's certificates, oldest first. Unit scope: their own units, or (none) the system's. */
  async list(
    tx: TenantTx,
    clientId: string,
    filter: CertificationFilter = {},
  ): Promise<IsoPage<Certification>> {
    const f = validate(CertificationFilter, filter);
    const c = s.certification;
    const own = (units: readonly string[]) =>
      sql`(exists (select 1 from certification_unit u where u.certification_id = ${c.id} and u.archived_at is null and u.unit_id = any(${uuids(units)}))
        or (not exists (select 1 from certification_unit u where u.certification_id = ${c.id} and u.archived_at is null)
          and ${systemUnitsMatch(c.managementSystemId, units)}))`;
    const page = await keysetPage(tx, {
      table: c,
      id: c.id,
      sort: c.id,
      page: f,
      parse: certificationEntity.parse,
      where: [
        eq(c.clientId, clientId),
        f.includeArchived ? undefined : isNull(c.archivedAt),
        anyOf(c.managementSystemId, f.managementSystemIds),
        anyOf(c.standardId, f.standardIds),
        f.scope && inScope(f.scope, own(f.scope.unitIds)),
      ],
    });
    return {
      items: await withCertificationUnits(tx, page.items),
      nextCursor: page.nextCursor,
      ...(page.total !== undefined && { total: page.total }),
    };
  },
  async create(tx: TenantTx, input: NewEntity<Certification>): Promise<Certification> {
    const { unitIds, ...row } = input;
    const created = await certificationEntity.create(tx, { ...row, unitIds: [] });
    await setLinks(
      tx,
      CERTIFICATION_UNITS,
      { id: created.id, clientId: created.clientId },
      unitIds,
    );
    return certifications.require(tx, created.id);
  },
  /** Optimistic update; `unitIds` replaces the live unit rows. */
  async update(
    tx: TenantTx,
    id: string,
    version: number,
    patch: Patch<Certification, 'managementSystemId' | 'standardId'>,
  ): Promise<Certification> {
    const { unitIds, ...fields } = patch;
    const updated = await certificationEntity.update(tx, id, version, fields);
    if (unitIds !== undefined) {
      await setLinks(tx, CERTIFICATION_UNITS, { id: id, clientId: updated.clientId }, unitIds);
    }
    return certifications.require(tx, id);
  },
  async archive(tx: TenantTx, id: string, version: number): Promise<Certification> {
    return (
      await withCertificationUnits(tx, [await certificationEntity.archive(tx, id, version)])
    )[0]!;
  },
};

export const externalAuditEntity = entity<ExternalAudit>({
  table: s.externalAudit,
  schema: ExternalAudit,
});

export const ExternalAuditFilter = z.strictObject({
  ...pageShape,
  managementSystemIds: z.array(Id).optional(),
  state: z.array(ExternalAuditState).optional(),
  type: z.array(ExternalAuditType).optional(),
  /** On `startOn`, inclusive. */
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  includeArchived: z.boolean().optional(),
  scope: UnitScope.optional(),
});
export type ExternalAuditFilter = z.input<typeof ExternalAuditFilter>;

export const externalAudits = {
  get: externalAuditEntity.get,
  require: externalAuditEntity.require,
  /** A client's external audits by start date. Unit scope takes the system's units. */
  async list(
    tx: TenantTx,
    clientId: string,
    filter: ExternalAuditFilter = {},
  ): Promise<IsoPage<ExternalAudit>> {
    const f = validate(ExternalAuditFilter, filter);
    const a = s.externalAudit;
    const { items, nextCursor, total } = await keysetPage(tx, {
      table: a,
      id: a.id,
      sort: a.startOn,
      page: f,
      parse: externalAuditEntity.parse,
      where: [
        eq(a.clientId, clientId),
        f.includeArchived ? undefined : isNull(a.archivedAt),
        anyOf(a.managementSystemId, f.managementSystemIds),
        f.state && (f.state.length ? inArray(a.state, f.state) : sql`false`),
        f.type && (f.type.length ? inArray(a.type, f.type) : sql`false`),
        f.from ? sql`${a.startOn} >= ${f.from}` : undefined,
        f.to ? sql`${a.startOn} <= ${f.to}` : undefined,
        f.scope && inScope(f.scope, systemUnitsMatch(a.managementSystemId, f.scope.unitIds)),
      ],
    });
    return { items, nextCursor, ...(total !== undefined && { total }) };
  },
  create: (tx: TenantTx, input: NewEntity<ExternalAudit>) => externalAuditEntity.create(tx, input),
  update: (
    tx: TenantTx,
    id: string,
    version: number,
    patch: Patch<ExternalAudit, 'managementSystemId'>,
  ) => externalAuditEntity.update(tx, id, version, patch),
  archive: externalAuditEntity.archive,
};

// ---------- files ----------

/** The subject column of each subject type (model §6): exactly one is set on a row. */
const FILE_SUBJECTS = {
  clause_assessment: s.isoFile.clauseAssessmentId,
  document_revision: s.isoFile.documentRevisionId,
  risk_item: s.isoFile.riskItemId,
  objective_reading: s.isoFile.objectiveReadingId,
  internal_audit: s.isoFile.internalAuditId,
  audit_finding: s.isoFile.auditFindingId,
  external_audit: s.isoFile.externalAuditId,
  certification: s.isoFile.certificationId,
  nonconformity: s.isoFile.nonconformityId,
  iso_action: s.isoFile.isoActionId,
  management_review: s.isoFile.managementReviewId,
} as const satisfies Record<IsoFileSubjectType, PgColumn>;

function subjectColumn(type: IsoFileSubjectType): { field: string; column: PgColumn } {
  return { field: ISO_FILE_SUBJECT_COLUMNS[type], column: FILE_SUBJECTS[type] };
}

const fileEntity = entity<IsoFile>({ table: s.isoFile, schema: IsoFile });

/** The file's subject, from whichever subject column is set. */
export function isoFileSubject(file: IsoFile): IsoFileSubject {
  for (const [type, field] of Object.entries(ISO_FILE_SUBJECT_COLUMNS)) {
    const id = file[field];
    if (id !== null) return { type: type as IsoFileSubjectType, id };
  }
  throw new DbError('VALIDATION', 'An ISO file has no subject');
}

/** What clients see: no storage key, the subject as `{ type, id }`. */
export function isoFileView(file: IsoFile): IsoFileView {
  const view: Record<string, unknown> = { ...file, subject: isoFileSubject(file) };
  delete view.storageKey;
  for (const field of Object.values(ISO_FILE_SUBJECT_COLUMNS)) delete view[field];
  return IsoFileView.parse(view);
}

export const NewIsoFile = z.strictObject({
  clientId: Id,
  subject: IsoFileSubject,
  fileName: IsoFile.shape.fileName,
  mimeType: IsoFile.shape.mimeType,
  sizeBytes: IsoFile.shape.sizeBytes,
  sha256: IsoFile.shape.sha256,
  storageKey: IsoFile.shape.storageKey,
  uploadedById: Id,
});
export type NewIsoFile = z.input<typeof NewIsoFile>;

export const isoFiles = {
  /**
   * A confirmed upload, PENDING until the scan. The subject must be in the same client (composite key: NOT_FOUND
   * otherwise) and the key inside `evidence/<firmId>/<clientId>/iso/` (VALIDATION otherwise).
   */
  async create(tx: TenantTx, input: NewIsoFile): Promise<IsoFile> {
    const { subject, ...file } = validate(NewIsoFile, input);
    const { field } = subjectColumn(subject.type);
    const [row] = (await tx
      .insert(s.isoFile)
      .values({ ...file, [field]: subject.id } as never)
      .returning()
      .catch(rethrow)) as Record<string, unknown>[];
    return fileEntity.parseWritten(row!);
  },
  /** Includes `storageKey`: for the API's signed-URL step only, never returned to clients. */
  get: fileEntity.get,
  require: fileEntity.require,
  /** A subject's files, oldest first; removed ones only when asked. */
  async forSubject(
    tx: TenantTx,
    subject: IsoFileSubject,
    options: { includeRemoved?: boolean } = {},
  ): Promise<IsoFileView[]> {
    const { column } = subjectColumn(validate(IsoFileSubject, subject).type);
    const rows = await fileEntity.all(
      tx,
      and(
        eq(column, subject.id),
        options.includeRemoved ? undefined : isNull(s.isoFile.archivedAt),
      ),
    );
    return rows.sort((a, b) => a.id.localeCompare(b.id)).map(isoFileView);
  },
  /**
   * The scan job's queue (M9): live PENDING files of every client this context sees, oldest first. Reads `iso_file`
   * alone, never instances, so it runs with the add-on on or off (plan §4.5).
   */
  async pendingScan(tx: TenantTx, limit: number): Promise<IsoFile[]> {
    const f = s.isoFile;
    const rows = await tx
      .select()
      .from(f)
      .where(and(eq(f.scanStatus, 'PENDING'), isNull(f.archivedAt)))
      .orderBy(asc(f.createdAt), asc(f.id))
      .limit(pageLimit(limit))
      .catch(rethrow);
    return rows.map((r) => fileEntity.parse(r));
  },
  setScanStatus: (tx: TenantTx, id: string, scanStatus: ScanStatus): Promise<IsoFile> =>
    fileEntity.set(tx, id, { scanStatus: validate(ScanStatus, scanStatus) }),
  /**
   * Records a scan result on a live PENDING file only, in the UPDATE's own WHERE, and says whether it wrote (ISO-2j).
   * A remove that commits between the scanner's read and this write, or a second result, is left as it is.
   */
  async settleScan(tx: TenantTx, id: string, scanStatus: ScanStatus): Promise<boolean> {
    const fileId = validate(Id, id);
    const status = validate(ScanStatus.exclude(['PENDING']), scanStatus);
    const f = s.isoFile;
    const rows = await tx
      .update(f)
      .set({ scanStatus: status })
      .where(and(eq(f.id, fileId), isNull(f.archivedAt), eq(f.scanStatus, 'PENDING')))
      .returning({ id: f.id })
      .catch(rethrow);
    return rows.length === 1;
  },
  /** Removes a live file from view with its reason; the row and the object stay (no hard deletes). */
  async archive(tx: TenantTx, id: string, reason: string): Promise<IsoFile> {
    const removeReason = validate(IsoFile.shape.removeReason.unwrap(), reason);
    const [row] = (await tx
      .update(s.isoFile)
      .set({ archivedAt: sql`now()`, removeReason } as never)
      .where(and(eq(s.isoFile.id, id), isNull(s.isoFile.archivedAt)))
      .returning()
      .catch(rethrow)) as Record<string, unknown>[];
    if (!row) throw new DbError('NOT_FOUND', 'Not found');
    return fileEntity.parseWritten(row);
  },
  /**
   * A client's live files for the client archive (model §9): the CLEAN ones, oldest first, with their storage keys,
   * and how many are withheld because their scan is pending or did not pass.
   */
  async cleanForClient(
    tx: TenantTx,
    clientId: string,
  ): Promise<{ clean: IsoFile[]; withheld: number }> {
    const f = s.isoFile;
    const rows = await tx
      .select()
      .from(f)
      .where(and(eq(f.clientId, clientId), isNull(f.archivedAt)))
      .orderBy(asc(f.createdAt), asc(f.id))
      .catch(rethrow);
    const files = rows.map((r) => fileEntity.parse(r));
    const clean = files.filter((file) => file.scanStatus === 'CLEAN');
    return { clean, withheld: files.length - clean.length };
  },
};
