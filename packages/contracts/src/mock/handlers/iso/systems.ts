// Mock handlers for the ISO add-on: Catalogue reads, management systems, context, the clause checklist with N/A, and the overview.
// The server answers 403 FEATURE_NOT_ENABLED or 409 FEATURE_NOT_READY before any of these run.
import type { z } from 'zod';
import { ENDPOINTS } from '../../../api/endpoints.js';
import type { ClauseAssessmentView, IsoSystemOverview } from '../../../api/iso.js';
import { IsoStandardCode } from '../../../enums.js';
import { type ClauseNaAction, IncidentOutcome, IncidentType } from '../../../schemas/iso.js';
import type { CertificationGate, GateResult, IdCount } from '../../../schemas/iso-results.js';
import {
  type Actor,
  asOfFor,
  authorize,
  diff,
  fyRange,
  matches,
  MockError,
  notFound,
  paginate,
  type Scope,
} from '../../core.js';
import { actorOf, type EndpointId, type PartialHandlers } from '../../handler.js';
import {
  addDays,
  canSee,
  checkClientUnits,
  checkIsoPerson,
  checkIsoVersion,
  clauseOf,
  forbidden,
  holdsRole,
  invalid,
  invalidTransition,
  type IsoCtx,
  type IsoEntity,
  isoAudit,
  isoFresh,
  isIsoManager,
  type IsoReach,
  isoScope,
  liveIso,
  reachOf,
  requireIso,
  requireSystem,
  touchIso,
} from '../../iso/common.js';
import {
  addMonths,
  certificationCycle,
  fyOf,
  incidentsIn,
  isoTiming,
  localDate,
  ncStatus,
  objectiveOnTrack,
  readinessScore,
  uncoveredByAudits,
} from '../../iso/derive.js';
import type { FirmState, AuditRecord, IsoRow } from '../../store.js';

type Ids =
  | 'listIsoStandards'
  | 'listIsoClauses'
  | 'listIsoReviewDefs'
  | 'listIsoSystems'
  | 'createIsoSystem'
  | 'getIsoSystem'
  | 'updateIsoSystem'
  | 'setIsoClimateDecision'
  | 'listIsoContextItems'
  | 'createIsoContextItem'
  | 'updateIsoContextItem'
  | 'archiveIsoContextItem'
  | 'listIsoChecklist'
  | 'updateIsoChecklistRow'
  | 'requestIsoClauseNa'
  | 'approveIsoClauseNa'
  | 'rejectIsoClauseNa'
  | 'withdrawIsoClauseNa'
  | 'getIsoOverview';

type System = IsoRow<'managementSystems'>;
type Assessment = IsoRow<'clauseAssessments'>;
type Clause = FirmState['isoCatalogue']['clauses'][number];
type Standard = FirmState['isoCatalogue']['standards'][number];
type AssessmentView = z.input<typeof ClauseAssessmentView>;
type SystemOverview = z.input<typeof IsoSystemOverview>;
type Count = z.input<typeof IdCount>;
type Gate = z.input<typeof GateResult>;
type AuditAction = AuditRecord['action'];

// ---------- catalogue order ----------

const codeRank = (code: string) => IsoStandardCode.options.indexOf(code as IsoStandardCode);

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

/** Standards by code (9001, 14001, 45001), then edition. */
function compareStandards(firm: FirmState, a: string, b: string): number {
  const x = firm.isoCatalogue.standards.find((s) => s.id === a);
  const y = firm.isoCatalogue.standards.find((s) => s.id === b);
  return (
    codeRank(x?.code ?? '') - codeRank(y?.code ?? '') ||
    (x?.edition ?? '').localeCompare(y?.edition ?? '')
  );
}

const liveCatalogue = <T extends { archivedAt: string | null }>(rows: T[]) =>
  rows.filter((r) => r.archivedAt === null);

// ---------- systems ----------

/** A system's reach: its units (every client unit when its list is empty, plan §3.3). A system names nobody. */
const systemReach = (firm: FirmState, system: System): IsoReach =>
  reachOf(firm, { clientId: system.clientId, unitIds: system.unitIds, systemId: system.id });

/** Standard ids from the account's catalogue, one edition per standard (400 VALIDATION otherwise). */
function checkStandards(firm: FirmState, standardIds: readonly string[]): void {
  const codes = standardIds.map((id) => {
    const standard = liveCatalogue(firm.isoCatalogue.standards).find((s) => s.id === id);
    if (standard === undefined) {
      invalid('standardIds', "Not a standard in the account's ISO catalogue");
    }
    return standard.code;
  });
  if (new Set(codes).size !== codes.length) invalid('standardIds', 'One edition per standard');
}

/** One NOT_STARTED checklist row per assessable clause of each standard, each audited as a CREATE. */
function addChecklistRows(
  ctx: IsoCtx,
  actor: Actor,
  system: System,
  standardIds: readonly string[],
): void {
  for (const clause of liveCatalogue(actor.firm.isoCatalogue.clauses)) {
    if (!clause.assessable || !standardIds.includes(clause.standardId)) continue;
    const row: Assessment = {
      ...isoFresh(ctx, actor, system.clientId),
      managementSystemId: system.id,
      clauseId: clause.id,
      status: 'NOT_STARTED',
      justification: null,
      naState: 'NONE',
      statusBeforeNa: null,
      naRequestedById: null,
      naDecidedById: null,
      naDecidedAt: null,
      ownerId: null,
      notes: null,
      lastReviewedOn: null,
    };
    actor.firm.iso.clauseAssessments.push(row);
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'clause_assessment',
      entityId: row.id,
      clientId: row.clientId,
      after: { managementSystemId: system.id, clauseId: clause.id, status: row.status },
    });
  }
}

/**
 * Applies the defined fields of `patch` to `row` (version checked first) and bumps it once, then audits the changed
 * fields: those named in `split` under their own action (an owner change is a REASSIGN), the rest as one UPDATE.
 * Nothing is written when nothing changed.
 */
function patchWithEvents<
  T extends { id: string; clientId: string; version: number; updatedAt: string },
>(
  ctx: IsoCtx,
  actor: Actor,
  row: T,
  version: number,
  patch: Partial<T>,
  entityType: IsoEntity,
  split: Partial<Record<string, AuditAction>> = {},
  reason: string | null = null,
): T {
  checkIsoVersion(row, version);
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
  const changes = diff({ ...row }, { ...row, ...defined });
  const keys = Object.keys(changes.after);
  if (keys.length === 0) return row;
  Object.assign(row, defined);
  touchIso(ctx, row);
  // The plain field edits first, then each split action in the order its fields first changed.
  const byAction = new Map<AuditAction, string[]>([['UPDATE', []]]);
  for (const key of keys) {
    const action = split[key] ?? 'UPDATE';
    byAction.set(action, [...(byAction.get(action) ?? []), key]);
  }
  const pick = (values: Record<string, unknown>, fields: string[]) =>
    Object.fromEntries(fields.map((f) => [f, values[f]]));
  for (const [action, fields] of byAction) {
    if (fields.length === 0) continue;
    isoAudit(ctx, actor, {
      action,
      entityType,
      entityId: row.id,
      clientId: row.clientId,
      before: pick(changes.before, fields),
      after: pick(changes.after, fields),
      reason: action === 'UPDATE' ? null : reason,
    });
  }
  return row;
}

// ---------- context items ----------

const KIND_ORDER = ['INTERNAL_ISSUE', 'EXTERNAL_ISSUE', 'INTERESTED_PARTY'];

/** The system's context item `itemId`, live, or 404. */
function requireContextItem(firm: FirmState, system: System, itemId: string) {
  const item = requireIso(firm, 'contextItems', system.clientId, itemId);
  if (item.managementSystemId !== system.id) throw notFound();
  return item;
}

// ---------- checklist ----------

/** A checklist row's reach: its system's units, and its owner (the named-person exception). */
const rowReach = (firm: FirmState, row: Assessment): IsoReach =>
  reachOf(firm, {
    clientId: row.clientId,
    systemId: row.managementSystemId,
    people: [row.ownerId],
  });

/** The system's checklist row `rowId`, or 404. */
function requireRow(firm: FirmState, system: System, rowId: string): Assessment {
  const row = requireIso(firm, 'clauseAssessments', system.clientId, rowId);
  if (row.managementSystemId !== system.id) throw notFound();
  return row;
}

/**
 * The scope for an N/A decision: the row's units, with no named-person exception. `isoChecklist.decideNa` has no
 * `own` grant, so being the row's owner widens nothing (plan §3.3).
 */
const decideScope = (reach: IsoReach): Scope => ({
  clientId: reach.clientId,
  ...(reach.unitIds.length === 0 ? {} : { unitIds: reach.unitIds }),
});

/** Whether the endpoints.md role check would let the actor call `id` for `scope`. */
function may(actor: Actor, id: EndpointId, scope: Scope): boolean {
  try {
    authorize(actor, ENDPOINTS[id], scope);
    return true;
  } catch (error) {
    if (error instanceof MockError) return false;
    throw error;
  }
}

/** The N/A steps the actor may take on a row now: model §4.6 states, plan §3.2 roles, never the requester's decision. */
function naActions(
  actor: Actor,
  row: Assessment,
  clause: Clause,
): z.input<typeof ClauseNaAction>[] {
  const reach = rowReach(actor.firm, row);
  const ownScope = isoScope(actor, reach, { ownerId: row.ownerId });
  const actions: z.input<typeof ClauseNaAction>[] = [];
  const requestable = row.naState === 'NONE' || row.naState === 'REJECTED';
  if (requestable && clause.exclusionAllowed && may(actor, 'requestIsoClauseNa', ownScope)) {
    actions.push('REQUEST_NA');
  }
  if (
    row.naState === 'REQUESTED' &&
    row.naRequestedById !== actor.person.id &&
    may(actor, 'approveIsoClauseNa', decideScope(reach))
  ) {
    actions.push('APPROVE_NA', 'REJECT_NA');
  }
  if (row.naState === 'APPROVED' && may(actor, 'withdrawIsoClauseNa', ownScope)) {
    actions.push('WITHDRAW_NA');
  }
  return actions;
}

function rowView(actor: Actor, row: Assessment): AssessmentView {
  const clause = clauseOf(actor.firm, row.clauseId)!;
  return {
    ...row,
    standardId: clause.standardId,
    clauseNumber: clause.number,
    clauseTitle: clause.title,
    exclusionAllowed: clause.exclusionAllowed,
    allowedActions: naActions(actor, row, clause),
  };
}

const NA_FIELDS = [
  'status',
  'naState',
  'statusBeforeNa',
  'justification',
  'naRequestedById',
  'naDecidedById',
  'naDecidedAt',
] as const;

/**
 * One clause N/A arrow (model §4.6): version, then the from-state (409 INVALID_TRANSITION), then the change, audited
 * as a TRANSITION naming the action, with its reason. `delegated` when the actor is not the person who normally takes
 * the step.
 */
function naTransition(
  ctx: IsoCtx,
  actor: Actor,
  row: Assessment,
  version: number,
  action: z.input<typeof ClauseNaAction>,
  from: readonly string[],
  change: Partial<Assessment>,
  options: { reason: string | null; delegated: boolean; check?: () => void },
): void {
  checkIsoVersion(row, version);
  if (!from.includes(row.naState)) invalidTransition('clause_assessment', row.naState, action);
  options.check?.();
  const before = Object.fromEntries(NA_FIELDS.map((f) => [f, row[f]]));
  Object.assign(row, change);
  touchIso(ctx, row);
  const changes = diff(before, Object.fromEntries(NA_FIELDS.map((f) => [f, row[f]])));
  isoAudit(ctx, actor, {
    action: 'TRANSITION',
    entityType: 'clause_assessment',
    entityId: row.id,
    clientId: row.clientId,
    before: changes.before,
    after: { action, ...changes.after },
    reason: options.reason,
    ...(options.delegated ? { delegated: true } : {}),
  });
}

/**
 * Loads the row a checklist route names and runs the role check for it: `own` scopes to the row's owner, otherwise it
 * is an N/A decision (`decideScope`).
 */
function checklistRow(
  ctx: {
    params: Record<string, string>;
    authorize(scope: Scope): void;
  },
  actor: Actor,
  own: boolean,
) {
  const system = requireSystem(actor.firm, ctx.params.clientId!, ctx.params.id!);
  const row = requireRow(actor.firm, system, ctx.params.rowId!);
  const reach = rowReach(actor.firm, row);
  ctx.authorize(own ? isoScope(actor, reach, { ownerId: row.ownerId }) : decideScope(reach));
  return { system, row, reach };
}

// ---------- overview (model §5.1-5.2) ----------

const idCount = (ids: readonly string[]): Count => {
  const unique = [...new Set(ids)];
  return { count: unique.length, ids: unique };
};

const REPORTED = ['REPORTED', 'CLOSED'];
const HELD = ['HELD', 'CLOSED'];

/** Risk kinds that meet the RISKS gate per standard (model §5.1). */
const RISK_KINDS: Record<IsoStandardCode, string[]> = {
  ISO_9001: ['RISK', 'OPPORTUNITY'],
  ISO_14001: ['ASPECT'],
  ISO_45001: ['HAZARD'],
};

/** Every live record of one system that the overview reads. */
function systemRecords(firm: FirmState, system: System) {
  const of = <K extends 'contextItems' | 'documents' | 'riskItems' | 'objectives'>(table: K) =>
    liveIso(firm, table, system.clientId).filter(
      (r) => (r as { managementSystemId: string }).managementSystemId === system.id,
    ) as IsoRow<K>[];
  const clientId = system.clientId;
  const mine = <T extends { managementSystemId: string }>(rows: T[]) =>
    rows.filter((r) => r.managementSystemId === system.id);
  const programmes = mine(liveIso(firm, 'auditProgrammes', clientId));
  const programmeIds = new Set(programmes.map((p) => p.id));
  const audits = liveIso(firm, 'internalAudits', clientId).filter((a) =>
    programmeIds.has(a.programmeId),
  );
  const auditIds = new Set(audits.map((a) => a.id));
  const externalAudits = mine(liveIso(firm, 'externalAudits', clientId));
  const externalIds = new Set(externalAudits.map((a) => a.id));
  const reviews = mine(liveIso(firm, 'managementReviews', clientId));
  const reviewIds = new Set(reviews.map((r) => r.id));
  const documents = of('documents');
  const documentIds = new Set(documents.map((d) => d.id));
  return {
    standards: system.standardIds
      .map((id) => firm.isoCatalogue.standards.find((s) => s.id === id))
      .filter((s): s is Standard => s !== undefined),
    clauses: liveCatalogue(firm.isoCatalogue.clauses).filter((c) =>
      system.standardIds.includes(c.standardId),
    ),
    assessments: mine(liveIso(firm, 'clauseAssessments', clientId)),
    contextItems: of('contextItems'),
    documents,
    revisions: liveIso(firm, 'revisions', clientId).filter((r) => documentIds.has(r.documentId)),
    riskItems: of('riskItems'),
    objectives: of('objectives'),
    readings: liveIso(firm, 'readings', clientId),
    programmes,
    audits,
    checklistItems: liveIso(firm, 'auditChecklistItems', clientId).filter((i) =>
      auditIds.has(i.internalAuditId),
    ),
    findings: liveIso(firm, 'findings', clientId).filter(
      (f) =>
        (f.internalAuditId !== null && auditIds.has(f.internalAuditId)) ||
        (f.externalAuditId !== null && externalIds.has(f.externalAuditId)),
    ),
    certifications: mine(liveIso(firm, 'certifications', clientId)),
    externalAudits,
    nonconformities: mine(liveIso(firm, 'nonconformities', clientId)),
    actions: liveIso(firm, 'actions', clientId),
    reviews,
    reviewInputs: liveIso(firm, 'reviewInputs', clientId).filter((i) =>
      reviewIds.has(i.managementReviewId),
    ),
  };
}
type Records = ReturnType<typeof systemRecords>;

/** Assessable clauses that need coverage: not an approved N/A on a clause that allows exclusion. */
function coverableClauses(firm: FirmState, records: Records): Clause[] {
  const excluded = new Set(
    records.assessments.filter((a) => a.naState === 'APPROVED').map((a) => a.clauseId),
  );
  return records.clauses
    .filter((c) => c.assessable && !(c.exclusionAllowed && excluded.has(c.id)))
    .sort(
      (a, b) =>
        compareStandards(firm, a.standardId, b.standardId) || compareNumbers(a.number, b.number),
    );
}

/** `clauseReadiness`: assessable clauses of the system's standards; a clause with no row counts as not started. */
function clauseReadiness(records: Records, system: System): SystemOverview['clauseReadiness'] {
  const rowOf = new Map(records.assessments.map((a) => [a.clauseId, a]));
  const rows = (standardIds: readonly string[]) =>
    records.clauses
      .filter((c) => c.assessable && standardIds.includes(c.standardId))
      .sort((a, b) => compareNumbers(a.number, b.number))
      .map((c) => {
        const row = rowOf.get(c.id);
        return {
          clauseId: c.id,
          status: row?.status ?? 'NOT_STARTED',
          naState: row?.naState ?? 'NONE',
          exclusionAllowed: c.exclusionAllowed,
        };
      });
  return {
    overall: readinessScore(rows(system.standardIds)),
    byStandard: system.standardIds.map((standardId) => ({
      standardId,
      ...readinessScore(rows([standardId])),
    })),
  };
}

const gate = (name: z.input<typeof CertificationGate>, missing: string[]): Gate => ({
  gate: name,
  met: missing.length === 0,
  missing,
});

/** `certificationReadiness`: the stage-1 gates per standard, from the system's records (model §5.1). */
function certificationReadiness(
  firm: FirmState,
  system: System,
  records: Records,
  asOf: string,
): SystemOverview['certificationReadiness'] {
  const yearAgo = addMonths(asOf, -12);
  const within = (date: string | null) => date !== null && date > yearAgo && date <= asOf;
  const coverable = coverableClauses(firm, records);
  const recentAudits = records.audits.filter(
    (a) => REPORTED.includes(a.state) && within(a.reportedOn),
  );
  const inputKey = new Map(firm.isoCatalogue.reviewInputDefs.map((d) => [d.id, d.key] as const));
  return {
    standards: records.standards.map((standard) => {
      const code = standard.code as IsoStandardCode;
      const clauses = coverable.filter((c) => c.standardId === standard.id);
      const gap = uncoveredByAudits(
        recentAudits,
        records.checklistItems,
        clauses.map((c) => c.id),
        system.unitIds,
      );
      const numberOf = new Map(clauses.map((c) => [c.id, c.number]));
      const auditGate = gate('INTERNAL_AUDIT', [
        ...gap.clauseIds.map((id) => numberOf.get(id)!),
        ...gap.unitIds,
      ]);

      const keys = [
        ...new Set(
          firm.isoCatalogue.reviewInputDefs
            .filter((d) => d.standardId === standard.id)
            .map((d) => d.key),
        ),
      ];
      const reviews = records.reviews
        .filter((r) => HELD.includes(r.state) && within(r.heldOn) && r.standards.includes(code))
        .sort((a, b) => (b.heldOn! < a.heldOn! ? -1 : 1));
      const unnoted = (reviewId: string) => {
        const noted = new Set(
          records.reviewInputs
            .filter((i) => i.managementReviewId === reviewId && i.notes !== null)
            .map((i) => inputKey.get(i.inputDefId)),
        );
        return keys.filter((k) => !noted.has(k));
      };
      const reviewGate = gate(
        'MANAGEMENT_REVIEW',
        reviews.length === 0
          ? ['No management review held in the 12 months up to the as-of date']
          : reviews.some((r) => unnoted(r.id).length === 0)
            ? []
            : unnoted(reviews[0]!.id),
      );

      const scopeGate = gate('SCOPE', [
        ...(system.scopeStatement === null ? ['scopeStatement'] : []),
        ...(system.unitIds.length === 0 ? ['unitIds'] : []),
      ]);

      // Clause 5.2 or one of its sub-clauses (ISO 9001 splits it into 5.2.1 and 5.2.2).
      const policyClauses = records.clauses
        .filter(
          (c) =>
            c.standardId === standard.id && (c.number === '5.2' || c.number.startsWith('5.2.')),
        )
        .map((c) => c.id);
      const policy = records.documents.some(
        (d) =>
          d.type === 'POLICY' &&
          d.status === 'ACTIVE' &&
          d.currentRevisionId !== null &&
          d.clauseIds.some((id) => policyClauses.includes(id)),
      );
      const policyGate = gate('POLICY', policy ? [] : ['5.2']);

      const objectives = records.objectives.filter((o) => o.standards.includes(code));
      const planned = new Set(
        records.actions
          .filter((a) => a.subject.type === 'OBJECTIVE' && a.state !== 'CANCELLED')
          .map((a) => a.subject.id),
      );
      const objectivesGate = gate(
        'OBJECTIVES',
        objectives.length === 0
          ? ['No objective for this standard']
          : objectives.filter((o) => o.closedOn === null && !planned.has(o.id)).map((o) => o.id),
      );

      const kinds = RISK_KINDS[code];
      const risksGate = gate(
        'RISKS',
        records.riskItems.some((r) => kinds.includes(r.kind)) ? [] : kinds,
      );

      const gates = [auditGate, reviewGate, scopeGate, policyGate, objectivesGate, risksGate];
      return { standardId: standard.id, gates, ready: gates.every((g) => g.met) };
    }),
  };
}

/** `climateDeterminationGaps` (model §5.1). */
function climateGaps(system: System, records: Records): SystemOverview['climateGaps'] {
  if (system.climateChangeRelevant === null) return ['UNDECIDED'];
  if (!system.climateChangeRelevant) return [];
  return [
    ...(records.riskItems.some((r) => r.climateRelated) ? [] : ['RELEVANT_NO_RISK' as const]),
    ...(records.contextItems.some((c) => c.climateRelated) ? [] : ['RELEVANT_NO_ISSUE' as const]),
  ];
}

/** `managementReviewDue`: per standard, the last HELD or CLOSED review covering it plus the interval. */
function managementReviewDue(
  system: System,
  records: Records,
  asOf: string,
  createdOn: string,
  dueSoonDays: number,
): SystemOverview['managementReview'] {
  return {
    items: records.standards.map((standard) => {
      const code = standard.code as IsoStandardCode;
      const held = records.reviews
        .filter((r) => HELD.includes(r.state) && r.heldOn !== null && r.standards.includes(code))
        .map((r) => r.heldOn!)
        .sort();
      const lastHeldOn = held.at(-1) ?? null;
      const nextDueOn = addMonths(lastHeldOn ?? createdOn, system.reviewIntervalMonths);
      const status = isoTiming(nextDueOn, false, asOf, dueSoonDays);
      return {
        standard: code,
        lastHeldOn,
        nextDueOn,
        timing: status.timing as 'ON_TIME' | 'DUE_SOON' | 'OVERDUE',
        overdueDays: status.overdueDays,
      };
    }),
  };
}

/** `incidentCounts` over the client's current FY, by the client-local date of `occurredAt` (`incidentsIn`). */
function incidentCounts(
  ncs: Records['nonconformities'],
  period: { from: string; to: string },
  timeZone: string,
): SystemOverview['incidents'] {
  const inPeriod = incidentsIn(ncs, period, timeZone);
  const ids = (pick: (incident: NonNullable<(typeof inPeriod)[number]['incident']>) => boolean) =>
    idCount(inPeriod.filter((n) => pick(n.incident!)).map((n) => n.id));
  return {
    ...period,
    total: ids(() => true),
    byType: IncidentType.options.map((type) => ({ type, ...ids((i) => i.type === type) })),
    byOutcome: IncidentOutcome.options.map((outcome) => ({
      outcome,
      ...ids((i) => i.outcome === outcome),
    })),
  };
}

/** One system's overview. Counts list only records the actor may see (plan §3.3); gates read every record. */
function systemOverview(actor: Actor, system: System, asOf: string): SystemOverview {
  const firm = actor.firm;
  const client = firm.data.clients.find((c) => c.id === system.clientId)!;
  const { timeZone, fyStartMonth: startMonth } = client.settings;
  const dueSoonDays = firm.data.firm.settings.dueSoonDays;
  const records = systemRecords(firm, system);
  const reach = (record: Parameters<typeof reachOf>[1]) => reachOf(firm, record);
  const seen = (r: IsoReach) => canSee(actor, r);
  const clientId = system.clientId;
  const systemId = system.id;

  // Parents' reaches, for the records and for their actions (a child takes its parent's units, plan §3.3).
  const ncReach = new Map(
    records.nonconformities.map((n) => [
      n.id,
      reach({
        clientId,
        unitId: n.unitId,
        systemId,
        people: [n.ownerId, n.approverId, ...(n.incident?.investigatorIds ?? [])],
      }),
    ]),
  );
  const riskReach = new Map(
    records.riskItems.map((r) => [
      r.id,
      reach({ clientId, unitId: r.unitId, systemId, people: [r.ownerId] }),
    ]),
  );
  const objectiveReach = new Map(
    records.objectives.map((o) => [o.id, reach({ clientId, systemId, people: [o.ownerId] })]),
  );
  const reviewReach = new Map(
    records.reviews.map((r) => [
      r.id,
      reach({ clientId, systemId, people: [r.chairId, ...r.attendeeIds] }),
    ]),
  );
  const auditPeople = (a: Records['audits'][number]) => [
    a.leadAuditorId,
    ...a.auditorIds,
    ...a.auditeeIds,
    ...a.reportedToIds,
  ];
  const auditReach = new Map(
    records.audits.map((a) => [
      a.id,
      reach({ clientId, unitIds: a.unitIds, systemId, people: auditPeople(a) }),
    ]),
  );
  const auditById = new Map(records.audits.map((a) => [a.id, a]));
  const findingReach = new Map(
    records.findings.map((f) => {
      const audit = f.internalAuditId === null ? undefined : auditById.get(f.internalAuditId);
      return [
        f.id,
        // A finding takes its audit's reach, never its own unit (README decision 45).
        reach({
          clientId,
          unitIds: audit?.unitIds ?? [],
          systemId,
          people: audit === undefined ? [] : auditPeople(audit),
        }),
      ];
    }),
  );
  const parentReach: Record<string, Map<string, IsoReach>> = {
    NONCONFORMITY: ncReach,
    RISK_ITEM: riskReach,
    OBJECTIVE: objectiveReach,
    AUDIT_FINDING: findingReach,
    MANAGEMENT_REVIEW: reviewReach,
  };

  const ncs = records.nonconformities.filter((n) => seen(ncReach.get(n.id)!));
  const openNcs = ncs.filter((n) => n.state !== 'CLOSED' && n.state !== 'CANCELLED');
  const actions = records.actions.filter((a) => {
    const parent = parentReach[a.subject.type]!.get(a.subject.id);
    return parent !== undefined && seen({ ...parent, people: [...parent.people, a.ownerId] });
  });
  const openActions = actions.filter((a) => a.state === 'OPEN');
  const documents = records.documents.filter(
    (d) =>
      d.status === 'ACTIVE' &&
      seen(reach({ clientId, systemId, people: [d.ownerId, d.approverId] })),
  );
  const inReview = new Set(
    records.revisions.filter((r) => r.state === 'IN_REVIEW').map((r) => r.documentId),
  );
  const risks = records.riskItems.filter((r) => seen(riskReach.get(r.id)!));
  const objectives = records.objectives.filter(
    (o) => o.closedOn === null && seen(objectiveReach.get(o.id)!),
  );
  const certifications = records.certifications.filter((c) =>
    seen(reach({ clientId, unitIds: c.unitIds, systemId })),
  );
  const overdue = (dueOn: string | null) => dueOn !== null && dueOn < asOf;
  // Each open nonconformity's own status on as-of, from all its actions, as the list's `overdue` filter reads it.
  const ncStatusOf = new Map(
    openNcs.map((n) => [
      n.id,
      ncStatus(
        n,
        records.actions.filter((a) => a.subject.type === 'NONCONFORMITY' && a.subject.id === n.id),
        asOf,
        dueSoonDays,
      ),
    ]),
  );

  const fy = fyOf(asOf, startMonth);
  const programme = records.programmes.find((p) => p.fy === fy);
  let auditProgramme: SystemOverview['auditProgramme'] = null;
  if (programme !== undefined) {
    const audits = records.audits.filter((a) => a.programmeId === programme.id);
    const gap = uncoveredByAudits(
      audits,
      records.checklistItems,
      coverableClauses(firm, records).map((c) => c.id),
      system.unitIds,
    );
    const visible = audits.filter((a) => seen(auditReach.get(a.id)!));
    auditProgramme = {
      fy,
      uncoveredClauseIds: gap.clauseIds,
      uncoveredUnitIds: gap.unitIds,
      planned: idCount(visible.filter((a) => a.state !== 'CANCELLED').map((a) => a.id)),
      reported: idCount(visible.filter((a) => REPORTED.includes(a.state)).map((a) => a.id)),
      cancelled: idCount(visible.filter((a) => a.state === 'CANCELLED').map((a) => a.id)),
    };
  }

  return {
    managementSystemId: system.id,
    name: system.name,
    standardIds: [...system.standardIds],
    clauseReadiness: clauseReadiness(records, system),
    certificationReadiness: certificationReadiness(firm, system, records, asOf),
    climateGaps: climateGaps(system, records),
    nonconformities: {
      open: idCount(openNcs.map((n) => n.id)),
      overdue: idCount(
        openNcs.filter((n) => ncStatusOf.get(n.id)!.timing === 'OVERDUE').map((n) => n.id),
      ),
      awaitingVerification: idCount(
        ncs.filter((n) => n.state === 'AWAITING_VERIFICATION').map((n) => n.id),
      ),
      effectivenessOverdue: idCount(
        openNcs
          .filter((n) => ncStatusOf.get(n.id)!.effectivenessOverdueDays !== null)
          .map((n) => n.id),
      ),
    },
    actions: {
      open: idCount(openActions.map((a) => a.id)),
      overdue: idCount(openActions.filter((a) => overdue(a.dueOn)).map((a) => a.id)),
    },
    documents: {
      inReview: idCount(documents.filter((d) => inReview.has(d.id)).map((d) => d.id)),
      reviewOverdue: idCount(documents.filter((d) => overdue(d.reviewDueOn)).map((d) => d.id)),
    },
    risks: {
      significant: idCount(risks.filter((r) => r.significant).map((r) => r.id)),
      reviewOverdue: idCount(risks.filter((r) => overdue(r.reviewDueOn)).map((r) => r.id)),
    },
    objectives: {
      open: idCount(objectives.map((o) => o.id)),
      offTrack: idCount(
        objectives
          .filter(
            (o) =>
              objectiveOnTrack(
                o,
                records.readings.filter((r) => r.objectiveId === o.id),
                asOf,
                timeZone,
              ) === false,
          )
          .map((o) => o.id),
      ),
    },
    auditProgramme,
    managementReview: managementReviewDue(
      system,
      records,
      asOf,
      localDate(system.createdAt, timeZone),
      dueSoonDays,
    ),
    certificates: {
      expiringSoon: idCount(
        certifications
          .filter(
            (c) => c.expiresOn !== null && c.expiresOn >= asOf && c.expiresOn <= addDays(asOf, 90),
          )
          .map((c) => c.id),
      ),
      cycleOverdue: idCount(
        certifications
          .filter((c) =>
            certificationCycle(c, records.externalAudits, asOf).items.some(
              (item) => item.overdueDays !== null,
            ),
          )
          .map((c) => c.id),
      ),
    },
    incidents: incidentCounts(ncs, fyRange(fy, startMonth), timeZone),
  };
}

// ---------- handlers ----------

export const systemsHandlers: PartialHandlers<Ids> = {
  // Catalogue: the account's copy, read by every member (model §2).
  listIsoStandards(ctx) {
    const actor = actorOf(ctx);
    ctx.authorize({ clientId: ctx.params.clientId! });
    const items = liveCatalogue(actor.firm.isoCatalogue.standards).sort(
      (a, b) => codeRank(a.code) - codeRank(b.code) || a.edition.localeCompare(b.edition),
    );
    return { items };
  },

  listIsoClauses(ctx) {
    const actor = actorOf(ctx);
    ctx.authorize({ clientId: ctx.params.clientId! });
    const { standardId, assessable } = ctx.query;
    const items = liveCatalogue(actor.firm.isoCatalogue.clauses)
      .filter(
        (c) =>
          (standardId === undefined || standardId.includes(c.standardId)) &&
          (assessable === undefined || c.assessable === assessable),
      )
      .sort(
        (a, b) =>
          compareStandards(actor.firm, a.standardId, b.standardId) ||
          compareNumbers(a.number, b.number),
      );
    return { items };
  },

  listIsoReviewDefs(ctx) {
    const actor = actorOf(ctx);
    ctx.authorize({ clientId: ctx.params.clientId! });
    const { standardId } = ctx.query;
    const pick = <T extends { standardId: string; clauseNumber: string; item: string | null }>(
      rows: (T & { archivedAt: string | null })[],
    ) =>
      liveCatalogue(rows)
        .filter((d) => standardId === undefined || standardId.includes(d.standardId))
        .sort(
          (a, b) =>
            compareStandards(actor.firm, a.standardId, b.standardId) ||
            compareNumbers(a.clauseNumber, b.clauseNumber) ||
            (a.item ?? '').localeCompare(b.item ?? ''),
        );
    return {
      inputs: pick(actor.firm.isoCatalogue.reviewInputDefs),
      outputs: pick(actor.firm.isoCatalogue.reviewOutputDefs),
    };
  },

  // Systems: by name; AP and OW see the systems over their units.
  listIsoSystems(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const { status, q } = ctx.query;
    const rows = liveIso(actor.firm, 'managementSystems', clientId)
      .filter(
        (s) =>
          canSee(actor, systemReach(actor.firm, s)) &&
          (status === undefined || status.includes(s.status)) &&
          matches(q, s.name, s.scopeStatement),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
    return paginate(rows, ctx.query);
  },

  createIsoSystem(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    const body = ctx.body;
    ctx.authorize({ clientId, ...(body.unitIds.length > 0 ? { unitIds: body.unitIds } : {}) });
    checkStandards(actor.firm, body.standardIds);
    checkClientUnits(actor.firm, clientId, body.unitIds, 'unitIds');
    const system: System = {
      ...isoFresh(ctx, actor, clientId),
      name: body.name,
      standardIds: [...body.standardIds],
      scopeStatement: body.scopeStatement,
      unitIds: [...body.unitIds],
      status: body.status,
      reviewIntervalMonths: body.reviewIntervalMonths,
      climateChangeRelevant: null,
      climateChangeRationale: null,
      climateDecidedOn: null,
    };
    actor.firm.iso.managementSystems.push(system);
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'management_system',
      entityId: system.id,
      clientId,
      after: {
        name: system.name,
        standardIds: system.standardIds,
        scopeStatement: system.scopeStatement,
        unitIds: system.unitIds,
        status: system.status,
        reviewIntervalMonths: system.reviewIntervalMonths,
      },
    });
    addChecklistRows(ctx, actor, system, system.standardIds);
    return system;
  },

  getIsoSystem(ctx) {
    const actor = actorOf(ctx);
    const system = requireSystem(actor.firm, ctx.params.clientId!, ctx.params.id!);
    ctx.authorize(isoScope(actor, systemReach(actor.firm, system)));
    return system;
  },

  updateIsoSystem(ctx) {
    const actor = actorOf(ctx);
    const system = requireSystem(actor.firm, ctx.params.clientId!, ctx.params.id!);
    ctx.authorize(isoScope(actor, systemReach(actor.firm, system)));
    const { version, ...patch } = ctx.body;
    checkIsoVersion(system, version);
    let added: string[] = [];
    if (patch.standardIds !== undefined) {
      if (system.standardIds.some((id) => !patch.standardIds!.includes(id))) {
        invalid('standardIds', 'A standard cannot be dropped from a management system');
      }
      checkStandards(actor.firm, patch.standardIds);
      added = patch.standardIds.filter((id) => !system.standardIds.includes(id));
      // Keep the system's order and add the new standards after it.
      patch.standardIds = [...system.standardIds, ...added];
    }
    if (patch.unitIds !== undefined) {
      checkClientUnits(actor.firm, system.clientId, patch.unitIds, 'unitIds');
    }
    // The system's status has no machine (model §4), so a status change is a field edit like the others.
    patchWithEvents(ctx, actor, system, version, patch, 'management_system');
    addChecklistRows(ctx, actor, system, added);
    return system;
  },

  setIsoClimateDecision(ctx) {
    const actor = actorOf(ctx);
    const system = requireSystem(actor.firm, ctx.params.clientId!, ctx.params.id!);
    ctx.authorize(isoScope(actor, systemReach(actor.firm, system)));
    const { version, ...decision } = ctx.body;
    checkIsoVersion(system, version);
    if (decision.climateDecidedOn > ctx.clock.today()) {
      invalid('climateDecidedOn', 'The climate decision cannot be dated after today');
    }
    // The body always carries a decision, so a decided system never returns to undecided (model §3.1).
    return patchWithEvents(ctx, actor, system, version, decision, 'management_system');
  },

  // Context items (4.1, 4.2): by kind, then when added.
  listIsoContextItems(ctx) {
    const actor = actorOf(ctx);
    const system = requireSystem(actor.firm, ctx.params.clientId!, ctx.params.id!);
    ctx.authorize(isoScope(actor, systemReach(actor.firm, system)));
    const { kind, climateRelated, includeArchived } = ctx.query;
    const items = actor.firm.iso.contextItems
      .filter(
        (c) =>
          c.clientId === system.clientId &&
          c.managementSystemId === system.id &&
          (includeArchived === true || c.archivedAt === null) &&
          (kind === undefined || kind.includes(c.kind)) &&
          (climateRelated === undefined || c.climateRelated === climateRelated),
      )
      .sort(
        (a, b) =>
          KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
          a.createdAt.localeCompare(b.createdAt) ||
          (a.id < b.id ? -1 : 1),
      );
    return { items };
  },

  createIsoContextItem(ctx) {
    const actor = actorOf(ctx);
    const system = requireSystem(actor.firm, ctx.params.clientId!, ctx.params.id!);
    ctx.authorize(isoScope(actor, systemReach(actor.firm, system)));
    const body = ctx.body;
    const item: IsoRow<'contextItems'> = {
      ...isoFresh(ctx, actor, system.clientId),
      managementSystemId: system.id,
      kind: body.kind,
      text: body.text,
      needs: body.needs,
      climateRelated: body.climateRelated,
      reviewedOn: body.reviewedOn,
    };
    actor.firm.iso.contextItems.push(item);
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'context_item',
      entityId: item.id,
      clientId: item.clientId,
      after: {
        managementSystemId: system.id,
        kind: item.kind,
        text: item.text,
        needs: item.needs,
        climateRelated: item.climateRelated,
        reviewedOn: item.reviewedOn,
      },
    });
    return item;
  },

  updateIsoContextItem(ctx) {
    const actor = actorOf(ctx);
    const system = requireSystem(actor.firm, ctx.params.clientId!, ctx.params.id!);
    const item = requireContextItem(actor.firm, system, ctx.params.itemId!);
    ctx.authorize(isoScope(actor, systemReach(actor.firm, system)));
    const { version, ...patch } = ctx.body;
    checkIsoVersion(item, version);
    if (item.kind !== 'INTERESTED_PARTY' && patch.needs !== undefined && patch.needs !== null) {
      invalid('needs', 'Only an interested party has needs');
    }
    return patchWithEvents(ctx, actor, item, version, patch, 'context_item');
  },

  archiveIsoContextItem(ctx) {
    const actor = actorOf(ctx);
    const system = requireSystem(actor.firm, ctx.params.clientId!, ctx.params.id!);
    const item = requireContextItem(actor.firm, system, ctx.params.itemId!);
    ctx.authorize(isoScope(actor, systemReach(actor.firm, system)));
    checkIsoVersion(item, ctx.body.version);
    item.archivedAt = ctx.clock.now();
    touchIso(ctx, item);
    isoAudit(ctx, actor, {
      action: 'ARCHIVE',
      entityType: 'context_item',
      entityId: item.id,
      clientId: item.clientId,
      before: { archivedAt: null },
      after: { archivedAt: item.archivedAt },
      reason: ctx.body.reason,
    });
    return item;
  },

  // Checklist: by standard and clause number. A row takes its system's units, and its owner always sees it.
  listIsoChecklist(ctx) {
    const actor = actorOf(ctx);
    const system = requireSystem(actor.firm, ctx.params.clientId!, ctx.params.id!);
    ctx.authorize({ clientId: system.clientId });
    const { standardId, status, naState, ownerId: ownerRef } = ctx.query;
    const ownerId = ownerRef === 'me' ? actor.person.id : ownerRef;
    const rows = liveIso(actor.firm, 'clauseAssessments', system.clientId).filter(
      (r) =>
        r.managementSystemId === system.id &&
        clauseOf(actor.firm, r.clauseId) !== undefined &&
        canSee(actor, rowReach(actor.firm, r)),
    );
    // Out of the actor's units and naming them nowhere: the system is not theirs to see.
    if (rows.length === 0 && !canSee(actor, systemReach(actor.firm, system))) throw notFound();
    const items = rows
      .map((r) => rowView(actor, r))
      .filter(
        (v) =>
          (standardId === undefined || standardId.includes(v.standardId)) &&
          (status === undefined || status.includes(v.status)) &&
          (naState === undefined || naState.includes(v.naState)) &&
          (ownerId === undefined || v.ownerId === ownerId),
      )
      .sort(
        (a, b) =>
          compareStandards(actor.firm, a.standardId, b.standardId) ||
          compareNumbers(a.clauseNumber, b.clauseNumber),
      );
    return { items };
  },

  updateIsoChecklistRow(ctx) {
    const actor = actorOf(ctx);
    const { system, row } = checklistRow(ctx, actor, true);
    const { version, reason, ...patch } = ctx.body;
    checkIsoVersion(row, version);
    if (patch.status !== undefined) {
      if (row.naState === 'REQUESTED' || row.naState === 'APPROVED') {
        invalid('status', `The status is not written while N/A is ${row.naState}`);
      }
      const clause = clauseOf(actor.firm, row.clauseId)!;
      if (
        patch.status === 'IMPLEMENTED' &&
        clause.number === '4.1' &&
        system.climateChangeRelevant === null
      ) {
        invalid(
          'status',
          'Clause 4.1 cannot be IMPLEMENTED before the climate decision is recorded',
        );
      }
    }
    if (patch.ownerId !== undefined && patch.ownerId !== row.ownerId) {
      if (!isIsoManager(actor, row.clientId)) {
        forbidden(
          'isoChecklist.write',
          'Only a client admin, consultant or account admin reassigns a row',
        );
      }
      if (patch.ownerId !== null) checkIsoPerson(actor, row.clientId, patch.ownerId, 'ownerId');
    }
    patchWithEvents(
      ctx,
      actor,
      row,
      version,
      patch,
      'clause_assessment',
      { ownerId: 'REASSIGN' },
      reason ?? null,
    );
    return rowView(actor, row);
  },

  requestIsoClauseNa(ctx) {
    const actor = actorOf(ctx);
    const { row } = checklistRow(ctx, actor, true);
    const clause = clauseOf(actor.firm, row.clauseId)!;
    naTransition(
      ctx,
      actor,
      row,
      ctx.body.version,
      'REQUEST_NA',
      ['NONE', 'REJECTED'],
      {
        statusBeforeNa: row.status as Assessment['statusBeforeNa'],
        status: 'NOT_APPLICABLE',
        naState: 'REQUESTED',
        justification: ctx.body.reason,
        naRequestedById: actor.person.id,
        naDecidedById: null,
        naDecidedAt: null,
      },
      {
        reason: ctx.body.reason,
        delegated: row.ownerId !== actor.person.id,
        check: () => {
          if (!clause.exclusionAllowed) {
            invalid('status', `Clause ${clause.number} cannot be determined not applicable`);
          }
        },
      },
    );
    return rowView(actor, row);
  },

  approveIsoClauseNa(ctx) {
    const actor = actorOf(ctx);
    const { row, reach } = checklistRow(ctx, actor, false);
    naTransition(
      ctx,
      actor,
      row,
      ctx.body.version,
      'APPROVE_NA',
      ['REQUESTED'],
      { naState: 'APPROVED', naDecidedById: actor.person.id, naDecidedAt: ctx.clock.now() },
      {
        reason: ctx.body.comment ?? null,
        delegated: !holdsRole(actor, row.clientId, ['APPROVER'], reach.unitIds),
        check: () => checkNotRequester(actor, row),
      },
    );
    return rowView(actor, row);
  },

  rejectIsoClauseNa(ctx) {
    const actor = actorOf(ctx);
    const { row, reach } = checklistRow(ctx, actor, false);
    naTransition(
      ctx,
      actor,
      row,
      ctx.body.version,
      'REJECT_NA',
      ['REQUESTED'],
      {
        naState: 'REJECTED',
        status: row.statusBeforeNa ?? 'NOT_STARTED',
        statusBeforeNa: null,
        naDecidedById: actor.person.id,
        naDecidedAt: ctx.clock.now(),
      },
      {
        reason: ctx.body.reason,
        delegated: !holdsRole(actor, row.clientId, ['APPROVER'], reach.unitIds),
        check: () => checkNotRequester(actor, row),
      },
    );
    return rowView(actor, row);
  },

  withdrawIsoClauseNa(ctx) {
    const actor = actorOf(ctx);
    const { row } = checklistRow(ctx, actor, true);
    naTransition(
      ctx,
      actor,
      row,
      ctx.body.version,
      'WITHDRAW_NA',
      ['APPROVED'],
      {
        naState: 'NONE',
        status: 'NOT_STARTED',
        statusBeforeNa: null,
        justification: null,
        naRequestedById: null,
        naDecidedById: null,
        naDecidedAt: null,
      },
      { reason: ctx.body.reason, delegated: row.ownerId !== actor.person.id },
    );
    return rowView(actor, row);
  },

  // Overview: every system the actor can see, by name.
  getIsoOverview(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const asOf = asOfFor(actor, clientId, ctx.query.asOf, ctx.clock);
    const wanted = ctx.query.managementSystemId;
    const systems = liveIso(actor.firm, 'managementSystems', clientId)
      .filter(
        (s) =>
          (wanted === undefined || wanted.includes(s.id)) &&
          canSee(actor, systemReach(actor.firm, s)),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
    return { asOf, systems: systems.map((s) => systemOverview(actor, s, asOf)) };
  },
};

/** Maker-checker (model §4 preamble): the requester never decides their own N/A request. */
function checkNotRequester(actor: Actor, row: Assessment): void {
  if (row.naRequestedById === actor.person.id) {
    forbidden('isoChecklist.decideNa', 'The requester does not decide their own N/A request');
  }
}
