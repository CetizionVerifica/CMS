import {
  type AuditChecklistItem,
  type AuditFinding,
  type AuditProgramme,
  type AuditProgrammeView,
  type InternalAudit,
  type InternalAuditView,
  type ManagementSystem,
  type RequestContext,
} from '@canopy/contracts';
import {
  auditChecklistItems,
  auditFindings,
  auditProgrammes,
  clauseAssessments,
  internalAudits,
  isoCatalogue,
  managementSystems,
  nonconformities,
  type InternalAuditFilter,
  type TenantTx,
} from '@canopy/db';
import { auditProgrammeCoverage, ISO_TRANSITIONS, isoTransition } from '@canopy/engine';
import { ApiError } from '../../auth/index.js';
import {
  authorize,
  canSee,
  holdsRole,
  isoResource,
  listScope,
  may,
  selfResource,
  systemReach,
  type Reach,
} from './access.js';
import { definedOf, liveIn, type Core } from './db-context.js';
import { checkClauses, editFinding, recordFinding, standardsOf } from './db-findings.js';
import { checkVersion, invalid, invalidTransition, notFound, stepTo } from './errors.js';
import { pageOf } from './paging.js';
import type { IsoCall, IsoHandlers } from './types.js';

/**
 * Audit programmes, internal audits, their checklists and findings (docs/iso/model.md §3.7, §3.9, §4.3): every arrow
 * of the INTERNAL_AUDIT machine through the engine, the plan edit (`isoAudit.plan`) and the work of the audit team
 * (`isoAudit.conduct`: a manager, or an approver or owner who is the lead auditor or an auditor). The mock's picks
 * (docs/contracts/iso-mock.md "Audits") hold here, except as ADR M16-0007 records.
 */

type Ids =
  | 'listIsoAuditProgrammes'
  | 'createIsoAuditProgramme'
  | 'updateIsoAuditProgramme'
  | 'listIsoInternalAudits'
  | 'createIsoInternalAudit'
  | 'getIsoInternalAudit'
  | 'updateIsoInternalAudit'
  | 'startIsoInternalAudit'
  | 'reportIsoInternalAudit'
  | 'closeIsoInternalAudit'
  | 'cancelIsoInternalAudit'
  | 'listIsoAuditChecklist'
  | 'createIsoAuditChecklistItem'
  | 'updateIsoAuditChecklistItem'
  | 'listIsoInternalFindings'
  | 'createIsoInternalFinding'
  | 'updateIsoInternalFinding';

type AuditStep = InternalAuditView['allowedActions'][number];

/** States in which the audit's plan and checklist may change; later ones lock them (model §6). */
const OPEN: readonly string[] = ['PLANNED', 'IN_PROGRESS'];
/** The fields of a planned audit, as its CREATE event records them (the independence note too, model §3.7). */
const PLAN_FIELDS = [
  'programmeId',
  'title',
  'plannedStart',
  'plannedEnd',
  'clauseIds',
  'unitIds',
  'leadAuditorId',
  'auditorIds',
  'auditeeIds',
  'reportedToIds',
  'independenceNote',
  'state',
] as const satisfies readonly (keyof InternalAudit)[];

/** Everyone named on an audit, who always sees it (plan §3.3). */
export const auditPeople = (audit: InternalAudit): string[] => [
  audit.leadAuditorId,
  ...audit.auditorIds,
  ...audit.auditeeIds,
  ...audit.reportedToIds,
];

/** The lead auditor and the auditors: "own" for `isoAudit.conduct` (plan §3.2). */
export const auditTeam = (audit: InternalAudit): string[] => [
  audit.leadAuditorId,
  ...audit.auditorIds,
];

/**
 * An audit's units (its list, else its system's) and the people it names. Its checklist rows and findings take the
 * same reach (a child record takes its parent's units, plan §3.3).
 */
export const internalAuditReach = (system: ManagementSystem, audit: InternalAudit): Reach => ({
  clientId: audit.clientId,
  unitIds: audit.unitIds.length > 0 ? audit.unitIds : system.unitIds,
  people: auditPeople(audit),
});

/** Where an audit over `unitIds` would sit, naming nobody: what planning it or moving its units must cover. */
const planReach = (system: ManagementSystem, unitIds: readonly string[]): Reach => ({
  clientId: system.clientId,
  unitIds:
    unitIds.length > 0 &&
    (system.unitIds.length === 0 || unitIds.every((u) => system.unitIds.includes(u)))
      ? unitIds
      : system.unitIds,
  people: [],
});

/** A field edit or a new or changed checklist row on a REPORTED, CLOSED or CANCELLED audit (model §6). */
function requireOpen(audit: InternalAudit): void {
  if (!OPEN.includes(audit.state)) invalidTransition('internal_audit', audit.state, 'UPDATE');
}

/** Findings are recorded and changed while the audit is IN_PROGRESS. */
function requireInProgress(audit: InternalAudit): void {
  if (audit.state !== 'IN_PROGRESS') invalidTransition('internal_audit', audit.state, 'UPDATE');
}

/** The stored audit's own rules on the merged plan: dates in order, the lead not listed again, independence (9.2.2). */
function checkPlan(audit: InternalAudit): void {
  if (audit.plannedEnd < audit.plannedStart) {
    invalid('plannedEnd', 'The audit ends after it starts');
  }
  if (audit.auditorIds.includes(audit.leadAuditorId)) {
    invalid('auditorIds', 'The lead auditor is not listed again');
  }
  const team = auditTeam(audit);
  if (team.some((id) => audit.auditeeIds.includes(id)) && audit.independenceNote === null) {
    invalid('independenceNote', 'An auditor who is also an auditee needs an independence note');
  }
}

/** By creation: ids are UUIDv7, so id order is the order rows were added. */
const byCreation = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);

export function auditsHandlers(core: Core): IsoHandlers<Ids> {
  /** All pages of a client's internal audits matching `filter`. */
  async function allAudits(
    tx: TenantTx,
    clientId: string,
    filter: InternalAuditFilter,
  ): Promise<InternalAudit[]> {
    const out: InternalAudit[] = [];
    let cursor: string | null = null;
    do {
      const page = await internalAudits.list(tx, clientId, {
        ...filter,
        limit: 200,
        ...(cursor === null ? {} : { cursor }),
      });
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return out;
  }

  /**
   * `auditProgrammeCoverage` (model §5.1) through the engine: what the programme's REPORTED and CLOSED audits leave
   * uncovered of the system's assessable clauses without an approved N/A, and of its listed units; the counts are of
   * the audits the actor may see, as on the overview.
   */
  async function programmeView(
    tx: TenantTx,
    ctx: RequestContext,
    programme: AuditProgramme,
    system: ManagementSystem,
  ): Promise<AuditProgrammeView> {
    const audits = await allAudits(tx, programme.clientId, { programmeIds: [programme.id] });
    const items: AuditChecklistItem[] = [];
    for (const audit of audits) items.push(...(await auditChecklistItems.forAudit(tx, audit.id)));
    const approved = new Set(
      (await clauseAssessments.list(tx, system.id, { naState: ['APPROVED'] })).map(
        (r) => r.clauseId,
      ),
    );
    const clauses = (await isoCatalogue.clauses(tx, { standardIds: system.standardIds })).map(
      (c) => ({
        id: c.id,
        assessable: c.assessable,
        excluded: c.exclusionAllowed && approved.has(c.id),
      }),
    );
    const all = auditProgrammeCoverage(audits, items, system, clauses, programme.fy);
    const visible = audits.filter((a) => canSee(ctx, internalAuditReach(system, a)));
    const seen = auditProgrammeCoverage(visible, [], system, [], programme.fy);
    return {
      ...programme,
      coverage: {
        ...all,
        planned: seen.planned,
        reported: seen.reported,
        cancelled: seen.cancelled,
      },
    };
  }

  async function loadProgramme(tx: TenantTx, ctx: RequestContext, clientId: string, id: string) {
    const programme = liveIn(await auditProgrammes.get(tx, id), clientId);
    const system = await managementSystems.require(tx, programme.managementSystemId);
    if (!canSee(ctx, systemReach(system))) notFound();
    return { programme, system };
  }

  async function loadAudit(tx: TenantTx, ctx: RequestContext, clientId: string, id: string) {
    const audit = liveIn(await internalAudits.get(tx, id), clientId);
    const programme = await auditProgrammes.require(tx, audit.programmeId);
    const system = await managementSystems.require(tx, programme.managementSystemId);
    const reach = internalAuditReach(system, audit);
    if (!canSee(ctx, reach)) notFound();
    return { audit, system, reach };
  }

  /** The `isoAudit.conduct` resource: the audit team are "own" (plan §3.2). */
  const conductOn = (
    ctx: RequestContext,
    type: 'internal_audit' | 'audit_checklist_item' | 'audit_finding',
    audit: InternalAudit,
    reach: Reach,
  ) => selfResource(ctx, type, reach, auditTeam(audit));

  /**
   * An audit with the steps the actor may take now (model §4.3): the arrows leaving its state, START, REPORT and CLOSE
   * for whoever conducts it, CANCEL for whoever plans it.
   */
  function auditView(
    ctx: RequestContext,
    system: ManagementSystem,
    audit: InternalAudit,
  ): InternalAuditView {
    const reach = internalAuditReach(system, audit);
    const conducts = may(ctx, 'isoAudit.conduct', conductOn(ctx, 'internal_audit', audit, reach));
    const plans = may(ctx, 'isoAudit.plan', isoResource(ctx, 'internal_audit', reach));
    const allowedActions = ISO_TRANSITIONS.INTERNAL_AUDIT.filter((a) =>
      a.from.includes(audit.state),
    )
      .map((a) => a.action as AuditStep)
      .filter((a) => (a === 'CANCEL' ? plans : conducts));
    return { ...audit, managementSystemId: system.id, allowedActions };
  }

  /** Who an audit names works in its client (model §1.5); auditors come from other units, so no unit is checked. */
  async function checkPeople(
    tx: TenantTx,
    clientId: string,
    people: {
      leadAuditorId?: string | undefined;
      auditorIds?: readonly string[] | undefined;
      auditeeIds?: readonly string[] | undefined;
      reportedToIds?: readonly string[] | undefined;
    },
    before?: InternalAudit,
  ): Promise<void> {
    if (people.leadAuditorId !== undefined && people.leadAuditorId !== before?.leadAuditorId) {
      await core.checkPerson(tx, clientId, people.leadAuditorId, 'leadAuditorId');
    }
    for (const field of ['auditorIds', 'auditeeIds', 'reportedToIds'] as const) {
      for (const id of people[field] ?? []) {
        if (!(before?.[field] ?? []).includes(id)) await core.checkPerson(tx, clientId, id, field);
      }
    }
  }

  /** A row's or finding's unit is one of the audit's (its list, else its system's). */
  async function checkAuditUnit(
    tx: TenantTx,
    system: ManagementSystem,
    audit: InternalAudit,
    unitId: string | null | undefined,
  ): Promise<void> {
    if (unitId == null) return;
    if (audit.unitIds.length > 0) {
      if (!audit.unitIds.includes(unitId)) invalid('unitId', 'Not a unit of this audit');
    } else {
      await core.checkSystemUnits(tx, system, [unitId], 'unitId');
    }
  }

  /**
   * One arrow of the INTERNAL_AUDIT machine through the engine, audited as a TRANSITION naming the action with the
   * fields it set. START, REPORT and CLOSE are `isoAudit.conduct`; CANCEL is `isoAudit.plan`.
   */
  async function auditStep<
    K extends
      | 'startIsoInternalAudit'
      | 'reportIsoInternalAudit'
      | 'closeIsoInternalAudit'
      | 'cancelIsoInternalAudit',
  >(
    call: IsoCall<K>,
    action: AuditStep,
    plan: (
      tx: TenantTx,
      audit: InternalAudit,
    ) => Promise<{ facts: Record<string, unknown>; change: Partial<InternalAudit> }>,
    delegated: (audit: InternalAudit) => boolean,
  ): Promise<InternalAuditView> {
    const { ctx, params, body } = call;
    return core.keyed(ctx, call.key, async (tx) => {
      const { audit, system, reach } = await loadAudit(tx, ctx, params.clientId!, params.id!);
      if (action === 'CANCEL') {
        authorize(ctx, 'isoAudit.plan', isoResource(ctx, 'internal_audit', reach));
      } else {
        authorize(ctx, 'isoAudit.conduct', conductOn(ctx, 'internal_audit', audit, reach));
      }
      checkVersion(audit, body.version);
      if (
        !ISO_TRANSITIONS.INTERNAL_AUDIT.some(
          (a) => a.action === action && a.from.includes(audit.state),
        )
      ) {
        invalidTransition('internal_audit', audit.state, action);
      }
      const { facts, change } = await plan(tx, audit);
      const to = stepTo(
        isoTransition('INTERNAL_AUDIT', audit.state, action, facts),
        'internal_audit',
        audit.state,
        action,
      );
      const patch = { ...change, state: to } as Partial<InternalAudit>;
      const keys = Object.keys(patch) as (keyof InternalAudit)[];
      const updated = await internalAudits.update(tx, audit.id, audit.version, patch as never);
      await core.audit(tx, ctx, audit.clientId, {
        action: 'TRANSITION',
        entityType: 'internal_audit',
        entityId: audit.id,
        before: Object.fromEntries(keys.map((k) => [k, audit[k]])),
        after: { action, ...Object.fromEntries(keys.map((k) => [k, updated[k]])) },
        reason: 'reason' in body ? body.reason : null,
        delegated: delegated(audit),
      });
      return auditView(ctx, system, updated);
    });
  }

  /** A checklist row of `audit`, or 404 (another audit's row included). */
  async function loadItem(tx: TenantTx, audit: InternalAudit, id: string) {
    const item = liveIn(await auditChecklistItems.get(tx, id), audit.clientId);
    if (item.internalAuditId !== audit.id) notFound();
    return item;
  }

  /** A finding of `audit`, or 404 (another audit's finding included). */
  async function loadFinding(tx: TenantTx, audit: InternalAudit, id: string) {
    const finding = liveIn(await auditFindings.get(tx, id), audit.clientId);
    if (finding.internalAuditId !== audit.id) notFound();
    return finding;
  }

  const isClientAdmin = (ctx: RequestContext, clientId: string) =>
    holdsRole(ctx, clientId, ['CLIENT_ADMIN']);

  return {
    /** Newest FY first, then by creation. AP and OW see the programmes of systems covering their units. */
    async listIsoAuditProgrammes({ ctx, params, query }) {
      const clientId = params.clientId!;
      authorize(ctx, 'isoAudit.read', { type: 'audit_programme', clientId });
      return core.run(ctx, async (tx) => {
        // Every system's, archived ones too: their records keep their units.
        const systems: ManagementSystem[] = [];
        let cursor: string | null = null;
        do {
          const page = await managementSystems.list(tx, clientId, {
            includeArchived: true,
            limit: 200,
            ...(cursor === null ? {} : { cursor }),
          });
          systems.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor !== null);
        const rows: { programme: AuditProgramme; system: ManagementSystem }[] = [];
        for (const system of systems) {
          if (
            query.managementSystemId !== undefined &&
            !query.managementSystemId.includes(system.id)
          )
            continue;
          if (!canSee(ctx, systemReach(system))) continue;
          for (const programme of await auditProgrammes.list(tx, system.id)) {
            if (query.fy === undefined || programme.fy === query.fy)
              rows.push({ programme, system });
          }
        }
        rows.sort(
          (a, b) =>
            b.programme.fy.localeCompare(a.programme.fy) || byCreation(a.programme, b.programme),
        );
        const page = pageOf(
          rows.map((r) => ({ ...r, id: r.programme.id })),
          query,
        );
        const items: AuditProgrammeView[] = [];
        for (const r of page.items) items.push(await programmeView(tx, ctx, r.programme, r.system));
        return { ...page, items };
      });
    },

    /** One programme per system and FY (409 DUPLICATE naming the one there is). */
    async createIsoAuditProgramme({ ctx, params, body }) {
      const clientId = params.clientId!;
      return core.run(ctx, async (tx) => {
        const system = await core.loadSystem(tx, ctx, clientId, body.managementSystemId);
        authorize(ctx, 'isoSystem.write', isoResource(ctx, 'audit_programme', systemReach(system)));
        const clash = (await auditProgrammes.list(tx, system.id)).find((p) => p.fy === body.fy);
        if (clash !== undefined) {
          throw new ApiError(
            'DUPLICATE',
            { field: 'fy', existingId: clash.id },
            `This system already has a programme for ${body.fy}`,
          );
        }
        const programme = await auditProgrammes.create(tx, {
          clientId,
          managementSystemId: system.id,
          fy: body.fy,
          notes: body.notes,
        });
        await core.audit(tx, ctx, clientId, {
          action: 'CREATE',
          entityType: 'audit_programme',
          entityId: programme.id,
          after: { managementSystemId: system.id, fy: programme.fy, notes: programme.notes },
        });
        return programmeView(tx, ctx, programme, system);
      });
    },

    async updateIsoAuditProgramme({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { programme, system } = await loadProgramme(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoSystem.write', isoResource(ctx, 'audit_programme', systemReach(system)));
        checkVersion(programme, body.version);
        const updated = await core.edit(
          tx,
          ctx,
          programme,
          { notes: body.notes },
          'audit_programme',
          (changes) => auditProgrammes.update(tx, programme.id, body.version, changes),
        );
        return programmeView(tx, ctx, updated, system);
      });
    },

    /** By planned start, then title. AP and OW see audits over their units and those that name them. */
    async listIsoInternalAudits({ ctx, params, query }) {
      const clientId = params.clientId!;
      authorize(ctx, 'isoAudit.read', { type: 'internal_audit', clientId });
      return core.run(ctx, async (tx) => {
        const audits = await allAudits(
          tx,
          clientId,
          definedOf({
            ids: query.ids,
            programmeIds: query.programmeId,
            managementSystemIds: query.managementSystemId,
            state: query.state,
            from: query.from,
            to: query.to,
            scope: listScope(ctx, clientId),
          }),
        );
        const systems = new Map<string, ManagementSystem>();
        const systemOf = async (audit: InternalAudit) => {
          const programme = await auditProgrammes.require(tx, audit.programmeId);
          if (!systems.has(programme.managementSystemId)) {
            systems.set(
              programme.managementSystemId,
              await managementSystems.require(tx, programme.managementSystemId),
            );
          }
          return systems.get(programme.managementSystemId)!;
        };
        const lead = query.leadAuditorId === 'me' ? ctx.personId : query.leadAuditorId;
        const needle = query.q?.toLowerCase();
        const rows: { id: string; audit: InternalAudit; system: ManagementSystem }[] = [];
        for (const audit of audits) {
          const system = await systemOf(audit);
          const units = internalAuditReach(system, audit).unitIds;
          if (
            (lead === undefined || audit.leadAuditorId === lead) &&
            (query.unitId === undefined ||
              units.length === 0 ||
              units.some((u) => query.unitId!.includes(u))) &&
            (needle === undefined ||
              [audit.title, audit.summary].some((v) => v?.toLowerCase().includes(needle)))
          ) {
            rows.push({ id: audit.id, audit, system });
          }
        }
        rows.sort(
          (a, b) =>
            a.audit.plannedStart.localeCompare(b.audit.plannedStart) ||
            a.audit.title.localeCompare(b.audit.title) ||
            byCreation(a, b),
        );
        const page = pageOf(rows, query);
        return { ...page, items: page.items.map((r) => auditView(ctx, r.system, r.audit)) };
      });
    },

    /** PLAN: an audit in a programme, over units and clauses of its system, with an independence note where needed. */
    async createIsoInternalAudit({ ctx, params, body }) {
      const clientId = params.clientId!;
      return core.run(ctx, async (tx) => {
        const programme = liveIn(await auditProgrammes.get(tx, body.programmeId), clientId);
        const system = await core.loadSystem(tx, ctx, clientId, programme.managementSystemId);
        authorize(
          ctx,
          'isoAudit.plan',
          isoResource(ctx, 'internal_audit', planReach(system, body.unitIds)),
        );
        await checkClauses(
          tx,
          system.standardIds,
          body.clauseIds,
          'clauseIds',
          'Not a clause of the management system',
        );
        await core.checkSystemUnits(tx, system, body.unitIds, 'unitIds');
        await checkPeople(tx, clientId, body);
        const fields = {
          programmeId: programme.id,
          title: body.title,
          plannedStart: body.plannedStart,
          plannedEnd: body.plannedEnd,
          clauseIds: body.clauseIds,
          unitIds: body.unitIds,
          leadAuditorId: body.leadAuditorId,
          auditorIds: body.auditorIds,
          auditeeIds: body.auditeeIds,
          reportedToIds: body.reportedToIds,
          independenceNote: body.independenceNote,
          state: 'PLANNED' as const,
          summary: null,
          reportedOn: null,
          cancelReason: null,
        };
        const audit = await internalAudits.create(tx, { clientId, ...fields });
        await core.audit(tx, ctx, clientId, {
          action: 'CREATE',
          entityType: 'internal_audit',
          entityId: audit.id,
          after: Object.fromEntries(PLAN_FIELDS.map((k) => [k, audit[k]])),
        });
        return auditView(ctx, system, audit);
      });
    },

    async getIsoInternalAudit({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const { audit, system, reach } = await loadAudit(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoAudit.read', isoResource(ctx, 'internal_audit', reach));
        return auditView(ctx, system, audit);
      });
    },

    /**
     * While PLANNED or IN_PROGRESS. Moving its dates is a due-date change and a new lead auditor a reassignment, with
     * the body's reason; moving its units must cover the new ones too, and a row or finding on a unit it would drop
     * is moved first.
     */
    async updateIsoInternalAudit({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { audit, system, reach } = await loadAudit(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoAudit.plan', isoResource(ctx, 'internal_audit', reach));
        const { version, reason, ...fields } = body;
        checkVersion(audit, version);
        requireOpen(audit);
        if (fields.clauseIds !== undefined) {
          await checkClauses(
            tx,
            system.standardIds,
            fields.clauseIds,
            'clauseIds',
            'Not a clause of the management system',
          );
        }
        if (fields.unitIds !== undefined) {
          await core.checkSystemUnits(tx, system, fields.unitIds, 'unitIds');
          const units = fields.unitIds.length > 0 ? fields.unitIds : system.unitIds;
          if (units.length > 0) {
            const rows = [
              ...(await auditChecklistItems.forAudit(tx, audit.id)),
              ...(await auditFindings.forAudit(tx, { internalAuditId: audit.id })),
            ];
            if (rows.some((r) => r.unitId !== null && !units.includes(r.unitId))) {
              invalid(
                'unitIds',
                'A checklist row or finding of the audit is on a unit it would drop',
              );
            }
          }
          // The planner covers where the audit moves to, as well as where it was (ADR M16-0007).
          authorize(
            ctx,
            'isoAudit.plan',
            isoResource(ctx, 'internal_audit', planReach(system, fields.unitIds)),
          );
        }
        await checkPeople(tx, audit.clientId, fields, audit);
        const merged: InternalAudit = { ...audit, ...definedOf(fields) };
        checkPlan(merged);
        const updated = await core.edit(
          tx,
          ctx,
          audit,
          fields,
          'internal_audit',
          (changes) => internalAudits.update(tx, audit.id, version, changes as never),
          {
            split: {
              plannedStart: 'DUE_DATE_CHANGE',
              plannedEnd: 'DUE_DATE_CHANGE',
              leadAuditorId: 'REASSIGN',
            },
            reason: reason ?? null,
          },
        );
        return auditView(ctx, system, updated);
      });
    },

    /** START (lead auditor; an auditor or a manager as delegate): PLANNED → IN_PROGRESS. */
    startIsoInternalAudit: (call) =>
      auditStep(
        call,
        'START',
        async () => ({ facts: {}, change: {} }),
        (audit) => audit.leadAuditorId !== call.ctx.personId,
      ),

    /**
     * REPORT (lead auditor; an auditor or a manager as delegate): IN_PROGRESS → REPORTED, with a summary, at least one
     * person reported to, and an answered checklist row for every clause of the audit. `reportedOn` defaults to the
     * client's today and is not after it.
     */
    reportIsoInternalAudit: (call) => {
      const { ctx, body } = call;
      return auditStep(
        call,
        'REPORT',
        async (tx, audit) => {
          const today = await core.today(tx, audit.clientId);
          const reportedOn = body.reportedOn ?? today;
          if (body.reportedToIds !== undefined) {
            await checkPeople(tx, audit.clientId, { reportedToIds: body.reportedToIds }, audit);
          }
          const reportedToIds = body.reportedToIds ?? audit.reportedToIds;
          const items = await auditChecklistItems.forAudit(tx, audit.id);
          const answered = new Set(items.filter((i) => i.result !== null).map((i) => i.clauseId));
          return {
            facts: {
              summary: body.summary,
              reportedOn,
              asOf: today,
              reportedToCount: reportedToIds.length,
              unansweredClauseCount: audit.clauseIds.filter((id) => !answered.has(id)).length,
              notAuditedWithoutReasonCount: items.filter(
                (i) => i.result === 'NOT_AUDITED' && i.notAuditedReason === null,
              ).length,
            },
            change: {
              summary: body.summary,
              reportedOn,
              ...(body.reportedToIds === undefined ? {} : { reportedToIds }),
            },
          };
        },
        (audit) => audit.leadAuditorId !== ctx.personId,
      );
    },

    /**
     * CLOSE (lead auditor or client admin; an auditor, account admin or consultant as delegate): REPORTED → CLOSED
     * once every nonconformity its findings raised has left OPEN.
     */
    closeIsoInternalAudit: (call) =>
      auditStep(
        call,
        'CLOSE',
        async (tx, audit) => {
          let openNcCount = 0;
          for (const f of await auditFindings.forAudit(tx, { internalAuditId: audit.id })) {
            if (f.nonconformityId === null) continue;
            const nc = await nonconformities.get(tx, f.nonconformityId);
            if (nc?.state === 'OPEN') openNcCount += 1;
          }
          return { facts: { openNcCount }, change: {} };
        },
        (audit) =>
          audit.leadAuditorId !== call.ctx.personId && !isClientAdmin(call.ctx, audit.clientId),
      ),

    /** CANCEL (client admin; an account admin or consultant as delegate): PLANNED → CANCELLED, with a reason. */
    cancelIsoInternalAudit: (call) =>
      auditStep(
        call,
        'CANCEL',
        async () => ({
          facts: { reason: call.body.reason },
          change: { cancelReason: call.body.reason },
        }),
        (audit) => !isClientAdmin(call.ctx, audit.clientId),
      ),

    /** By clause (standard, then number), then by creation. Whoever reads the audit reads its checklist. */
    async listIsoAuditChecklist({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const { audit, system, reach } = await loadAudit(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoAudit.read', isoResource(ctx, 'audit_checklist_item', reach));
        const rank = new Map(
          (await isoCatalogue.clauses(tx, { standardIds: system.standardIds })).map((c, i) => [
            c.id,
            i,
          ]),
        );
        const at = (item: AuditChecklistItem) => rank.get(item.clauseId) ?? Number.MAX_SAFE_INTEGER;
        const items = (await auditChecklistItems.forAudit(tx, audit.id)).sort(
          (a, b) => at(a) - at(b) || byCreation(a, b),
        );
        return { items };
      });
    },

    /** A row for one of the audit's clauses, optionally on one of its units, while PLANNED or IN_PROGRESS. */
    async createIsoAuditChecklistItem({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { audit, system, reach } = await loadAudit(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoAudit.conduct', conductOn(ctx, 'audit_checklist_item', audit, reach));
        requireOpen(audit);
        if (!audit.clauseIds.includes(body.clauseId)) {
          invalid('clauseId', 'Not a clause of this audit: add it to the audit first');
        }
        await checkAuditUnit(tx, system, audit, body.unitId);
        const item = await auditChecklistItems.create(tx, {
          clientId: audit.clientId,
          internalAuditId: audit.id,
          clauseId: body.clauseId,
          unitId: body.unitId,
          question: body.question,
          auditorNote: null,
          result: null,
          findingId: null,
          notAuditedReason: null,
        });
        await core.audit(tx, ctx, audit.clientId, {
          action: 'CREATE',
          entityType: 'audit_checklist_item',
          entityId: item.id,
          after: {
            internalAuditId: audit.id,
            clauseId: item.clauseId,
            unitId: item.unitId,
            question: item.question,
          },
        });
        return item;
      });
    },

    /**
     * Answers or changes a row while the audit is PLANNED or IN_PROGRESS. A FINDING result links a finding of this
     * audit; NOT_AUDITED needs its reason. Moving away from either clears the link or the reason.
     */
    async updateIsoAuditChecklistItem({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { audit, system, reach } = await loadAudit(tx, ctx, params.clientId!, params.id!);
        const item = await loadItem(tx, audit, params.itemId!);
        authorize(ctx, 'isoAudit.conduct', conductOn(ctx, 'audit_checklist_item', audit, reach));
        const { version, ...fields } = body;
        checkVersion(item, version);
        requireOpen(audit);
        await checkAuditUnit(tx, system, audit, fields.unitId);
        const result = fields.result === undefined ? item.result : fields.result;
        let findingId = fields.findingId === undefined ? item.findingId : fields.findingId;
        let notAuditedReason =
          fields.notAuditedReason === undefined ? item.notAuditedReason : fields.notAuditedReason;
        if (result !== 'FINDING') {
          if (fields.findingId != null) invalid('findingId', 'Only a FINDING row links a finding');
          findingId = null;
        } else if (findingId === null) {
          invalid('findingId', 'A FINDING row links its finding');
        } else if (findingId !== item.findingId) {
          const finding = await auditFindings.get(tx, findingId);
          if (
            finding === null ||
            finding.archivedAt !== null ||
            finding.internalAuditId !== audit.id
          ) {
            invalid('findingId', 'Not a finding of this audit');
          }
        }
        if (result !== 'NOT_AUDITED') {
          if (fields.notAuditedReason != null) {
            invalid('notAuditedReason', 'Only a NOT_AUDITED row has a reason');
          }
          notAuditedReason = null;
        } else if (notAuditedReason === null) {
          invalid('notAuditedReason', 'A NOT_AUDITED row has a reason');
        }
        return core.edit(
          tx,
          ctx,
          item,
          {
            question: fields.question,
            unitId: fields.unitId,
            auditorNote: fields.auditorNote,
            result,
            findingId,
            notAuditedReason,
          },
          'audit_checklist_item',
          (changes) => auditChecklistItems.update(tx, item.id, version, changes),
        );
      });
    },

    /** In the order they were recorded. Whoever reads the audit reads its findings. */
    async listIsoInternalFindings({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const { audit, reach } = await loadAudit(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoAudit.read', isoResource(ctx, 'audit_finding', reach));
        return { items: await auditFindings.forAudit(tx, { internalAuditId: audit.id }) };
      });
    },

    /**
     * Records a finding while the audit is IN_PROGRESS. A MAJOR_NC or MINOR_NC raises its nonconformity in the same
     * step (model §3.9): source INTERNAL_AUDIT, severity from the type, the finding's clauses and unit (or the audit's
     * single unit), standards from its clauses (else the audit's, else the system's). With `checklistItemId`, the row
     * is marked FINDING and linked, and a finding given no clauses or unit takes the row's.
     */
    async createIsoInternalFinding({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { audit, system, reach } = await loadAudit(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoAudit.conduct', conductOn(ctx, 'audit_finding', audit, reach));
        requireInProgress(audit);
        let item: AuditChecklistItem | undefined;
        if (body.checklistItemId !== undefined) {
          const row = await auditChecklistItems.get(tx, body.checklistItemId);
          if (row === null || row.archivedAt !== null || row.internalAuditId !== audit.id) {
            invalid('checklistItemId', 'Not a checklist row of this audit');
          }
          if (row.findingId !== null) {
            invalid('checklistItemId', 'This checklist row already links a finding');
          }
          item = row;
        }
        const clauseIds =
          body.clauseIds.length === 0 && item !== undefined ? [item.clauseId] : body.clauseIds;
        const unitId = body.unitId ?? item?.unitId ?? null;
        await checkClauses(
          tx,
          system.standardIds,
          clauseIds,
          'clauseIds',
          'Not a clause of the management system',
        );
        await checkAuditUnit(tx, system, audit, unitId);
        const finding: AuditFinding = await recordFinding(core, tx, ctx, system, {
          audit: { internalAuditId: audit.id },
          type: body.type,
          clauseIds,
          unitId,
          description: body.description,
          ...(body.nonconformity === undefined
            ? {}
            : {
                nc: {
                  body: body.nonconformity,
                  source: 'INTERNAL_AUDIT',
                  unitId: unitId ?? (reach.unitIds.length === 1 ? reach.unitIds[0]! : null),
                  standards: await standardsOf(
                    tx,
                    clauseIds.length > 0 ? clauseIds : audit.clauseIds,
                    system.standardIds,
                  ),
                },
              }),
        });
        if (item !== undefined) {
          const row = item;
          await core.edit(
            tx,
            ctx,
            row,
            { result: 'FINDING', findingId: finding.id, notAuditedReason: null },
            'audit_checklist_item',
            (changes) => auditChecklistItems.update(tx, row.id, row.version, changes),
          );
        }
        return finding;
      });
    },

    /** Changes a finding while its audit is IN_PROGRESS (the type rules are `editFinding`'s). */
    async updateIsoInternalFinding({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { audit, system, reach } = await loadAudit(tx, ctx, params.clientId!, params.id!);
        const finding = await loadFinding(tx, audit, params.findingId!);
        authorize(ctx, 'isoAudit.conduct', conductOn(ctx, 'audit_finding', audit, reach));
        const { version, ...fields } = body;
        checkVersion(finding, version);
        requireInProgress(audit);
        if (fields.clauseIds !== undefined) {
          await checkClauses(
            tx,
            system.standardIds,
            fields.clauseIds,
            'clauseIds',
            'Not a clause of the management system',
          );
        }
        await checkAuditUnit(tx, system, audit, fields.unitId);
        return editFinding(core, tx, ctx, finding, fields, version, 'isoAudit.conduct');
      });
    },
  };
}
