// Mock handlers for the ISO add-on: Audit programmes, internal audits, their checklists and findings (model §3.7, §3.9, §4.3).
// The server answers 403 FEATURE_NOT_ENABLED or 409 FEATURE_NOT_READY before any of these run.
import type { z } from 'zod';
import type { AuditProgrammeView, InternalAuditView } from '../../../api/iso.js';
import { IsoStandardCode, type Role } from '../../../enums.js';
import { type InternalAuditAction, NC_FINDING_TYPES, selfAuditors } from '../../../schemas/iso.js';
import type { IdCount } from '../../../schemas/iso-results.js';
import { type Actor, MockError, matches, notFound, paginate } from '../../core.js';
import { actorOf, type PartialHandlers } from '../../handler.js';
import {
  canSee,
  checkIsoPerson,
  checkIsoVersion,
  checkSystemClauses,
  checkSystemUnits,
  clauseOf,
  forbidden,
  holdsRole,
  invalid,
  invalidTransition,
  isClientAdmin,
  type IsoCtx,
  isoAudit,
  isoFresh,
  type IsoReach,
  isoScope,
  liveIso,
  patchIso,
  reachOf,
  requireIso,
  requireSystem,
  selfScope,
  standardOf,
  systemUnitIds,
  touchIso,
} from '../../iso/common.js';
import { uncoveredByAudits } from '../../iso/derive.js';
import type { FirmState, AuditRecord, IsoRow } from '../../store.js';
import { patchIsoUnrecorded } from './nonconformities.js';

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

type System = IsoRow<'managementSystems'>;
type Programme = IsoRow<'auditProgrammes'>;
type Audit = IsoRow<'internalAudits'>;
type Item = IsoRow<'auditChecklistItems'>;
type Finding = IsoRow<'findings'>;
type Nonconformity = IsoRow<'nonconformities'>;
type Clause = FirmState['isoCatalogue']['clauses'][number];
type ProgrammeOut = z.input<typeof AuditProgrammeView>;
type AuditOut = z.input<typeof InternalAuditView>;
type Count = z.input<typeof IdCount>;
type FindingType = Finding['type'];

const MANAGERS: readonly Role[] = ['FIRM_ADMIN', 'CONSULTANT', 'CLIENT_ADMIN'];
/** Audit states whose checklist rows count towards coverage (model §5.1). */
const REPORTED: readonly Audit['state'][] = ['REPORTED', 'CLOSED'];
/** States in which the audit's plan and checklist may change; later ones lock them (model §6). */
const OPEN: readonly Audit['state'][] = ['PLANNED', 'IN_PROGRESS'];
/** Finding types that may change into one another (FindingUpdateBody). */
const NON_NC_TYPES: readonly FindingType[] = ['OBSERVATION', 'OFI', 'GOOD_PRACTICE'];
const NC_TYPES: readonly FindingType[] = NC_FINDING_TYPES;

// ---------- lookups and reach ----------

/** The audit's programme. Programmes have no archive route, so an audit's programme always exists. */
const programmeOf = (firm: FirmState, audit: Audit): Programme =>
  firm.iso.auditProgrammes.find((p) => p.id === audit.programmeId)!;

/** The programme's management system (archived or not: its records keep their units). */
const systemOf = (firm: FirmState, programme: Programme): System =>
  firm.iso.managementSystems.find((s) => s.id === programme.managementSystemId)!;

/** Everyone named on an audit, who always sees it (plan §3.3). */
const auditPeople = (audit: Audit): string[] => [
  audit.leadAuditorId,
  ...audit.auditorIds,
  ...audit.auditeeIds,
  ...audit.reportedToIds,
];

/** The lead auditor and the auditors: "own" for `isoAudit.conduct` (plan §3.2). */
const auditTeam = (audit: Audit): string[] => [audit.leadAuditorId, ...audit.auditorIds];

/** A programme takes its management system's units and names nobody. */
const programmeReach = (firm: FirmState, programme: Programme): IsoReach =>
  reachOf(firm, { clientId: programme.clientId, systemId: programme.managementSystemId });

/**
 * An audit's units (its list, else its system's), and the people it names. Its checklist rows and findings take the
 * same reach (a child record takes its parent's units, plan §3.3).
 */
const auditReach = (firm: FirmState, audit: Audit): IsoReach =>
  reachOf(firm, {
    clientId: audit.clientId,
    unitIds: audit.unitIds,
    systemId: programmeOf(firm, audit).managementSystemId,
    people: auditPeople(audit),
  });

const requireAudit = (actor: Actor, clientId: string | undefined, id: string | undefined) =>
  requireIso(actor.firm, 'internalAudits', clientId!, id!);

/** A checklist row of `audit`, or 404 (another audit's row included). */
function requireItem(firm: FirmState, audit: Audit, id: string | undefined): Item {
  const item = requireIso(firm, 'auditChecklistItems', audit.clientId, id!);
  if (item.internalAuditId !== audit.id) throw notFound();
  return item;
}

/** A finding of `audit`, or 404 (another audit's finding included). */
function requireFinding(firm: FirmState, audit: Audit, id: string | undefined): Finding {
  const finding = requireIso(firm, 'findings', audit.clientId, id!);
  if (finding.internalAuditId !== audit.id) throw notFound();
  return finding;
}

const itemsOf = (firm: FirmState, audit: Audit) =>
  liveIso(firm, 'auditChecklistItems', audit.clientId).filter(
    (i) => i.internalAuditId === audit.id,
  );

const findingsOf = (firm: FirmState, audit: Audit) =>
  liveIso(firm, 'findings', audit.clientId).filter((f) => f.internalAuditId === audit.id);

// ---------- order ----------

const codeRank = (firm: FirmState, standardId: string) =>
  IsoStandardCode.options.indexOf(standardOf(firm, standardId)?.code as IsoStandardCode);

/** Clause numbers in document order: "4.10" after "4.9", "8" before "8.1". */
function compareNumbers(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** Clauses by standard (9001, 14001, 45001), then number. */
const compareClauses = (firm: FirmState, a: Clause, b: Clause) =>
  codeRank(firm, a.standardId) - codeRank(firm, b.standardId) || compareNumbers(a.number, b.number);

/** By creation; rows created in the same instant keep the order they were stored in (the sort is stable). */
const byCreation = (a: { createdAt: string }, b: { createdAt: string }) =>
  a.createdAt.localeCompare(b.createdAt);

// ---------- views ----------

const idCount = (ids: string[]): Count => ({ count: ids.length, ids });

/**
 * `auditProgrammeCoverage` (model §5.1): a clause is covered when a checklist row of a REPORTED or CLOSED audit of the
 * programme names it with CONFORMS or FINDING; a unit when such a row names it, or the row has no unit and its audit
 * lists the unit. Clauses that need coverage are the system's assessable clauses without an approved N/A; units are
 * the system's listed units. The counts are of the audits the actor may see, as on the overview.
 */
function coverage(actor: Actor, programme: Programme): ProgrammeOut['coverage'] {
  const firm = actor.firm;
  const system = systemOf(firm, programme);
  const audits = liveIso(firm, 'internalAudits', programme.clientId).filter(
    (a) => a.programmeId === programme.id,
  );
  const excluded = new Set(
    liveIso(firm, 'clauseAssessments', programme.clientId)
      .filter((a) => a.managementSystemId === system.id && a.naState === 'APPROVED')
      .map((a) => a.clauseId),
  );
  const needed = firm.isoCatalogue.clauses
    .filter(
      (c) =>
        c.archivedAt === null &&
        c.assessable &&
        system.standardIds.includes(c.standardId) &&
        !(c.exclusionAllowed && excluded.has(c.id)),
    )
    .sort((a, b) => compareClauses(firm, a, b));
  const gap = uncoveredByAudits(
    audits,
    liveIso(firm, 'auditChecklistItems', programme.clientId),
    needed.map((c) => c.id),
    system.unitIds,
  );
  const visible = audits.filter((a) => canSee(actor, auditReach(firm, a)));
  return {
    fy: programme.fy,
    uncoveredClauseIds: gap.clauseIds,
    uncoveredUnitIds: gap.unitIds,
    planned: idCount(visible.filter((a) => a.state !== 'CANCELLED').map((a) => a.id)),
    reported: idCount(visible.filter((a) => REPORTED.includes(a.state)).map((a) => a.id)),
    cancelled: idCount(visible.filter((a) => a.state === 'CANCELLED').map((a) => a.id)),
  };
}

const programmeView = (actor: Actor, programme: Programme): ProgrammeOut => ({
  ...programme,
  coverage: coverage(actor, programme),
});

/** The roles that hold a unit list must cover the record's units, unless it names the actor (plan §3.3). */
const unitsFor = (actor: Actor, reach: IsoReach) =>
  reach.people.includes(actor.person.id) ? undefined : reach.unitIds;

/** FA, CO or CA within the audit's reach: `isoAudit.plan`, and `isoAudit.conduct` as delegate (plan §3.2). */
const managesAudit = (actor: Actor, audit: Audit, reach: IsoReach) =>
  holdsRole(actor, audit.clientId, MANAGERS, unitsFor(actor, reach));

/** `isoAudit.conduct`: a manager, or an approver or owner who is the lead auditor or an auditor (plan §3.2). */
const conductsAudit = (actor: Actor, audit: Audit, reach: IsoReach) =>
  managesAudit(actor, audit, reach) ||
  (auditTeam(audit).includes(actor.person.id) &&
    holdsRole(actor, audit.clientId, ['APPROVER', 'OWNER']));

function auditView(actor: Actor, audit: Audit): AuditOut {
  const firm = actor.firm;
  const reach = auditReach(firm, audit);
  const conducts = conductsAudit(actor, audit, reach);
  const allowedActions: AuditOut['allowedActions'] = [];
  if (audit.state === 'PLANNED') {
    if (conducts) allowedActions.push('START');
    if (managesAudit(actor, audit, reach)) allowedActions.push('CANCEL');
  }
  if (audit.state === 'IN_PROGRESS' && conducts) allowedActions.push('REPORT');
  if (audit.state === 'REPORTED' && conducts) allowedActions.push('CLOSE');
  return {
    ...audit,
    managementSystemId: programmeOf(firm, audit).managementSystemId,
    allowedActions,
  };
}

// ---------- checks ----------

/** A field edit or a new or changed checklist row or finding on a REPORTED, CLOSED or CANCELLED audit (model §6). */
function requireOpen(audit: Audit): void {
  if (!OPEN.includes(audit.state)) invalidTransition('internal_audit', audit.state, 'UPDATE');
}

/** Findings are recorded and changed while the audit is IN_PROGRESS. */
function requireInProgress(audit: Audit): void {
  if (audit.state !== 'IN_PROGRESS') invalidTransition('internal_audit', audit.state, 'UPDATE');
}

/** A row's or finding's unit is one of the audit's units (its list, else its system's). */
function checkAuditUnit(reach: IsoReach, unitId: string | null | undefined, path: string): void {
  if (unitId != null && !reach.unitIds.includes(unitId)) {
    invalid(path, 'Not a unit of this audit');
  }
}

/**
 * Who an audit names must work in its client (model §1.5): auditors and auditees with the owner role or above, and the
 * people it is reported to. Auditors often come from another unit (that is their independence), so no unit is checked.
 */
function checkAuditPeople(
  actor: Actor,
  clientId: string,
  people: {
    leadAuditorId?: string;
    auditorIds?: readonly string[];
    auditeeIds?: readonly string[];
    reportedToIds?: readonly string[];
  },
): void {
  if (people.leadAuditorId !== undefined) {
    checkIsoPerson(actor, clientId, people.leadAuditorId, 'leadAuditorId');
  }
  for (const field of ['auditorIds', 'auditeeIds', 'reportedToIds'] as const) {
    for (const id of people[field] ?? []) checkIsoPerson(actor, clientId, id, field);
  }
}

/** The stored audit's own rules on the merged plan: dates in order, the lead not listed again, independence (9.2.2). */
function checkPlan(audit: Audit): void {
  if (audit.plannedEnd < audit.plannedStart)
    invalid('plannedEnd', 'The audit ends after it starts');
  if (audit.auditorIds.includes(audit.leadAuditorId)) {
    invalid('auditorIds', 'The lead auditor is not listed again');
  }
  if (selfAuditors(audit).length > 0 && audit.independenceNote === null) {
    invalid('independenceNote', 'An auditor who is also an auditee needs an independence note');
  }
}

function invalidAt(path: string[], message: string): never {
  throw new MockError('VALIDATION', message, { issues: [{ path: ['body', ...path], message }] });
}

/**
 * The nonconformity's owner and approver work in the client and cover its unit (model §1.5), in a role that can take
 * their steps (plan §3.2 `isoNc.work` and `isoNc.verify`): an owner or client admin, an approver or client admin.
 */
function checkNcPerson(
  actor: Actor,
  clientId: string,
  personId: string,
  field: 'ownerId' | 'approverId',
  unitId: string | null,
): void {
  const roles: Role[] = [field === 'ownerId' ? 'OWNER' : 'APPROVER', 'CLIENT_ADMIN'];
  try {
    checkIsoPerson(actor, clientId, personId, field, { unitId, roles });
  } catch {
    invalidAt(
      ['nonconformity', field],
      `Not ${field === 'ownerId' ? 'an owner' : 'an approver'} of this client and unit`,
    );
  }
}

/** Standards of the clauses given, else of the audit's clauses, else the system's; in code order. */
function ncStandards(
  firm: FirmState,
  system: System,
  audit: Audit,
  clauseIds: readonly string[],
): IsoStandardCode[] {
  const standardsOf = (ids: readonly string[]) =>
    ids.map((id) => clauseOf(firm, id)?.standardId).filter((s): s is string => s !== undefined);
  const fromFinding = standardsOf(clauseIds);
  const fromAudit = standardsOf(audit.clauseIds);
  const ids =
    fromFinding.length > 0
      ? fromFinding
      : fromAudit.length > 0
        ? fromAudit
        : [...system.standardIds];
  const codes = new Set(ids.map((id) => standardOf(firm, id)?.code));
  return IsoStandardCode.options.filter((code) => codes.has(code));
}

/** The next nonconformity number of the client (a per-client sequence from 1, archived rows included). */
const nextNcNumber = (firm: FirmState, clientId: string) =>
  firm.iso.nonconformities
    .filter((n) => n.clientId === clientId)
    .reduce((max, n) => Math.max(max, n.number), 0) + 1;

// ---------- writes ----------

/** Applies an arrow of the internal-audit machine (model §4.3) and audits it as a TRANSITION naming the action. */
function moveAudit(
  ctx: IsoCtx,
  actor: Actor,
  audit: Audit,
  action: InternalAuditAction,
  change: Partial<Audit>,
  options: { reason?: string; delegated: boolean },
): void {
  const keys = Object.keys(change) as (keyof Audit)[];
  const before = Object.fromEntries(keys.map((k) => [k, audit[k]]));
  Object.assign(audit, change);
  touchIso(ctx, audit);
  isoAudit(ctx, actor, {
    action: 'TRANSITION',
    entityType: 'internal_audit',
    entityId: audit.id,
    clientId: audit.clientId,
    before,
    after: { action, ...change },
    reason: options.reason ?? null,
    ...(options.delegated ? { delegated: true } : {}),
  });
}

/** The fields of a planned audit, as its CREATE event records them. */
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
] as const satisfies readonly (keyof Audit)[];

/**
 * Audit groups of an audit edit (model §8): moving its dates is a due-date change (with the reason), a new lead auditor
 * a reassignment, and changes to its title, clauses, units, people lists and note an UPDATE.
 */
const EDIT_GROUPS: [AuditRecord['action'], (keyof Audit)[]][] = [
  ['DUE_DATE_CHANGE', ['plannedStart', 'plannedEnd']],
  ['REASSIGN', ['leadAuditorId']],
  [
    'UPDATE',
    [
      'title',
      'clauseIds',
      'unitIds',
      'auditorIds',
      'auditeeIds',
      'reportedToIds',
      'independenceNote',
    ],
  ],
];

// ---------- handlers ----------

export const auditsHandlers: PartialHandlers<Ids> = {
  /** Newest FY first, then by creation. AP and OW see the programmes of systems covering their units. */
  listIsoAuditProgrammes(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const q = ctx.query;
    const rows = liveIso(actor.firm, 'auditProgrammes', clientId)
      .filter(
        (p) =>
          (q.managementSystemId === undefined ||
            q.managementSystemId.includes(p.managementSystemId)) &&
          (q.fy === undefined || p.fy === q.fy) &&
          canSee(actor, programmeReach(actor.firm, p)),
      )
      .sort((a, b) => b.fy.localeCompare(a.fy) || byCreation(a, b));
    return paginate(
      rows.map((p) => programmeView(actor, p)),
      q,
    );
  },

  /** One programme per system and FY (409 DUPLICATE otherwise). */
  createIsoAuditProgramme(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    const body = ctx.body;
    const system = requireSystem(actor.firm, clientId, body.managementSystemId);
    ctx.authorize(isoScope(actor, reachOf(actor.firm, { clientId, systemId: system.id })));
    const clash = liveIso(actor.firm, 'auditProgrammes', clientId).find(
      (p) => p.managementSystemId === system.id && p.fy === body.fy,
    );
    if (clash !== undefined) {
      throw new MockError('DUPLICATE', `This system already has a programme for ${body.fy}`, {
        field: 'fy',
        existingId: clash.id,
      });
    }
    const programme: Programme = {
      ...isoFresh(ctx, actor, clientId),
      managementSystemId: system.id,
      fy: body.fy,
      notes: body.notes,
    };
    actor.firm.iso.auditProgrammes.push(programme);
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'audit_programme',
      entityId: programme.id,
      clientId,
      after: { managementSystemId: system.id, fy: programme.fy, notes: programme.notes },
    });
    return programmeView(actor, programme);
  },

  updateIsoAuditProgramme(ctx) {
    const actor = actorOf(ctx);
    const programme = requireIso(
      actor.firm,
      'auditProgrammes',
      ctx.params.clientId!,
      ctx.params.id!,
    );
    ctx.authorize(isoScope(actor, programmeReach(actor.firm, programme)));
    patchIso(ctx, actor, programme, ctx.body.version, { notes: ctx.body.notes }, 'audit_programme');
    return programmeView(actor, programme);
  },

  /** By planned start, then title. AP and OW see audits over their units and those that name them. */
  listIsoInternalAudits(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const q = ctx.query;
    const leadAuditorId = q.leadAuditorId === 'me' ? actor.person.id : q.leadAuditorId;
    const rows = liveIso(actor.firm, 'internalAudits', clientId)
      .filter((a) => {
        const reach = auditReach(actor.firm, a);
        return (
          (q.managementSystemId === undefined ||
            q.managementSystemId.includes(programmeOf(actor.firm, a).managementSystemId)) &&
          (q.programmeId === undefined || q.programmeId.includes(a.programmeId)) &&
          (q.state === undefined || q.state.includes(a.state)) &&
          (q.unitId === undefined || reach.unitIds.some((u) => q.unitId!.includes(u))) &&
          (leadAuditorId === undefined || a.leadAuditorId === leadAuditorId) &&
          (q.from === undefined || a.plannedStart >= q.from) &&
          (q.to === undefined || a.plannedStart <= q.to) &&
          matches(q.q, a.title, a.summary) &&
          canSee(actor, reach)
        );
      })
      .sort(
        (a, b) =>
          a.plannedStart.localeCompare(b.plannedStart) ||
          a.title.localeCompare(b.title) ||
          byCreation(a, b),
      );
    return paginate(
      rows.map((a) => auditView(actor, a)),
      q,
    );
  },

  /** PLAN: an audit in a programme, over units and clauses of its system, with an independence note where needed. */
  createIsoInternalAudit(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    const body = ctx.body;
    const programme = requireIso(actor.firm, 'auditProgrammes', clientId, body.programmeId);
    const system = requireSystem(actor.firm, clientId, programme.managementSystemId);
    ctx.authorize(
      isoScope(
        actor,
        reachOf(actor.firm, { clientId, unitIds: body.unitIds, systemId: system.id }),
      ),
    );
    checkSystemClauses(actor.firm, system, body.clauseIds, 'clauseIds');
    checkSystemUnits(actor.firm, system, body.unitIds, 'unitIds');
    checkAuditPeople(actor, clientId, body);
    const audit: Audit = {
      ...isoFresh(ctx, actor, clientId),
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
      state: 'PLANNED',
      summary: null,
      reportedOn: null,
      cancelReason: null,
    };
    checkPlan(audit);
    actor.firm.iso.internalAudits.push(audit);
    // The independence note goes into the audit event as well as the record (model §3.7).
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'internal_audit',
      entityId: audit.id,
      clientId,
      after: Object.fromEntries(PLAN_FIELDS.map((k) => [k, audit[k]])),
    });
    return auditView(actor, audit);
  },

  getIsoInternalAudit(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, auditReach(actor.firm, audit)));
    return auditView(actor, audit);
  },

  /** While PLANNED or IN_PROGRESS. Moving its dates is a due-date change with the body's reason. */
  updateIsoInternalAudit(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, auditReach(actor.firm, audit)));
    const { version, reason, ...fields } = ctx.body;
    checkIsoVersion(audit, version);
    requireOpen(audit);
    const system = systemOf(actor.firm, programmeOf(actor.firm, audit));
    if (fields.clauseIds !== undefined) {
      checkSystemClauses(actor.firm, system, fields.clauseIds, 'clauseIds');
    }
    if (fields.unitIds !== undefined) {
      checkSystemUnits(actor.firm, system, fields.unitIds, 'unitIds');
      // Rows and findings name units of the audit; one the audit would no longer cover is moved first.
      const units = fields.unitIds.length > 0 ? fields.unitIds : systemUnitIds(actor.firm, system);
      const stranded = [...itemsOf(actor.firm, audit), ...findingsOf(actor.firm, audit)].some(
        (r) => r.unitId !== null && !units.includes(r.unitId),
      );
      if (stranded) {
        invalid('unitIds', 'A checklist row or finding of the audit is on a unit it would drop');
      }
    }
    checkAuditPeople(actor, audit.clientId, fields);
    const defined = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined),
    ) as Partial<Audit>;
    const merged: Audit = { ...audit, ...defined };
    checkPlan(merged);
    const changed = (Object.keys(defined) as (keyof Audit)[]).filter(
      (k) => JSON.stringify(audit[k]) !== JSON.stringify(merged[k]),
    );
    if (changed.length === 0) return auditView(actor, audit);
    const before = Object.fromEntries(changed.map((k) => [k, audit[k]]));
    Object.assign(audit, defined);
    touchIso(ctx, audit);
    for (const [action, keys] of EDIT_GROUPS) {
      const inGroup = changed.filter((k) => keys.includes(k));
      if (inGroup.length === 0) continue;
      isoAudit(ctx, actor, {
        action,
        entityType: 'internal_audit',
        entityId: audit.id,
        clientId: audit.clientId,
        before: Object.fromEntries(inGroup.map((k) => [k, before[k]])),
        after: Object.fromEntries(inGroup.map((k) => [k, audit[k]])),
        reason: action === 'UPDATE' ? null : (reason ?? null),
      });
    }
    return auditView(actor, audit);
  },

  /** START (lead auditor; an auditor or a manager as delegate): PLANNED → IN_PROGRESS. */
  startIsoInternalAudit(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(selfScope(actor, auditReach(actor.firm, audit), auditTeam(audit)));
    checkIsoVersion(audit, ctx.body.version);
    if (audit.state !== 'PLANNED') invalidTransition('internal_audit', audit.state, 'START');
    moveAudit(
      ctx,
      actor,
      audit,
      'START',
      { state: 'IN_PROGRESS' },
      {
        delegated: actor.person.id !== audit.leadAuditorId,
      },
    );
    return auditView(actor, audit);
  },

  /**
   * REPORT (lead auditor; an auditor or a manager as delegate): IN_PROGRESS → REPORTED, with a summary, at least one
   * person reported to, and an answered checklist row for every clause of the audit. `reportedOn` is not after today.
   */
  reportIsoInternalAudit(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(selfScope(actor, auditReach(actor.firm, audit), auditTeam(audit)));
    const body = ctx.body;
    checkIsoVersion(audit, body.version);
    if (audit.state !== 'IN_PROGRESS') invalidTransition('internal_audit', audit.state, 'REPORT');
    const today = ctx.clock.today();
    const reportedOn = body.reportedOn ?? today;
    if (reportedOn > today) invalid('reportedOn', 'The report date is after today');
    if (body.reportedToIds !== undefined) {
      checkAuditPeople(actor, audit.clientId, { reportedToIds: body.reportedToIds });
    }
    const reportedToIds = body.reportedToIds ?? audit.reportedToIds;
    if (reportedToIds.length === 0) {
      invalid('reportedToIds', 'Name who the results are reported to');
    }
    const answered = new Set(
      itemsOf(actor.firm, audit)
        .filter((i) => i.result !== null)
        .map((i) => i.clauseId),
    );
    const missing = audit.clauseIds
      .filter((id) => !answered.has(id))
      .map((id) => clauseOf(actor.firm, id)?.number ?? id);
    if (missing.length > 0) {
      invalid('checklist', `Answer a checklist row for clause ${missing.join(', ')}`);
    }
    moveAudit(
      ctx,
      actor,
      audit,
      'REPORT',
      {
        state: 'REPORTED',
        summary: body.summary,
        reportedOn,
        ...(body.reportedToIds === undefined ? {} : { reportedToIds }),
      },
      { delegated: actor.person.id !== audit.leadAuditorId },
    );
    return auditView(actor, audit);
  },

  /**
   * CLOSE (lead auditor or client admin; an auditor, account admin or consultant as delegate): REPORTED → CLOSED once
   * every nonconformity its findings raised has left OPEN.
   */
  closeIsoInternalAudit(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(selfScope(actor, auditReach(actor.firm, audit), auditTeam(audit)));
    checkIsoVersion(audit, ctx.body.version);
    if (audit.state !== 'REPORTED') invalidTransition('internal_audit', audit.state, 'CLOSE');
    const raised = new Set(
      findingsOf(actor.firm, audit)
        .map((f) => f.nonconformityId)
        .filter((id): id is string => id !== null),
    );
    const open = actor.firm.iso.nonconformities.filter(
      (n) => raised.has(n.id) && n.state === 'OPEN',
    );
    if (open.length > 0) {
      invalid(
        'nonconformities',
        `Every nonconformity the audit raised leaves OPEN first; still OPEN: ${open.map((n) => n.number).join(', ')}`,
      );
    }
    moveAudit(
      ctx,
      actor,
      audit,
      'CLOSE',
      { state: 'CLOSED' },
      {
        delegated: actor.person.id !== audit.leadAuditorId && !isClientAdmin(actor, audit.clientId),
      },
    );
    return auditView(actor, audit);
  },

  /** CANCEL (client admin; an account admin or consultant as delegate): PLANNED → CANCELLED, with a reason. */
  cancelIsoInternalAudit(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, auditReach(actor.firm, audit)));
    checkIsoVersion(audit, ctx.body.version);
    if (audit.state !== 'PLANNED') invalidTransition('internal_audit', audit.state, 'CANCEL');
    moveAudit(
      ctx,
      actor,
      audit,
      'CANCEL',
      { state: 'CANCELLED', cancelReason: ctx.body.reason },
      { reason: ctx.body.reason, delegated: !isClientAdmin(actor, audit.clientId) },
    );
    return auditView(actor, audit);
  },

  /** By clause (standard, then number), then by creation. Whoever reads the audit reads its checklist. */
  listIsoAuditChecklist(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, auditReach(actor.firm, audit)));
    const firm = actor.firm;
    const clauseOfItem = (item: Item) => clauseOf(firm, item.clauseId)!;
    const items = itemsOf(firm, audit).sort(
      (a, b) => compareClauses(firm, clauseOfItem(a), clauseOfItem(b)) || byCreation(a, b),
    );
    return { items };
  },

  /** A row for one of the audit's clauses, optionally on one of its units, while PLANNED or IN_PROGRESS. */
  createIsoAuditChecklistItem(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    const reach = auditReach(actor.firm, audit);
    ctx.authorize(selfScope(actor, reach, auditTeam(audit)));
    requireOpen(audit);
    const body = ctx.body;
    if (!audit.clauseIds.includes(body.clauseId)) {
      invalid('clauseId', 'Not a clause of this audit: add it to the audit first');
    }
    checkAuditUnit(reach, body.unitId, 'unitId');
    const item: Item = {
      ...isoFresh(ctx, actor, audit.clientId),
      internalAuditId: audit.id,
      clauseId: body.clauseId,
      unitId: body.unitId,
      question: body.question,
      auditorNote: null,
      result: null,
      findingId: null,
      notAuditedReason: null,
    };
    actor.firm.iso.auditChecklistItems.push(item);
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'audit_checklist_item',
      entityId: item.id,
      clientId: item.clientId,
      after: {
        internalAuditId: audit.id,
        clauseId: item.clauseId,
        unitId: item.unitId,
        question: item.question,
      },
    });
    return item;
  },

  /**
   * Answers or changes a row while the audit is PLANNED or IN_PROGRESS. A FINDING result links a finding of this audit;
   * NOT_AUDITED needs its reason. Moving away from either clears the link or the reason.
   */
  updateIsoAuditChecklistItem(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    const item = requireItem(actor.firm, audit, ctx.params.itemId);
    const reach = auditReach(actor.firm, audit);
    ctx.authorize(selfScope(actor, reach, auditTeam(audit)));
    const { version, ...fields } = ctx.body;
    checkIsoVersion(item, version);
    requireOpen(audit);
    checkAuditUnit(reach, fields.unitId, 'unitId');
    const result = fields.result === undefined ? item.result : fields.result;
    let findingId = fields.findingId === undefined ? item.findingId : fields.findingId;
    let notAuditedReason =
      fields.notAuditedReason === undefined ? item.notAuditedReason : fields.notAuditedReason;
    if (result !== 'FINDING') {
      if (fields.findingId != null) invalid('findingId', 'Only a FINDING row links a finding');
      findingId = null;
    } else if (findingId === null) {
      invalid('findingId', 'A FINDING row links its finding');
    } else if (!findingsOf(actor.firm, audit).some((f) => f.id === findingId)) {
      invalid('findingId', 'Not a finding of this audit');
    }
    if (result !== 'NOT_AUDITED') {
      if (fields.notAuditedReason != null) {
        invalid('notAuditedReason', 'Only a NOT_AUDITED row has a reason');
      }
      notAuditedReason = null;
    } else if (notAuditedReason === null) {
      invalid('notAuditedReason', 'A NOT_AUDITED row has a reason');
    }
    patchIso(
      ctx,
      actor,
      item,
      version,
      {
        question: fields.question,
        unitId: fields.unitId,
        auditorNote: fields.auditorNote,
        result,
        findingId,
        notAuditedReason,
      },
      'audit_checklist_item',
    );
    return item;
  },

  /** In the order they were recorded. Whoever reads the audit reads its findings. */
  listIsoInternalFindings(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, auditReach(actor.firm, audit)));
    return { items: findingsOf(actor.firm, audit).sort(byCreation) };
  },

  /**
   * Records a finding while the audit is IN_PROGRESS. A MAJOR_NC or MINOR_NC raises its nonconformity in the same step
   * (model §3.9): source INTERNAL_AUDIT, severity from the type, the finding's clauses and unit (or the audit's single
   * unit), owner, approver and due date from the body. With `checklistItemId`, the row is marked FINDING and linked,
   * and a finding given no clauses or unit takes the row's.
   */
  createIsoInternalFinding(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    const reach = auditReach(firm, audit);
    ctx.authorize(selfScope(actor, reach, auditTeam(audit)));
    requireInProgress(audit);
    const body = ctx.body;
    const system = systemOf(firm, programmeOf(firm, audit));
    let item: Item | undefined;
    if (body.checklistItemId !== undefined) {
      item = itemsOf(firm, audit).find((i) => i.id === body.checklistItemId);
      if (item === undefined) invalid('checklistItemId', 'Not a checklist row of this audit');
      if (item.findingId !== null) {
        invalid('checklistItemId', 'This checklist row already links a finding');
      }
    }
    const clauseIds =
      body.clauseIds.length === 0 && item !== undefined ? [item.clauseId] : body.clauseIds;
    const unitId = body.unitId ?? item?.unitId ?? null;
    checkSystemClauses(firm, system, clauseIds, 'clauseIds');
    checkAuditUnit(reach, unitId, 'unitId');
    const today = ctx.clock.today();
    let nc: Nonconformity | null = null;
    if (body.nonconformity !== undefined) {
      const raise = body.nonconformity;
      const ncUnit = unitId ?? (reach.unitIds.length === 1 ? reach.unitIds[0]! : null);
      checkNcPerson(actor, audit.clientId, raise.ownerId, 'ownerId', ncUnit);
      checkNcPerson(actor, audit.clientId, raise.approverId, 'approverId', ncUnit);
      if (raise.dueOn < today) {
        invalidAt(['nonconformity', 'dueOn'], 'The nonconformity is due today or later');
      }
      nc = {
        ...isoFresh(ctx, actor, audit.clientId),
        managementSystemId: system.id,
        number: nextNcNumber(firm, audit.clientId),
        source: 'INTERNAL_AUDIT',
        sourceInstanceId: null,
        raisedFromRiskItemId: null,
        severity: body.type === 'MAJOR_NC' ? 'MAJOR' : 'MINOR',
        standards: ncStandards(firm, system, audit, clauseIds),
        clauseIds,
        unitId: ncUnit,
        description: body.description,
        reportedById: actor.person.id,
        reportedOn: today,
        containment: null,
        correction: null,
        disposition: null,
        dispositionAuthorisedById: null,
        rootCauseMethod: null,
        rootCause: null,
        similarOccurrences: null,
        relatedRiskItemIds: [],
        updatedRiskItemIds: [],
        riskReview: null,
        systemChange: null,
        changedDocumentIds: [],
        noActionReason: null,
        ownerId: raise.ownerId,
        approverId: raise.approverId,
        dueOn: raise.dueOn,
        effectivenessDueOn: null,
        effectivenessNote: null,
        effective: null,
        closedOn: null,
        cancelReason: null,
        state: 'OPEN',
        incident: null,
      };
    }
    const finding: Finding = {
      ...isoFresh(ctx, actor, audit.clientId),
      internalAuditId: audit.id,
      externalAuditId: null,
      type: body.type,
      clauseIds,
      unitId,
      description: body.description,
      nonconformityId: nc?.id ?? null,
    };
    if (nc !== null) {
      firm.iso.nonconformities.push(nc);
      isoAudit(ctx, actor, {
        action: 'CREATE',
        entityType: 'nonconformity',
        entityId: nc.id,
        clientId: nc.clientId,
        after: {
          action: 'RAISE',
          number: nc.number,
          source: nc.source,
          severity: nc.severity,
          standards: nc.standards,
          clauseIds: nc.clauseIds,
          unitId: nc.unitId,
          ownerId: nc.ownerId,
          approverId: nc.approverId,
          dueOn: nc.dueOn,
          state: nc.state,
          auditFindingId: finding.id,
        },
      });
    }
    firm.iso.findings.push(finding);
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'audit_finding',
      entityId: finding.id,
      clientId: finding.clientId,
      after: {
        internalAuditId: audit.id,
        type: finding.type,
        clauseIds: finding.clauseIds,
        unitId: finding.unitId,
        nonconformityId: finding.nonconformityId,
      },
    });
    if (item !== undefined) {
      patchIso(
        ctx,
        actor,
        item,
        item.version,
        { result: 'FINDING', findingId: finding.id, notAuditedReason: null },
        'audit_checklist_item',
      );
    }
    return finding;
  },

  /**
   * Changes a finding while its audit is IN_PROGRESS. `type` moves only among OBSERVATION, OFI and GOOD_PRACTICE (a
   * finding with live actions cannot become GOOD_PRACTICE), or between MAJOR_NC and MINOR_NC, when its nonconformity's
   * severity follows: only while that nonconformity is OPEN or ROOT_CAUSE_FOUND (409 after) and never by its owner
   * (403), model §3.9. A description edit is audited as changed, not copied (non-negotiable 6).
   */
  updateIsoInternalFinding(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    const finding = requireFinding(firm, audit, ctx.params.findingId);
    const reach = auditReach(firm, audit);
    ctx.authorize(selfScope(actor, reach, auditTeam(audit)));
    const { version, ...fields } = ctx.body;
    checkIsoVersion(finding, version);
    requireInProgress(audit);
    if (fields.clauseIds !== undefined) {
      checkSystemClauses(
        firm,
        systemOf(firm, programmeOf(firm, audit)),
        fields.clauseIds,
        'clauseIds',
      );
    }
    checkAuditUnit(reach, fields.unitId, 'unitId');
    const type = fields.type ?? finding.type;
    let nc: Nonconformity | undefined;
    if (type !== finding.type) {
      const family = NC_TYPES.includes(finding.type) ? NC_TYPES : NON_NC_TYPES;
      if (!family.includes(type)) {
        invalid(
          'type',
          NC_TYPES.includes(finding.type)
            ? 'This finding raised a nonconformity: cancel the nonconformity instead'
            : 'A finding cannot become a nonconformity: record a new MAJOR_NC or MINOR_NC finding',
        );
      }
      if (type === 'GOOD_PRACTICE') {
        const actions = liveIso(firm, 'actions', audit.clientId).filter(
          (a) =>
            a.subject.type === 'AUDIT_FINDING' &&
            a.subject.id === finding.id &&
            a.state !== 'CANCELLED',
        );
        if (actions.length > 0) {
          invalid('type', 'A GOOD_PRACTICE finding has no actions: cancel its actions first');
        }
      }
      if (finding.nonconformityId !== null) {
        nc = firm.iso.nonconformities.find((n) => n.id === finding.nonconformityId)!;
        // SUBMIT_NO_ACTION reads the severity, so its owner never moves it, and nobody after ROOT_CAUSE_FOUND.
        if (nc.ownerId === actor.person.id) {
          forbidden(
            'isoAudit.conduct',
            'You own its nonconformity, so someone else moves its type',
          );
        }
        if (nc.state !== 'OPEN' && nc.state !== 'ROOT_CAUSE_FOUND') {
          invalidTransition('nonconformity', nc.state, 'UPDATE');
        }
      }
    }
    patchIsoUnrecorded(
      ctx,
      actor,
      finding,
      version,
      {
        type: fields.type,
        clauseIds: fields.clauseIds,
        unitId: fields.unitId,
        description: fields.description,
      },
      'audit_finding',
    );
    if (nc !== undefined) {
      patchIso(
        ctx,
        actor,
        nc,
        nc.version,
        { severity: type === 'MAJOR_NC' ? 'MAJOR' : 'MINOR' },
        'nonconformity',
      );
    }
    return finding;
  },
};
