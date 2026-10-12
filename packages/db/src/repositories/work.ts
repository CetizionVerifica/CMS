import {
  Assignment,
  AuditEvent,
  Comment,
  ComplianceInstance,
  Criticality,
  Evidence,
  EvidenceView,
  Id,
  LocalDate,
  ObligationDomain,
  TimelineType,
  WorkflowState,
  type InstanceRow,
  type ScanStatus,
  type TemplateRef,
} from '@canopy/contracts';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { TenantTx } from '../database.js';
import { DbError, rethrow, validate } from '../errors.js';
import * as s from '../schema/index.js';
import { instantsToDates } from './convert.js';
import { entity, pageLimit, toWire, type NewEntity, type Page, type PageRequest } from './crud.js';

/** Work: assignments, instances, evidence, comments, audit (domain-model.md §5). */

const assignmentEntity = entity<Assignment>({ table: s.assignment, schema: Assignment });
export const assignments = {
  get: assignmentEntity.get,
  require: assignmentEntity.require,
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
  /** Limit to these units (an owner's or approver's scope). */
  unitIds: z.array(Id).optional(),
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

export const instances = {
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
   * The register: flattened rows for one client, ordered by due date then id, keyset-paged. Callers add
   * `status` and `overdueDays` from `engine.deriveStatus` (no status maths here, root CLAUDE.md rule 3).
   */
  async register(
    tx: TenantTx,
    clientId: string,
    filter: RegisterFilter = {},
    page: { limit?: number; cursor?: string | null } = {},
  ): Promise<Page<RegisterRow>> {
    const f = validate(RegisterFilter, filter);
    const limit = pageLimit(page.limit);
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
