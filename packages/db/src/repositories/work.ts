import {
  Assignment,
  AuditAction,
  AuditEvent,
  Comment,
  ComplianceInstance,
  Criticality,
  Evidence,
  EntityType,
  EvidenceView,
  Id,
  Instant,
  LocalDate,
  ObligationDomain,
  ScanStatus,
  TimelineType,
  WorkflowState,
  type InstanceRow,
  type TemplateRef,
} from '@canopy/contracts';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { TenantTx } from '../database.js';
import { DbError, rethrow, validate } from '../errors.js';
import * as s from '../schema/index.js';
import { instantsToDates } from './convert.js';
import {
  containsPattern,
  decodeCursor,
  encodeCursor,
  entity,
  pageLimit,
  toWire,
  type NewEntity,
  type Page,
  type PageRequest,
} from './crud.js';

/** Work: assignments, instances, evidence, comments, audit (domain-model.md §5). */

/** An instance whose owner or approver changed, with the values before the change. */
export interface ReassignedInstance {
  id: string;
  clientId: string;
  /** Version after the change. */
  version: number;
  before: { ownerId: string; approverId: string };
  after: { ownerId: string; approverId: string };
}

type People = { ownerId: string; approverId: string };

/** Locks the matching instances, then rewrites owner/approver on the ones `next` changes, bumping version. */
async function reassign(
  tx: TenantTx,
  where: SQL | undefined,
  next: (row: People) => People,
): Promise<ReassignedInstance[]> {
  const i = s.complianceInstance;
  const rows = await tx
    .select({ id: i.id, clientId: i.clientId, ownerId: i.ownerId, approverId: i.approverId })
    .from(i)
    .where(where)
    .orderBy(asc(i.id))
    .for('update')
    .catch(rethrow);
  const changed: ReassignedInstance[] = [];
  for (const row of rows) {
    const after = next(row);
    if (after.ownerId === row.ownerId && after.approverId === row.approverId) continue;
    const [updated] = await tx
      .update(i)
      .set({ ...after, version: sql`${i.version} + 1` })
      .where(eq(i.id, row.id))
      .returning({ version: i.version })
      .catch(rethrow);
    // Visible but not updatable: the update policy refused it.
    if (!updated) throw new DbError('FORBIDDEN', 'Not allowed to change this row');
    changed.push({
      id: row.id,
      clientId: row.clientId,
      version: updated.version,
      before: { ownerId: row.ownerId, approverId: row.approverId },
      after,
    });
  }
  return changed;
}

const assignmentEntity = entity<Assignment>({ table: s.assignment, schema: Assignment });
export const assignments = {
  /** Obligations with a non-archived assignment in a client this context can see. */
  async obligationIds(tx: TenantTx): Promise<string[]> {
    const rows = await tx
      .selectDistinct({ id: s.assignment.obligationId })
      .from(s.assignment)
      .where(isNull(s.assignment.archivedAt))
      .orderBy(asc(s.assignment.obligationId))
      .catch(rethrow);
    return rows.map((r) => r.id);
  },
  get: assignmentEntity.get,
  require: assignmentEntity.require,
  query: assignmentEntity.query,
  findAll: assignmentEntity.findAll,
  list: (tx: TenantTx, clientId: string, page?: PageRequest) =>
    assignmentEntity.list(tx, eq(s.assignment.clientId, clientId), page),
  /** The non-archived assignment for (unit, obligation, department), the unique key. */
  async findByKey(
    tx: TenantTx,
    key: { unitId: string; obligationId: string; departmentId: string },
  ): Promise<Assignment | null> {
    const [row] = await assignmentEntity.all(
      tx,
      and(
        eq(s.assignment.unitId, key.unitId),
        eq(s.assignment.obligationId, key.obligationId),
        eq(s.assignment.departmentId, key.departmentId),
        isNull(s.assignment.archivedAt),
      ),
    );
    return row ?? null;
  },
  forObligation: (tx: TenantTx, obligationId: string): Promise<Assignment[]> =>
    assignmentEntity.all(
      tx,
      and(eq(s.assignment.obligationId, obligationId), isNull(s.assignment.archivedAt)),
    ),
  create: assignmentEntity.create,
  update: assignmentEntity.update,
  archive: assignmentEntity.archive,
  restore: assignmentEntity.restore,
};

const instanceEntity = entity<ComplianceInstance>({
  table: s.complianceInstance,
  schema: ComplianceInstance,
  toRow: instantsToDates('submittedAt', 'approvedAt'),
});

/** Register row as stored: InstanceRow without the engine-derived `status` and `overdueDays`. */
export type RegisterRow = Omit<InstanceRow, 'status' | 'overdueDays'>;

/** Register filters the database can apply (api-conventions.md §3). Derived status is engine work. */
export const RegisterFilter = z.strictObject({
  unitId: Id.optional(),
  departmentId: Id.optional(),
  actId: Id.optional(),
  categoryId: Id.optional(),
  ownerId: Id.optional(),
  approverId: Id.optional(),
  criticality: z.array(Criticality).min(1).optional(),
  workflowState: z.array(WorkflowState).min(1).optional(),
  timelineType: TimelineType.optional(),
  domain: z.array(ObligationDomain).min(1).optional(),
  dueFrom: LocalDate.optional(),
  dueTo: LocalDate.optional(),
  completedFrom: LocalDate.optional(),
  completedTo: LocalDate.optional(),
  hasEvidence: z.boolean().optional(),
  /** Case-insensitive match on title, external ref, Act name and comments; at least 2 characters. */
  q: z.string().trim().min(2).max(200).optional(),
  /** Limit to these units (an owner's or approver's scope, or a multi-select). An empty list matches nothing. */
  unitIds: z.array(Id).optional(),
  /** Multi-select filters; an empty list matches nothing. */
  departmentIds: z.array(Id).optional(),
  actIds: z.array(Id).optional(),
  categoryIds: z.array(Id).optional(),
  instanceIds: z.array(Id).max(10_000).optional(),
});
export type RegisterFilter = z.input<typeof RegisterFilter>;

const RegisterCursor = z.strictObject({ dueDate: LocalDate, id: Id });

const owner = alias(s.person, 'owner');
const approver = alias(s.person, 'approver');
const evidenceCount = sql<number>`(SELECT count(*)::int FROM evidence e WHERE e.instance_id = ${s.complianceInstance.id} AND e.archived_at IS NULL)`;
const commentCount = sql<number>`(SELECT count(*)::int FROM comment c WHERE c.instance_id = ${s.complianceInstance.id} AND c.archived_at IS NULL)`;
const lastComment = sql<
  string | null
>`(SELECT c.body FROM comment c WHERE c.instance_id = ${s.complianceInstance.id} AND c.archived_at IS NULL ORDER BY c.created_at DESC, c.id DESC LIMIT 1)`;

function registerConditions(clientId: string, f: z.output<typeof RegisterFilter>): SQL[] {
  const i = s.complianceInstance;
  const c: SQL[] = [eq(i.clientId, clientId), isNull(i.archivedAt)];
  if (f.unitId) c.push(eq(i.unitId, f.unitId));
  if (f.unitIds) c.push(f.unitIds.length ? inArray(i.unitId, f.unitIds) : sql`false`);
  if (f.instanceIds) c.push(f.instanceIds.length ? inArray(i.id, f.instanceIds) : sql`false`);
  if (f.departmentId) c.push(eq(s.assignment.departmentId, f.departmentId));
  for (const [ids, column] of [
    [f.departmentIds, s.assignment.departmentId],
    [f.actIds, s.obligation.actId],
    [f.categoryIds, s.obligation.categoryId],
  ] as const) {
    if (ids) c.push(ids.length ? inArray(column, ids) : sql`false`);
  }
  if (f.actId) c.push(eq(s.obligation.actId, f.actId));
  if (f.categoryId) c.push(eq(s.obligation.categoryId, f.categoryId));
  if (f.ownerId) c.push(eq(i.ownerId, f.ownerId));
  if (f.approverId) c.push(eq(i.approverId, f.approverId));
  if (f.criticality) c.push(inArray(s.obligation.criticality, f.criticality));
  if (f.workflowState) c.push(inArray(i.workflowState, f.workflowState));
  if (f.timelineType) c.push(eq(s.obligation.timelineType, f.timelineType));
  if (f.domain) c.push(inArray(s.obligation.domain, f.domain));
  if (f.dueFrom) c.push(gte(i.dueDate, f.dueFrom));
  if (f.dueTo) c.push(lte(i.dueDate, f.dueTo));
  if (f.completedFrom) c.push(gte(i.completedOn, f.completedFrom));
  if (f.completedTo) c.push(lte(i.completedOn, f.completedTo));
  if (f.hasEvidence !== undefined)
    c.push(f.hasEvidence ? sql`${evidenceCount} > 0` : sql`${evidenceCount} = 0`);
  if (f.q) {
    const pattern = `%${f.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    c.push(
      or(
        sql`${s.obligation.title} ILIKE ${pattern}`,
        sql`${s.obligation.externalRef} ILIKE ${pattern}`,
        sql`${s.act.name} ILIKE ${pattern}`,
        sql`EXISTS (SELECT 1 FROM comment c WHERE c.instance_id = ${i.id} AND c.archived_at IS NULL AND c.body ILIKE ${pattern})`,
      )!,
    );
  }
  return c;
}

const labels = (refs: TemplateRef[]): string[] => refs.map((r) => r.label);

const firstComment = sql<
  string | null
>`(SELECT c.body FROM comment c WHERE c.instance_id = ${s.complianceInstance.id} AND c.archived_at IS NULL ORDER BY c.created_at ASC, c.id ASC LIMIT 1)`;

/**
 * The register's largest page for the server's own whole-client reads (the overview, reports and `?count=true`,
 * which derive every row's status in the engine). API pages stay at `MAX_LIMIT`: the contracts cap `limit` before
 * a request reaches here. Each page plans an 11-table join under row-level security, so at 10,000 instances 200-row
 * pages spent seconds planning (security review F16).
 */
export const REGISTER_READ_LIMIT = 2000;

function registerLimit(limit: number | undefined): number {
  if (limit === undefined) return pageLimit(undefined);
  if (!Number.isInteger(limit) || limit < 1 || limit > REGISTER_READ_LIMIT) {
    throw new DbError('VALIDATION', `limit must be 1-${REGISTER_READ_LIMIT}`);
  }
  return limit;
}

export const instances = {
  /**
   * Export columns the register rows leave out, for these instances (visible ones only, in id order).
   * At most 10,000 ids per call.
   */
  async exportDetails(
    tx: TenantTx,
    instanceIds: readonly string[],
  ): Promise<InstanceExportDetail[]> {
    const ids = validate(z.array(Id).max(10_000), [...instanceIds]);
    if (ids.length === 0) return [];
    const i = s.complianceInstance;
    return tx
      .select({
        instanceId: i.id,
        description: s.obligation.description,
        applicabilityText: s.obligation.applicabilityText,
        naReason: i.naReason,
        firstComment,
      })
      .from(i)
      .innerJoin(s.assignment, eq(s.assignment.id, i.assignmentId))
      .innerJoin(s.obligation, eq(s.obligation.id, s.assignment.obligationId))
      .where(inArray(i.id, ids))
      .orderBy(asc(i.id))
      .catch(rethrow);
  },
  get: instanceEntity.get,
  require: instanceEntity.require,
  list: (tx: TenantTx, assignmentId: string, page?: PageRequest) =>
    instanceEntity.list(tx, eq(s.complianceInstance.assignmentId, assignmentId), page),
  /** All non-archived instances of an assignment, in period order. */
  async forAssignment(tx: TenantTx, assignmentId: string): Promise<ComplianceInstance[]> {
    const rows = await tx
      .select()
      .from(s.complianceInstance)
      .where(
        and(
          eq(s.complianceInstance.assignmentId, assignmentId),
          isNull(s.complianceInstance.archivedAt),
        ),
      )
      .orderBy(asc(s.complianceInstance.periodStart))
      .catch(rethrow);
    return rows.map((r) => instanceEntity.parse(r));
  },
  create: instanceEntity.create,
  /**
   * Inserts generated periods, skipping any (assignment, periodStart) that already exists, so instance
   * generation is idempotent. Returns only the rows inserted now.
   */
  async insertGenerated(
    tx: TenantTx,
    inputs: readonly NewEntity<ComplianceInstance>[],
  ): Promise<ComplianceInstance[]> {
    if (inputs.length === 0) return [];
    const toRow = instantsToDates('submittedAt', 'approvedAt');
    const rows = await tx
      .insert(s.complianceInstance)
      .values(inputs.map((i) => toRow(i as Record<string, unknown>)) as never)
      .onConflictDoNothing({
        target: [s.complianceInstance.assignmentId, s.complianceInstance.periodStart],
      })
      .returning()
      .catch(rethrow);
    return rows.map((r) => instanceEntity.parseWritten(r));
  },
  /** Optimistic update; callers (M7) decide which transitions are allowed and write the audit event. */
  update: instanceEntity.update,
  archive: instanceEntity.archive,
  restore: instanceEntity.restore,

  /**
   * Sets owner and/or approver on the assignment's non-archived OPEN and SENT_BACK instances (M6, after
   * an assignment change). Returns the rows that changed, with the values before; callers write audit.
   */
  reassignOpen(
    tx: TenantTx,
    assignmentId: string,
    to: { ownerId?: string; approverId?: string },
  ): Promise<ReassignedInstance[]> {
    const i = s.complianceInstance;
    return reassign(
      tx,
      and(
        eq(i.assignmentId, assignmentId),
        inArray(i.workflowState, ['OPEN', 'SENT_BACK']),
        isNull(i.archivedAt),
      ),
      (row) => ({
        ownerId: to.ownerId ?? row.ownerId,
        approverId: to.approverId ?? row.approverId,
      }),
    );
  },

  /**
   * Moves every non-archived instance where `fromPersonId` is owner or approver to `toPersonId`, in any
   * state (M6, merging two people). Returns the rows that changed, with the values before.
   */
  replacePerson(
    tx: TenantTx,
    fromPersonId: string,
    toPersonId: string,
  ): Promise<ReassignedInstance[]> {
    const i = s.complianceInstance;
    return reassign(
      tx,
      and(or(eq(i.ownerId, fromPersonId), eq(i.approverId, fromPersonId)), isNull(i.archivedAt)),
      (row) => ({
        ownerId: row.ownerId === fromPersonId ? toPersonId : row.ownerId,
        approverId: row.approverId === fromPersonId ? toPersonId : row.approverId,
      }),
    );
  },

  /**
   * The register: flattened rows for one client, ordered by due date then id, keyset-paged, up to
   * `REGISTER_READ_LIMIT` rows a page. Callers add `status` and `overdueDays` from `engine.deriveStatus` (no status
   * maths here, root CLAUDE.md rule 3).
   */
  async register(
    tx: TenantTx,
    clientId: string,
    filter: RegisterFilter = {},
    page: { limit?: number; cursor?: string | null } = {},
  ): Promise<Page<RegisterRow>> {
    const f = validate(RegisterFilter, filter);
    const limit = registerLimit(page.limit);
    const i = s.complianceInstance;
    const conditions = registerConditions(clientId, f);
    if (page.cursor) {
      let after: z.output<typeof RegisterCursor>;
      try {
        after = RegisterCursor.parse(
          JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8')),
        );
      } catch {
        throw new DbError('VALIDATION', 'Invalid cursor');
      }
      conditions.push(sql`(${i.dueDate}, ${i.id}) > (${after.dueDate}::date, ${after.id}::uuid)`);
    }
    // The joins run in the order written, from the client's instances out to their labels. Left to search every
    // order of 11 tables, the planner spent about 130 ms a page on a plan no faster than this one (security review
    // F16). Only for this query: the setting goes back to what it was once the rows are read.
    const {
      rows: [setting],
    } = await tx
      .execute<{
        previous: string;
      }>(
        sql`SELECT current_setting('join_collapse_limit') AS previous, set_config('join_collapse_limit', '1', true)`,
      )
      .catch(rethrow);
    const rows = await tx
      .select({
        id: i.id,
        version: i.version,
        obligationId: s.obligation.id,
        externalRef: s.obligation.externalRef,
        title: s.obligation.title,
        timelineType: s.obligation.timelineType,
        categoryName: s.category.name,
        actId: s.act.id,
        actName: s.act.name,
        criticality: s.obligation.criticality,
        clientId: i.clientId,
        companyName: s.company.name,
        unitId: i.unitId,
        unitName: s.unit.name,
        locationLabel: sql<string>`concat_ws(' / ', ${s.location.country}, ${s.location.state}, ${s.location.city})`,
        departmentId: s.department.id,
        departmentName: s.department.name,
        ownerId: i.ownerId,
        ownerName: owner.displayName,
        approverId: i.approverId,
        approverName: approver.displayName,
        periodStart: i.periodStart,
        periodEnd: i.periodEnd,
        dueDate: i.dueDate,
        completedOn: i.completedOn,
        workflowState: i.workflowState,
        pendingKind: i.pendingKind,
        evidenceCount,
        commentCount,
        lastComment,
        forms: s.obligation.forms,
        logSheets: s.obligation.logSheets,
      })
      .from(i)
      .innerJoin(s.assignment, eq(s.assignment.id, i.assignmentId))
      .innerJoin(s.obligation, eq(s.obligation.id, s.assignment.obligationId))
      .innerJoin(s.act, eq(s.act.id, s.obligation.actId))
      .innerJoin(s.category, eq(s.category.id, s.obligation.categoryId))
      .innerJoin(s.department, eq(s.department.id, s.assignment.departmentId))
      .innerJoin(s.unit, eq(s.unit.id, i.unitId))
      .innerJoin(s.company, eq(s.company.id, s.unit.companyId))
      .innerJoin(s.location, eq(s.location.id, s.unit.locationId))
      .innerJoin(owner, eq(owner.id, i.ownerId))
      .innerJoin(approver, eq(approver.id, i.approverId))
      .where(and(...conditions))
      .orderBy(asc(i.dueDate), asc(i.id))
      .limit(limit + 1)
      .catch(rethrow);
    await tx
      .execute(sql`SELECT set_config('join_collapse_limit', ${setting!.previous}, true)`)
      .catch(rethrow);
    const items = rows.slice(0, limit).map(({ forms, logSheets, ...row }) => ({
      ...row,
      formLabels: labels(forms),
      logSheetLabels: labels(logSheets),
    })) as RegisterRow[];
    const last = rows.length > limit ? items[limit - 1]! : null;
    const nextCursor = last
      ? Buffer.from(JSON.stringify({ dueDate: last.dueDate, id: last.id }), 'utf8').toString(
          'base64url',
        )
      : null;
    return { items, nextCursor };
  },
};

/**
 * Newest first on (time, id): rows strictly before the cursor's row. The cursor is that row's id and its
 * time is read back from the table, so the comparison keeps Postgres's microseconds (a JS Date has ms).
 */
function before(table: PgTable, at: PgColumn, id: PgColumn, cursor: string | null | undefined) {
  if (!cursor) return undefined;
  const last = decodeCursor(cursor);
  return sql`(${at}, ${id}) < ((select x.${sql.identifier(at.name)} from ${table} x where x.id = ${last}), ${last}::uuid)`;
}

/** Filters for the evidence vault (M7). Upload bounds are instants, half-open [from, to). */
export const EvidenceVaultFilter = z.strictObject({
  unitIds: z.array(Id).optional(),
  actIds: z.array(Id).optional(),
  departmentIds: z.array(Id).optional(),
  uploadedFrom: Instant.optional(),
  uploadedTo: Instant.optional(),
  scanStatus: z.array(ScanStatus).optional(),
  /** Case-insensitive substring of the file name. */
  q: z.string().max(200).optional(),
  after: z.string().nullable().optional(),
  limit: z.int().optional(),
});
export type EvidenceVaultFilter = z.infer<typeof EvidenceVaultFilter>;

/** Filters for the audit trail (M7). Time bounds are instants, half-open [from, to). */
export const AuditQuery = z.strictObject({
  clientId: Id.optional(),
  entityType: EntityType.optional(),
  entityId: Id.optional(),
  actorId: Id.optional(),
  action: z.array(AuditAction).optional(),
  from: Instant.optional(),
  to: Instant.optional(),
  after: z.string().nullable().optional(),
  limit: z.int().optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

/** A list filter: undefined means no filter, an empty list matches nothing. */
function anyOf(
  column: Parameters<typeof inArray>[0],
  ids: readonly string[] | undefined,
): SQL | undefined {
  if (ids === undefined) return undefined;
  return ids.length === 0 ? sql`false` : inArray(column, [...ids]);
}

const evidenceEntity = entity<
  Evidence,
  Omit<Evidence, 'id' | 'firmId' | 'createdAt' | 'updatedAt' | 'archivedAt' | 'scanStatus'> & {
    scanStatus?: ScanStatus;
  }
>({
  table: s.evidence,
  schema: Evidence,
});
const toView = ({ storageKey: _storageKey, ...view }: Evidence): EvidenceView =>
  EvidenceView.parse(view);

export const evidence = {
  /** Includes `storageKey`: for the API's signed-URL step only, never returned to clients. */
  get: evidenceEntity.get,
  require: evidenceEntity.require,
  /** What clients see: no storage key. */
  async view(tx: TenantTx, id: string): Promise<EvidenceView | null> {
    const row = await evidenceEntity.get(tx, id);
    return row ? toView(row) : null;
  },
  async forInstance(tx: TenantTx, instanceId: string): Promise<EvidenceView[]> {
    const rows = await evidenceEntity.all(
      tx,
      and(eq(s.evidence.instanceId, instanceId), isNull(s.evidence.archivedAt)),
    );
    return rows.map(toView);
  },
  /**
   * The client's evidence library, newest upload first, archived rows left out. Unit, Act and department
   * come from the instance's unit and its assignment's obligation and department.
   */
  async vault(
    tx: TenantTx,
    clientId: string,
    filter: EvidenceVaultFilter = {},
  ): Promise<Page<EvidenceView>> {
    const f = validate(EvidenceVaultFilter, filter);
    const limit = pageLimit(f.limit);
    const e = s.evidence;
    const text = f.q?.trim();
    const rows = await tx
      .select({ evidence: e })
      .from(e)
      .innerJoin(s.complianceInstance, eq(s.complianceInstance.id, e.instanceId))
      .innerJoin(s.assignment, eq(s.assignment.id, s.complianceInstance.assignmentId))
      .innerJoin(s.obligation, eq(s.obligation.id, s.assignment.obligationId))
      .where(
        and(
          eq(e.clientId, clientId),
          isNull(e.archivedAt),
          anyOf(s.complianceInstance.unitId, f.unitIds),
          anyOf(s.obligation.actId, f.actIds),
          anyOf(s.assignment.departmentId, f.departmentIds),
          f.scanStatus === undefined
            ? undefined
            : f.scanStatus.length === 0
              ? sql`false`
              : inArray(e.scanStatus, f.scanStatus),
          f.uploadedFrom ? gte(e.createdAt, new Date(f.uploadedFrom)) : undefined,
          f.uploadedTo ? lt(e.createdAt, new Date(f.uploadedTo)) : undefined,
          text ? ilike(e.fileName, containsPattern(text)) : undefined,
          before(e, e.createdAt, e.id, f.after),
        ),
      )
      .orderBy(desc(e.createdAt), desc(e.id))
      .limit(limit)
      .catch(rethrow);
    const items = rows.map((r) => toView(evidenceEntity.parse(r.evidence)));
    const last = items.length === limit ? items[items.length - 1] : undefined;
    return { items, nextCursor: last ? encodeCursor(last.id) : null };
  },
  create: evidenceEntity.create,
  setScanStatus: (tx: TenantTx, id: string, scanStatus: ScanStatus): Promise<Evidence> =>
    evidenceEntity.set(tx, id, { scanStatus }),
  /** Removes evidence from view; the row and the file stay (no hard deletes). */
  archive: (tx: TenantTx, id: string): Promise<Evidence> =>
    evidenceEntity.set(tx, id, { archivedAt: new Date() }),
};

const commentEntity = entity<
  Comment,
  Omit<Comment, 'id' | 'firmId' | 'createdAt' | 'updatedAt' | 'archivedAt'>
>({
  table: s.comment,
  schema: Comment,
});
export const comments = {
  get: commentEntity.get,
  create: commentEntity.create,
  /** An instance's comments, oldest first. */
  async forInstance(tx: TenantTx, instanceId: string): Promise<Comment[]> {
    const rows = await tx
      .select()
      .from(s.comment)
      .where(and(eq(s.comment.instanceId, instanceId), isNull(s.comment.archivedAt)))
      .orderBy(asc(s.comment.createdAt), asc(s.comment.id))
      .catch(rethrow);
    return rows.map((r) => commentEntity.parse(r));
  },
};

/** What a caller supplies for an audit event; id, firm and time come from the database. */
export type NewAuditEvent = Omit<AuditEvent, 'id' | 'firmId' | 'at'>;

const PLACEHOLDER_ID = '00000000-0000-7000-8000-000000000000';

/** What the register export adds per instance (M10 ADR M10-0001 §8). */
export interface InstanceExportDetail {
  instanceId: string;
  description: string;
  applicabilityText: string | null;
  naReason: string | null;
  /** The instance's first non-archived comment, or null. */
  firstComment: string | null;
}

export const auditEvents = {
  /**
   * Appends an audit event in the caller's transaction (root CLAUDE.md non-negotiable 2). No RETURNING,
   * so a client user can record a firm-level event (null client) they may not read back.
   */
  async append(tx: TenantTx, event: NewAuditEvent): Promise<void> {
    validate(AuditEvent, {
      ...event,
      id: PLACEHOLDER_ID,
      firmId: PLACEHOLDER_ID,
      at: '2000-01-01T00:00:00Z',
    });
    await tx.insert(s.auditEvent).values(event).catch(rethrow);
  },
  /** The time of the latest audit event per client this context sees (clients with none are left out). */
  async latestByClient(tx: TenantTx): Promise<{ clientId: string; at: string }[]> {
    const t = s.auditEvent;
    const rows = await tx
      .select({ clientId: t.clientId, at: sql<Date>`max(${t.at})` })
      .from(t)
      .where(sql`${t.clientId} is not null`)
      .groupBy(t.clientId)
      .orderBy(asc(t.clientId))
      .catch(rethrow);
    return rows.map((r) => ({ clientId: r.clientId!, at: new Date(r.at).toISOString() }));
  },
  /**
   * The audit trail this context sees, newest first (at, then id), filtered and paged with a keyset
   * cursor. `forEntity` is the same history for one entity without a cursor.
   */
  async query(tx: TenantTx, q: AuditQuery = {}): Promise<Page<AuditEvent>> {
    const f = validate(AuditQuery, q);
    const limit = pageLimit(f.limit);
    const t = s.auditEvent;
    const rows = await tx
      .select()
      .from(t)
      .where(
        and(
          f.clientId ? eq(t.clientId, f.clientId) : undefined,
          f.entityType ? eq(t.entityType, f.entityType) : undefined,
          f.entityId ? eq(t.entityId, f.entityId) : undefined,
          f.actorId ? eq(t.actorId, f.actorId) : undefined,
          f.action === undefined
            ? undefined
            : f.action.length === 0
              ? sql`false`
              : inArray(t.action, f.action),
          f.from ? gte(t.at, new Date(f.from)) : undefined,
          f.to ? lt(t.at, new Date(f.to)) : undefined,
          before(t, t.at, t.id, f.after),
        ),
      )
      .orderBy(desc(t.at), desc(t.id))
      .limit(limit)
      .catch(rethrow);
    const items = rows.map((r) => AuditEvent.parse(toWire(r)));
    const last = items.length === limit ? items[items.length - 1] : undefined;
    return { items, nextCursor: last ? encodeCursor(last.id) : null };
  },
  /** History of one entity, newest first. */
  async forEntity(
    tx: TenantTx,
    entityType: AuditEvent['entityType'],
    entityId: string,
    page: { limit?: number } = {},
  ): Promise<AuditEvent[]> {
    const rows = await tx
      .select()
      .from(s.auditEvent)
      .where(and(eq(s.auditEvent.entityType, entityType), eq(s.auditEvent.entityId, entityId)))
      .orderBy(desc(s.auditEvent.at), desc(s.auditEvent.id))
      .limit(pageLimit(page.limit))
      .catch(rethrow);
    return rows.map((r) => AuditEvent.parse(toWire(r)));
  },
};
