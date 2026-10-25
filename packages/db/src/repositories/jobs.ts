import {
  Applicability,
  ClientSettings,
  Criticality,
  Id,
  InstanceStatusInput,
  LocalDate,
  Name,
  RecurrenceRule,
  RuleStatus,
  ScoreInput,
} from '@canopy/contracts';
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TenantTx } from '../database.js';
import { rethrow, validate } from '../errors.js';
import * as s from '../schema/index.js';
import { actIdOfKind, type ActKindFilter } from './act-kind.js';

/**
 * Read models for the scheduled jobs (M9: instance generation, reminders, digests, scores). Each runs in
 * a system context for one firm (`systemContext(firmId, requestId)`), so RLS still scopes every row.
 * Shapes follow apps/api/src/jobs/ports.ts and are parsed like every repository result. No status maths.
 */

export const ClientRef = z.strictObject({ id: Id, name: Name, settings: ClientSettings });
export type ClientRef = z.infer<typeof ClientRef>;

export const GenerationTarget = z.strictObject({
  assignmentId: Id,
  /** The assignment's row version, for the event's aggregateVersion. */
  assignmentVersion: z.int().min(1),
  clientId: Id,
  applicability: Applicability,
  activeFrom: LocalDate,
  activeTo: LocalDate.nullable(),
  ownerId: Id,
  approverId: Id,
  obligationId: Id,
  recurrenceRule: RecurrenceRule,
  ruleStatus: RuleStatus,
});
export type GenerationTarget = z.infer<typeof GenerationTarget>;

export const ExistingInstanceKey = z.strictObject({
  assignmentId: Id,
  periodStart: LocalDate,
  dueDate: LocalDate,
});
export type ExistingInstanceKey = z.infer<typeof ExistingInstanceKey>;

export const NewGeneratedInstance = z.strictObject({
  assignmentId: Id,
  clientId: Id,
  periodStart: LocalDate,
  periodEnd: LocalDate,
  dueDate: LocalDate,
  ownerId: Id,
  approverId: Id,
});
export type NewGeneratedInstance = z.input<typeof NewGeneratedInstance>;

/** An instance that may need a reminder (engine NotificationInput) with the names its email shows. */
export const ReminderCandidate = InstanceStatusInput.extend({
  id: Id,
  ownerId: Id,
  approverId: Id,
  clientId: Id,
  title: z.string().min(1),
  actName: Name,
  unitName: Name,
  departmentName: Name,
  criticality: Criticality,
});
export type ReminderCandidate = z.infer<typeof ReminderCandidate>;

export interface Recipient {
  personId: string;
  displayName: string;
  /** Null while the person is unclaimed. */
  email: string | null;
  /** ACTIVE person with an unexpired, unarchived membership for the client. */
  canReceive: boolean;
}

export interface ConsultantRef {
  personId: string;
  displayName: string;
  email: string | null;
  /** ACTIVE person with an unexpired, unarchived CONSULTANT membership. */
  canReceive: boolean;
  clientIds: string[];
}

export interface DateRange {
  from: string;
  to: string;
}

/** Workflow states a reminder can still be about. */
const REMINDABLE = ['OPEN', 'SENT_BACK', 'SUBMITTED'] as const;

/** A membership that is in force now: not archived and not expired. Use only where `membership` is the sole table or qualified. */
const liveMembership = sql`${s.membership.archivedAt} is null and (${s.membership.expiresAt} is null or ${s.membership.expiresAt} > now())`;

export const jobs = {
  /** Non-archived clients of the firm. */
  async listClients(tx: TenantTx): Promise<ClientRef[]> {
    return tx
      .select({ id: s.client.id, name: s.client.name, settings: s.client.settings })
      .from(s.client)
      .where(isNull(s.client.archivedAt))
      .orderBy(asc(s.client.id))
      .catch(rethrow)
      .then((rows) => rows.map((r) => ClientRef.parse(r)));
  },

  /** Non-archived assignments of one client, with the obligation's rule. */
  async listGenerationTargets(tx: TenantTx, clientId: string): Promise<GenerationTarget[]> {
    const a = s.assignment;
    const o = s.obligation;
    return tx
      .select({
        assignmentId: a.id,
        assignmentVersion: a.version,
        clientId: a.clientId,
        applicability: a.applicability,
        activeFrom: a.activeFrom,
        activeTo: a.activeTo,
        ownerId: a.defaultOwnerId,
        approverId: a.defaultApproverId,
        obligationId: o.id,
        recurrenceRule: o.recurrenceRule,
        ruleStatus: o.ruleStatus,
      })
      .from(a)
      .innerJoin(o, and(eq(o.firmId, a.firmId), eq(o.id, a.obligationId)))
      .where(and(eq(a.clientId, clientId), isNull(a.archivedAt)))
      .orderBy(asc(a.id))
      .catch(rethrow)
      .then((rows) => rows.map((r) => GenerationTarget.parse(r)));
  },

  /** Instances (archived or not) of these assignments with a due date in the range. */
  async listInstanceKeys(
    tx: TenantTx,
    assignmentIds: readonly string[],
    range: DateRange,
  ): Promise<ExistingInstanceKey[]> {
    if (assignmentIds.length === 0) return [];
    const i = s.complianceInstance;
    return tx
      .select({ assignmentId: i.assignmentId, periodStart: i.periodStart, dueDate: i.dueDate })
      .from(i)
      .where(
        and(
          inArray(i.assignmentId, [...assignmentIds]),
          gte(i.dueDate, range.from),
          lte(i.dueDate, range.to),
        ),
      )
      .orderBy(asc(i.assignmentId), asc(i.periodStart))
      .catch(rethrow)
      .then((rows) => rows.map((r) => ExistingInstanceKey.parse(r)));
  },

  /**
   * Inserts generated instances with ON CONFLICT (assignment_id, period_start) DO NOTHING. Returns, in
   * input order, the new id or null where the period already existed. The unit comes from the assignment.
   */
  async insertInstances(
    tx: TenantTx,
    rows: readonly NewGeneratedInstance[],
  ): Promise<(string | null)[]> {
    if (rows.length === 0) return [];
    const parsed = rows.map((r) => validate(NewGeneratedInstance, r));
    const assignmentIds = [...new Set(parsed.map((r) => r.assignmentId))];
    const units = new Map(
      (
        await tx
          .select({ id: s.assignment.id, unitId: s.assignment.unitId })
          .from(s.assignment)
          .where(inArray(s.assignment.id, assignmentIds))
          .catch(rethrow)
      ).map((a) => [a.id, a.unitId]),
    );
    const inserted = await tx
      .insert(s.complianceInstance)
      .values(
        parsed.map((r) => ({
          ...r,
          // A missing assignment leaves the unit null, which the NOT NULL constraint refuses.
          unitId: units.get(r.assignmentId) as string,
        })),
      )
      .onConflictDoNothing({
        target: [s.complianceInstance.assignmentId, s.complianceInstance.periodStart],
      })
      .returning({
        id: s.complianceInstance.id,
        assignmentId: s.complianceInstance.assignmentId,
        periodStart: s.complianceInstance.periodStart,
      })
      .catch(rethrow);
    const ids = new Map(inserted.map((r) => [`${r.assignmentId}|${r.periodStart}`, r.id]));
    return rows.map((r) => ids.get(`${r.assignmentId}|${r.periodStart}`) ?? null);
  },

  /**
   * Non-archived instances of one client in OPEN, SENT_BACK or SUBMITTED with a due date in the range,
   * whose assignment is APPLICABLE, with the names a reminder shows.
   */
  async listReminderCandidates(
    tx: TenantTx,
    clientId: string,
    range: DateRange,
  ): Promise<ReminderCandidate[]> {
    const i = s.complianceInstance;
    const a = s.assignment;
    const o = s.obligation;
    return tx
      .select({
        id: i.id,
        clientId: i.clientId,
        ownerId: i.ownerId,
        approverId: i.approverId,
        workflowState: i.workflowState,
        pendingKind: i.pendingKind,
        dueDate: i.dueDate,
        completedOn: i.completedOn,
        title: o.title,
        actName: s.act.name,
        unitName: s.unit.name,
        departmentName: s.department.name,
        criticality: o.criticality,
      })
      .from(i)
      .innerJoin(a, and(eq(a.firmId, i.firmId), eq(a.id, i.assignmentId)))
      .innerJoin(o, and(eq(o.firmId, a.firmId), eq(o.id, a.obligationId)))
      .innerJoin(s.act, and(eq(s.act.firmId, o.firmId), eq(s.act.id, o.actId)))
      .innerJoin(s.unit, and(eq(s.unit.firmId, i.firmId), eq(s.unit.id, i.unitId)))
      .innerJoin(
        s.department,
        and(eq(s.department.firmId, a.firmId), eq(s.department.id, a.departmentId)),
      )
      .where(
        and(
          eq(i.clientId, clientId),
          isNull(i.archivedAt),
          inArray(i.workflowState, [...REMINDABLE]),
          eq(a.applicability, 'APPLICABLE'),
          gte(i.dueDate, range.from),
          lte(i.dueDate, range.to),
        ),
      )
      .orderBy(asc(i.dueDate), asc(i.id))
      .catch(rethrow)
      .then((rows) => rows.map((r) => ReminderCandidate.parse(r)));
  },

  /** People by id, with whether they may receive mail about this client now. */
  async recipients(
    tx: TenantTx,
    personIds: readonly string[],
    clientId: string,
  ): Promise<Recipient[]> {
    if (personIds.length === 0) return [];
    const ids = [...personIds];
    const people = await tx
      .select({
        personId: s.person.id,
        displayName: s.person.displayName,
        email: s.person.email,
        status: s.person.status,
      })
      .from(s.person)
      .where(inArray(s.person.id, ids))
      .orderBy(asc(s.person.id))
      .catch(rethrow);
    const members = new Set(
      (
        await tx
          .select({ personId: s.membership.personId })
          .from(s.membership)
          .where(
            and(
              inArray(s.membership.personId, ids),
              eq(s.membership.clientId, clientId),
              liveMembership,
            ),
          )
          .catch(rethrow)
      ).map((m) => m.personId),
    );
    return people.map(({ status, ...p }) => ({
      ...p,
      canReceive: status === 'ACTIVE' && members.has(p.personId),
    }));
  },

  /** Everyone with a non-archived CONSULTANT membership, with the clients it covers. */
  async listConsultants(tx: TenantTx): Promise<ConsultantRef[]> {
    const p = s.person;
    const m = s.membership;
    const rows = await tx
      .select({
        personId: p.id,
        displayName: p.displayName,
        email: p.email,
        live: sql<boolean>`${p.status} = 'ACTIVE' and ${liveMembership}`,
        clientIds: m.consultantClientIds,
      })
      .from(m)
      .innerJoin(p, and(eq(p.firmId, m.firmId), eq(p.id, m.personId)))
      .where(and(eq(m.role, 'CONSULTANT'), isNull(m.archivedAt)))
      .orderBy(asc(p.id))
      .catch(rethrow);
    const byPerson = new Map<string, ConsultantRef>();
    for (const r of rows) {
      const ref = byPerson.get(r.personId) ?? {
        personId: r.personId,
        displayName: r.displayName,
        email: r.email,
        canReceive: false,
        clientIds: [],
      };
      if (r.live) {
        ref.canReceive = true;
        for (const id of r.clientIds ?? []) if (!ref.clientIds.includes(id)) ref.clientIds.push(id);
      }
      byPerson.set(r.personId, ref);
    }
    return [...byPerson.values()];
  },

  /**
   * Score inputs for one client's non-archived instances with a due date in the range. `actKinds` keeps those whose
   * act is of those kinds: the digest's statutory score passes `['STATUTE']` (docs/iso/plan.md §4.6).
   */
  async listScoreItems(
    tx: TenantTx,
    clientId: string,
    range: DateRange,
    filter: ActKindFilter = {},
  ): Promise<ScoreInput[]> {
    const i = s.complianceInstance;
    const a = s.assignment;
    const o = s.obligation;
    return tx
      .select({
        instanceId: i.id,
        criticality: o.criticality,
        dueDate: i.dueDate,
        workflowState: i.workflowState,
        pendingKind: i.pendingKind,
        completedOn: i.completedOn,
      })
      .from(i)
      .innerJoin(a, and(eq(a.firmId, i.firmId), eq(a.id, i.assignmentId)))
      .innerJoin(o, and(eq(o.firmId, a.firmId), eq(o.id, a.obligationId)))
      .where(
        and(
          eq(i.clientId, clientId),
          isNull(i.archivedAt),
          gte(i.dueDate, range.from),
          lte(i.dueDate, range.to),
          actIdOfKind(o.actId, filter.actKinds),
        ),
      )
      .orderBy(asc(i.id))
      .catch(rethrow)
      .then((rows) => rows.map((r) => ScoreInput.parse(r)));
  },
};
