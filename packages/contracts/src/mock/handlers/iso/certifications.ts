// Mock handlers for the ISO add-on: Certificates, external audits and their findings (model §3.8, §3.9, §4.4).
// The server answers 403 FEATURE_NOT_ENABLED or 409 FEATURE_NOT_READY before any of these run.
import type { z } from 'zod';
import type { CertificationView, ExternalAuditView } from '../../../api/iso.js';
import { IsoStandardCode, type Role } from '../../../enums.js';
import { type ExternalAuditAction, NC_FINDING_TYPES } from '../../../schemas/iso.js';
import { type Actor, diff, MockError, notFound, paginate } from '../../core.js';
import { actorOf, type PartialHandlers } from '../../handler.js';
import {
  canSee,
  checkIsoPerson,
  checkIsoVersion,
  checkSystemUnits,
  clauseOf,
  finishIsoScans,
  forbidden,
  holdsRole,
  invalid,
  invalidTransition,
  isClientAdmin,
  type IsoCtx,
  type IsoEntity,
  isoAudit,
  isoFresh,
  type IsoReach,
  isoScope,
  liveIso,
  patchIso,
  reachOf,
  requireIso,
  requireSystem,
  standardOf,
  systemUnitIds,
  touchIso,
} from '../../iso/common.js';
import { certificationCycle, clientDay } from '../../iso/derive.js';
import type { FirmState, AuditRecord, IsoRow } from '../../store.js';
import { patchIsoUnrecorded, raised as raiseEvent } from './nonconformities.js';

type Ids =
  | 'listIsoCertifications'
  | 'createIsoCertification'
  | 'updateIsoCertification'
  | 'listIsoExternalAudits'
  | 'createIsoExternalAudit'
  | 'getIsoExternalAudit'
  | 'updateIsoExternalAudit'
  | 'recordIsoExternalAuditHeld'
  | 'recordIsoExternalAuditResponse'
  | 'closeIsoExternalAudit'
  | 'cancelIsoExternalAudit'
  | 'listIsoExternalFindings'
  | 'createIsoExternalFinding'
  | 'updateIsoExternalFinding';

type System = IsoRow<'managementSystems'>;
type Certificate = IsoRow<'certifications'>;
type Audit = IsoRow<'externalAudits'>;
type Finding = IsoRow<'findings'>;
type Nonconformity = IsoRow<'nonconformities'>;
type CertificateOut = z.input<typeof CertificationView>;
type AuditOut = z.input<typeof ExternalAuditView>;
type FindingType = Finding['type'];

/** `isoCertification.write`: account admin, consultant and client admin (plan §3.2). */
const MANAGERS: readonly Role[] = ['FIRM_ADMIN', 'CONSULTANT', 'CLIENT_ADMIN'];
/** States in which an external audit's fields may change; CLOSED and CANCELLED lock it (model §6). */
const EDITABLE: readonly Audit['state'][] = ['PLANNED', 'HELD', 'RESPONDED'];
/** Finding types that may change into one another (FindingUpdateBody). */
const NON_NC_TYPES: readonly FindingType[] = ['OBSERVATION', 'OFI', 'GOOD_PRACTICE'];
const NC_TYPES: readonly FindingType[] = NC_FINDING_TYPES;
/** Scan states of a file that can stand as the body's report: not INFECTED, and not a failed scan. */
const REPORT_SCANS: readonly IsoRow<'files'>['scanStatus'][] = ['PENDING', 'CLEAN'];
/** Base fields, left out of a CREATE event's `after`. */
const BASE_FIELDS = ['id', 'firmId', 'clientId', 'createdAt', 'updatedAt', 'archivedAt', 'version'];

// ---------- lookups and reach ----------

/** The record's management system, archived or not (its records keep their units). */
const systemOf = (firm: FirmState, record: { managementSystemId: string }): System =>
  firm.iso.managementSystems.find((s) => s.id === record.managementSystemId)!;

/** A certificate covers its units, or its management system's when its list is empty (plan §3.3). Nobody is named. */
const certificateReach = (firm: FirmState, certificate: Certificate): IsoReach =>
  reachOf(firm, {
    clientId: certificate.clientId,
    unitIds: certificate.unitIds,
    systemId: certificate.managementSystemId,
  });

/**
 * An external audit has no unit of its own: it takes its management system's units and names nobody (the body's
 * auditor is text). Its findings take the same reach (a child record takes its parent's units, plan §3.3).
 */
const auditReach = (firm: FirmState, audit: Audit): IsoReach =>
  reachOf(firm, { clientId: audit.clientId, systemId: audit.managementSystemId });

const requireCertificate = (actor: Actor, clientId: string | undefined, id: string | undefined) =>
  requireIso(actor.firm, 'certifications', clientId!, id!);

const requireAudit = (actor: Actor, clientId: string | undefined, id: string | undefined) =>
  requireIso(actor.firm, 'externalAudits', clientId!, id!);

/** A live finding of `audit`, or 404 (another audit's finding included). */
function requireFinding(firm: FirmState, audit: Audit, id: string | undefined): Finding {
  const finding = requireIso(firm, 'findings', audit.clientId, id!);
  if (finding.externalAuditId !== audit.id) throw notFound();
  return finding;
}

const findingsOf = (firm: FirmState, audit: Audit) =>
  liveIso(firm, 'findings', audit.clientId).filter((f) => f.externalAuditId === audit.id);

/** The nonconformities the audit's MAJOR_NC and MINOR_NC findings raised. */
function raisedNcs(firm: FirmState, audit: Audit): Nonconformity[] {
  const ids = new Set(
    findingsOf(firm, audit)
      .map((f) => f.nonconformityId)
      .filter((id): id is string => id !== null),
  );
  return firm.iso.nonconformities.filter((n) => ids.has(n.id));
}

/** Oldest first; rows written in the same instant keep the order they were written in (a stable sort). */
const byCreation = (a: { createdAt: string }, b: { createdAt: string }) =>
  a.createdAt.localeCompare(b.createdAt);

/** FA, CO or CA covering the record's units: who may take `isoCertification.write` on it. */
const writes = (actor: Actor, clientId: string, reach: IsoReach) =>
  holdsRole(actor, clientId, MANAGERS, reach.unitIds);

// ---------- derived values (model §5.2) ----------

function certificateView(ctx: IsoCtx, actor: Actor, certificate: Certificate): CertificateOut {
  return {
    ...certificate,
    cycle: certificationCycle(
      certificate,
      liveIso(actor.firm, 'externalAudits', certificate.clientId),
      ctx.clock.today(),
    ),
  };
}

/**
 * An external audit with the steps the actor may take now (model §4.4): RECORD_HELD and CANCEL while PLANNED;
 * RECORD_RESPONSE once HELD, and CLOSE straight from HELD only when no finding raised a nonconformity; CLOSE once
 * RESPONDED. Only FA, CO and CA covering the audit's units take them.
 */
function auditView(actor: Actor, audit: Audit): AuditOut {
  const firm = actor.firm;
  const allowedActions: ExternalAuditAction[] = [];
  if (writes(actor, audit.clientId, auditReach(firm, audit))) {
    if (audit.state === 'PLANNED') allowedActions.push('RECORD_HELD', 'CANCEL');
    if (audit.state === 'HELD') {
      allowedActions.push('RECORD_RESPONSE');
      if (raisedNcs(firm, audit).length === 0) allowedActions.push('CLOSE');
    }
    if (audit.state === 'RESPONDED') allowedActions.push('CLOSE');
  }
  return { ...audit, allowedActions };
}

// ---------- checks ----------

function invalidAt(path: string[], message: string): never {
  throw new MockError('VALIDATION', message, { issues: [{ path: ['body', ...path], message }] });
}

/** The standards are standards of the management system. */
function checkStandards(system: System, standardIds: readonly string[], path: string): void {
  if (standardIds.some((id) => !system.standardIds.includes(id))) {
    invalid(path, 'Not a standard of this management system');
  }
}

/** Issuing sets the number, issue and expiry dates together, and the certificate expires after it is issued. */
function checkIssued(certificate: Certificate): void {
  const issued = certificate.issuedOn !== null;
  if (issued !== (certificate.expiresOn !== null)) {
    invalid('expiresOn', 'issuedOn and expiresOn are set together');
  }
  if (issued !== (certificate.certificateNumber !== null)) {
    invalid('certificateNumber', 'An issued certificate has a number, and only an issued one');
  }
  if (certificate.expiresOn !== null && certificate.expiresOn <= certificate.issuedOn!) {
    invalid('expiresOn', 'expiresOn must be after issuedOn');
  }
}

/** The visit ends on or after its first day, and the body's response deadline is not before its last day. */
function checkVisit(visit: Pick<Audit, 'startOn' | 'endOn' | 'responseDueOn'>): void {
  if (visit.endOn < visit.startOn) invalid('endOn', 'The audit ends after it starts');
  if (visit.responseDueOn !== null && visit.responseDueOn < visit.endOn) {
    invalid('responseDueOn', 'The response is due on or after the last day of the visit');
  }
}

/** A visit recorded as held has ended. */
function checkEnded(endOn: string, today: string): void {
  if (endOn > today) invalid('endOn', 'The visit has not ended yet');
}

/** RECORD_HELD needs the body's report as a live file on the external audit that has not failed its scan. */
function checkReport(firm: FirmState, audit: Audit): void {
  finishIsoScans(firm);
  const report = firm.iso.files.some(
    (f) =>
      f.clientId === audit.clientId &&
      f.externalAuditId === audit.id &&
      f.archivedAt === null &&
      REPORT_SCANS.includes(f.scanStatus),
  );
  if (!report) invalid('file', "Upload the certification body's report first");
}

/** A finding's clauses are clauses of the audit's standards in the account's catalogue copy. */
function checkFindingClauses(firm: FirmState, audit: Audit, clauseIds: readonly string[]): void {
  for (const id of clauseIds) {
    const clause = clauseOf(firm, id);
    if (clause === undefined || !audit.standardIds.includes(clause.standardId)) {
      invalid('clauseIds', "Not a clause of the audit's standards");
    }
  }
}

/** A finding's unit is one of the audit's units (its system's). */
function checkFindingUnit(reach: IsoReach, unitId: string | null | undefined): void {
  if (unitId != null && !reach.unitIds.includes(unitId))
    invalid('unitId', 'Not a unit of this audit');
}

/**
 * The nonconformity's owner and approver work in the client and cover its unit (model §1.5), in a role that can take
 * their steps (plan §3.2 `isoNc.work` and `isoNc.verify`): an owner or client admin, an approver or client admin. The
 * same check as for an internal finding's nonconformity.
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

/** Codes of the standards of the finding's clauses, else of the audit's standards; in code order. */
function ncStandards(
  firm: FirmState,
  audit: Audit,
  clauseIds: readonly string[],
): IsoStandardCode[] {
  const fromClauses = clauseIds.map((id) => clauseOf(firm, id)!.standardId);
  const ids = fromClauses.length > 0 ? fromClauses : audit.standardIds;
  const codes = new Set(ids.map((id) => standardOf(firm, id)?.code));
  return IsoStandardCode.options.filter((code) => codes.has(code));
}

/** The next nonconformity number of the client (a per-client sequence from 1, archived rows included). */
const nextNcNumber = (firm: FirmState, clientId: string) =>
  firm.iso.nonconformities
    .filter((n) => n.clientId === clientId)
    .reduce((max, n) => Math.max(max, n.number), 0) + 1;

// ---------- writes ----------

/** The defined fields of a body. */
const definedOf = <T extends object>(fields: T): Partial<T> =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<T>;

/** A new record's own fields, for its CREATE event. */
const fieldsOf = (row: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).filter(([key]) => !BASE_FIELDS.includes(key)));

/** Writes a new record and its CREATE event (model §8), whose `after` is the record's own fields unless given. */
function create<T extends { id: string; clientId: string }>(
  ctx: IsoCtx,
  actor: Actor,
  table: T[],
  row: T,
  entityType: IsoEntity,
  after: Record<string, unknown> = fieldsOf(row),
): T {
  table.push(row);
  isoAudit(ctx, actor, {
    action: 'CREATE',
    entityType,
    entityId: row.id,
    clientId: row.clientId,
    after,
  });
  return row;
}

/**
 * Applies an external audit edit and audits it (model §8): moving the body's response deadline is a due-date change
 * with the reason, every other field an UPDATE. Nothing is written when nothing changed.
 */
function editAudit(
  ctx: IsoCtx,
  actor: Actor,
  audit: Audit,
  patch: Partial<Audit>,
  reason: string | null,
): void {
  const changes = diff(audit, { ...audit, ...patch });
  const changed = Object.keys(changes.after);
  if (changed.length === 0) return;
  Object.assign(audit, patch);
  touchIso(ctx, audit);
  const groups: [AuditRecord['action'], string[]][] = [
    ['DUE_DATE_CHANGE', changed.filter((k) => k === 'responseDueOn')],
    ['UPDATE', changed.filter((k) => k !== 'responseDueOn')],
  ];
  for (const [action, keys] of groups) {
    if (keys.length === 0) continue;
    isoAudit(ctx, actor, {
      action,
      entityType: 'external_audit',
      entityId: audit.id,
      clientId: audit.clientId,
      before: Object.fromEntries(keys.map((k) => [k, changes.before[k]])),
      after: Object.fromEntries(keys.map((k) => [k, changes.after[k]])),
      reason: action === 'UPDATE' ? null : reason,
    });
  }
}

/**
 * Applies an arrow of the external-audit machine (model §4.4) and audits it as a TRANSITION naming the action, with the
 * fields it changed. The client admin takes these steps; an account admin or consultant takes them as delegate.
 */
function moveAudit(
  ctx: IsoCtx,
  actor: Actor,
  audit: Audit,
  action: ExternalAuditAction,
  change: Partial<Audit>,
  reason: string | null = null,
): void {
  const changes = diff(audit, { ...audit, ...change });
  Object.assign(audit, change);
  touchIso(ctx, audit);
  isoAudit(ctx, actor, {
    action: 'TRANSITION',
    entityType: 'external_audit',
    entityId: audit.id,
    clientId: audit.clientId,
    before: changes.before,
    after: { action, ...changes.after },
    reason,
    ...(isClientAdmin(actor, audit.clientId) ? {} : { delegated: true }),
  });
}

/**
 * The nonconformity a MAJOR_NC or MINOR_NC finding raises (model §3.9): OPEN, source EXTERNAL_AUDIT, severity from the
 * type, the finding's clauses and unit (or the system's single unit), its standards from the clauses (else the
 * audit's), owner, approver and due date from the body; reported by the actor on the client's day.
 */
function raiseNc(
  ctx: IsoCtx,
  actor: Actor,
  audit: Audit,
  reach: IsoReach,
  finding: Pick<Finding, 'type' | 'clauseIds' | 'unitId' | 'description'>,
  raise: { ownerId: string; approverId: string; dueOn: string },
): Nonconformity {
  const firm = actor.firm;
  const today = ctx.clock.today();
  const unitId = finding.unitId ?? (reach.unitIds.length === 1 ? reach.unitIds[0]! : null);
  checkNcPerson(actor, audit.clientId, raise.ownerId, 'ownerId', unitId);
  checkNcPerson(actor, audit.clientId, raise.approverId, 'approverId', unitId);
  if (raise.dueOn < today) {
    invalidAt(['nonconformity', 'dueOn'], 'The nonconformity is due today or later');
  }
  return {
    ...isoFresh(ctx, actor, audit.clientId),
    managementSystemId: audit.managementSystemId,
    number: nextNcNumber(firm, audit.clientId),
    source: 'EXTERNAL_AUDIT',
    sourceInstanceId: null,
    raisedFromRiskItemId: null,
    severity: finding.type === 'MAJOR_NC' ? 'MAJOR' : 'MINOR',
    standards: ncStandards(firm, audit, finding.clauseIds),
    clauseIds: [...finding.clauseIds],
    unitId,
    description: finding.description,
    reportedById: actor.person.id,
    reportedOn: clientDay(firm, audit.clientId, ctx.clock.now()),
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

// ---------- handlers ----------

export const certificationsHandlers: PartialHandlers<Ids> = {
  /**
   * Soonest expiry first, certificates not yet issued last, then by creation. AP and OW see the certificates over
   * their units (an empty list means the system's units).
   */
  listIsoCertifications(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const q = ctx.query;
    const rows = liveIso(actor.firm, 'certifications', clientId)
      .filter(
        (c) =>
          (q.managementSystemId === undefined ||
            q.managementSystemId.includes(c.managementSystemId)) &&
          (q.standardId === undefined || q.standardId.includes(c.standardId)) &&
          canSee(actor, certificateReach(actor.firm, c)),
      )
      .sort(
        (a, b) =>
          (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31') ||
          byCreation(a, b),
      );
    return paginate(
      rows.map((c) => certificateView(ctx, actor, c)),
      q,
    );
  },

  /** A certificate for one standard of a system, issued or being pursued, over units of the system. */
  createIsoCertification(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const clientId = ctx.params.clientId!;
    const { managementSystemId, ...fields } = ctx.body;
    const system = requireSystem(firm, clientId, managementSystemId);
    // The writer must cover the certificate's units (or, with none listed or units not of the system, the system's).
    const units = systemUnitIds(firm, system);
    const unitsOk = fields.unitIds.every((u) => units.includes(u));
    ctx.authorize(
      isoScope(
        actor,
        reachOf(firm, { clientId, unitIds: unitsOk ? fields.unitIds : [], systemId: system.id }),
      ),
    );
    checkStandards(system, [fields.standardId], 'standardId');
    checkSystemUnits(firm, system, fields.unitIds, 'unitIds');
    const certificate: Certificate = {
      ...isoFresh(ctx, actor, clientId),
      managementSystemId,
      ...fields,
    };
    create(ctx, actor, firm.iso.certifications, certificate, 'certification');
    return certificateView(ctx, actor, certificate);
  },

  /** Field edits, and issuing: number, issue and expiry dates together, checked on the merged certificate. */
  updateIsoCertification(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const certificate = requireCertificate(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, certificateReach(firm, certificate)));
    const { version, ...fields } = ctx.body;
    checkIsoVersion(certificate, version);
    const patch = definedOf(fields) as Partial<Certificate>;
    if (fields.unitIds !== undefined) {
      checkSystemUnits(firm, systemOf(firm, certificate), fields.unitIds, 'unitIds');
    }
    checkIssued({ ...certificate, ...patch });
    patchIso(ctx, actor, certificate, version, patch, 'certification');
    return certificateView(ctx, actor, certificate);
  },

  /** By start date, then by creation. AP and OW see the visits of systems over their units. */
  listIsoExternalAudits(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const q = ctx.query;
    const rows = liveIso(actor.firm, 'externalAudits', clientId)
      .filter(
        (a) =>
          (q.managementSystemId === undefined ||
            q.managementSystemId.includes(a.managementSystemId)) &&
          (q.state === undefined || q.state.includes(a.state)) &&
          (q.type === undefined || q.type.includes(a.type)) &&
          (q.from === undefined || a.startOn >= q.from) &&
          (q.to === undefined || a.startOn <= q.to) &&
          canSee(actor, auditReach(actor.firm, a)),
      )
      .sort((a, b) => a.startOn.localeCompare(b.startOn) || byCreation(a, b));
    return paginate(
      rows.map((a) => auditView(actor, a)),
      q,
    );
  },

  /** Plans a visit (PLANNED) covering standards of one system. */
  createIsoExternalAudit(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const clientId = ctx.params.clientId!;
    const body = ctx.body;
    const system = requireSystem(firm, clientId, body.managementSystemId);
    ctx.authorize(isoScope(actor, reachOf(firm, { clientId, systemId: system.id })));
    checkStandards(system, body.standardIds, 'standardIds');
    checkVisit(body);
    const audit: Audit = {
      ...isoFresh(ctx, actor, clientId),
      managementSystemId: system.id,
      standardIds: body.standardIds,
      type: body.type,
      body: body.body,
      leadAuditorName: body.leadAuditorName,
      startOn: body.startOn,
      endOn: body.endOn,
      recommendation: null,
      responseDueOn: body.responseDueOn,
      state: 'PLANNED',
      cancelReason: null,
    };
    create(ctx, actor, firm.iso.externalAudits, audit, 'external_audit');
    return auditView(actor, audit);
  },

  getIsoExternalAudit(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, auditReach(actor.firm, audit)));
    return auditView(actor, audit);
  },

  /**
   * Field edits until CLOSED or CANCELLED. A recommendation is recorded once the visit is held; a held visit keeps its
   * end in the past; a standard a finding names a clause of cannot be dropped.
   */
  updateIsoExternalAudit(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, auditReach(firm, audit)));
    const { version, reason, ...fields } = ctx.body;
    checkIsoVersion(audit, version);
    if (!EDITABLE.includes(audit.state)) invalidTransition('external_audit', audit.state, 'UPDATE');
    const patch = definedOf(fields) as Partial<Audit>;
    const merged: Audit = { ...audit, ...patch };
    if (fields.standardIds !== undefined) {
      checkStandards(systemOf(firm, audit), fields.standardIds, 'standardIds');
      const named = findingsOf(firm, audit).flatMap((f) => f.clauseIds);
      if (named.some((id) => !fields.standardIds!.includes(clauseOf(firm, id)!.standardId))) {
        invalid('standardIds', 'A finding of this audit names a clause of that standard');
      }
    }
    checkVisit(merged);
    if (audit.state === 'PLANNED') {
      if (merged.recommendation !== null) {
        invalid('recommendation', 'A recommendation is recorded once the visit is held');
      }
    } else {
      checkEnded(merged.endOn, ctx.clock.today());
    }
    editAudit(ctx, actor, audit, patch, reason ?? null);
    return auditView(actor, audit);
  },

  /** RECORD_HELD (client admin): PLANNED → HELD with the visit's dates, once the body's report is on the audit. */
  recordIsoExternalAuditHeld(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, auditReach(actor.firm, audit)));
    const body = ctx.body;
    checkIsoVersion(audit, body.version);
    if (audit.state !== 'PLANNED') {
      invalidTransition('external_audit', audit.state, 'RECORD_HELD');
    }
    const responseDueOn =
      body.responseDueOn === undefined ? audit.responseDueOn : body.responseDueOn;
    checkVisit({ startOn: body.startOn, endOn: body.endOn, responseDueOn });
    checkEnded(body.endOn, ctx.clock.today());
    checkReport(actor.firm, audit);
    moveAudit(ctx, actor, audit, 'RECORD_HELD', {
      state: 'HELD',
      startOn: body.startOn,
      endOn: body.endOn,
      recommendation: body.recommendation,
      responseDueOn,
    });
    return auditView(actor, audit);
  },

  /** RECORD_RESPONSE (client admin): HELD → RESPONDED once every nonconformity its findings raised has left OPEN. */
  recordIsoExternalAuditResponse(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, auditReach(actor.firm, audit)));
    checkIsoVersion(audit, ctx.body.version);
    if (audit.state !== 'HELD') {
      invalidTransition('external_audit', audit.state, 'RECORD_RESPONSE');
    }
    const open = raisedNcs(actor.firm, audit).filter((n) => n.state === 'OPEN');
    if (open.length > 0) {
      invalid(
        'nonconformities',
        `Nonconformity ${open.map((n) => n.number).join(', ')} is still OPEN: record its root cause first`,
      );
    }
    moveAudit(ctx, actor, audit, 'RECORD_RESPONSE', { state: 'RESPONDED' });
    return auditView(actor, audit);
  },

  /**
   * CLOSE (client admin): RESPONDED → CLOSED, or HELD → CLOSED when no finding raised a nonconformity; the body's
   * recommendation is recorded here or before.
   */
  closeIsoExternalAudit(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, auditReach(actor.firm, audit)));
    const body = ctx.body;
    checkIsoVersion(audit, body.version);
    if (audit.state !== 'HELD' && audit.state !== 'RESPONDED') {
      invalidTransition('external_audit', audit.state, 'CLOSE');
    }
    const recommendation = body.recommendation ?? audit.recommendation;
    if (recommendation === null) {
      invalid('recommendation', "Record the certification body's recommendation");
    }
    if (audit.state === 'HELD' && raisedNcs(actor.firm, audit).length > 0) {
      invalid('nonconformities', 'Its findings raised nonconformities: record the response first');
    }
    moveAudit(ctx, actor, audit, 'CLOSE', { state: 'CLOSED', recommendation });
    return auditView(actor, audit);
  },

  /** CANCEL (client admin): PLANNED → CANCELLED, with a reason. */
  cancelIsoExternalAudit(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, auditReach(actor.firm, audit)));
    const { version, reason } = ctx.body;
    checkIsoVersion(audit, version);
    if (audit.state !== 'PLANNED') invalidTransition('external_audit', audit.state, 'CANCEL');
    moveAudit(ctx, actor, audit, 'CANCEL', { state: 'CANCELLED', cancelReason: reason }, reason);
    return auditView(actor, audit);
  },

  /** In the order they were recorded. Whoever reads the audit reads its findings. */
  listIsoExternalFindings(ctx) {
    const actor = actorOf(ctx);
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    ctx.authorize(isoScope(actor, auditReach(actor.firm, audit)));
    return { items: findingsOf(actor.firm, audit).sort(byCreation) };
  },

  /**
   * Records a finding of a HELD visit. A MAJOR_NC or MINOR_NC raises its nonconformity in the same step (model §3.9)
   * and links it; the nonconformity is audited as raised (CREATE with action RAISE). Neither event copies the
   * description (non-negotiable 6), as on an internal audit.
   */
  createIsoExternalFinding(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    const reach = auditReach(firm, audit);
    ctx.authorize(isoScope(actor, reach));
    if (audit.state !== 'HELD') invalidTransition('external_audit', audit.state, 'UPDATE');
    const { nonconformity: raise, ...fields } = ctx.body;
    checkFindingClauses(firm, audit, fields.clauseIds);
    checkFindingUnit(reach, fields.unitId);
    const nc = raise === undefined ? null : raiseNc(ctx, actor, audit, reach, fields, raise);
    const finding: Finding = {
      ...isoFresh(ctx, actor, audit.clientId),
      internalAuditId: null,
      externalAuditId: audit.id,
      ...fields,
      nonconformityId: nc?.id ?? null,
    };
    if (nc !== null) {
      create(ctx, actor, firm.iso.nonconformities, nc, 'nonconformity', {
        ...raiseEvent(nc),
        auditFindingId: finding.id,
      });
    }
    create(ctx, actor, firm.iso.findings, finding, 'audit_finding', {
      externalAuditId: audit.id,
      type: finding.type,
      clauseIds: finding.clauseIds,
      unitId: finding.unitId,
      nonconformityId: finding.nonconformityId,
    });
    return finding;
  },

  /**
   * Changes a finding while its visit is HELD. `type` moves only among OBSERVATION, OFI and GOOD_PRACTICE (a finding
   * with live actions cannot become GOOD_PRACTICE), or between MAJOR_NC and MINOR_NC, when its nonconformity's
   * severity follows: only while that nonconformity is OPEN or ROOT_CAUSE_FOUND (409 after) and never by its owner
   * (403), model §3.9. A description edit is audited as changed, not copied.
   */
  updateIsoExternalFinding(ctx) {
    const actor = actorOf(ctx);
    const firm = actor.firm;
    const audit = requireAudit(actor, ctx.params.clientId, ctx.params.id);
    const finding = requireFinding(firm, audit, ctx.params.findingId);
    const reach = auditReach(firm, audit);
    ctx.authorize(isoScope(actor, reach));
    const { version, ...fields } = ctx.body;
    checkIsoVersion(finding, version);
    if (audit.state !== 'HELD') invalidTransition('external_audit', audit.state, 'UPDATE');
    if (fields.clauseIds !== undefined) checkFindingClauses(firm, audit, fields.clauseIds);
    checkFindingUnit(reach, fields.unitId);
    const type = fields.type ?? finding.type;
    let nc: Nonconformity | undefined;
    if (type !== finding.type) {
      const raised = NC_TYPES.includes(finding.type);
      if (!(raised ? NC_TYPES : NON_NC_TYPES).includes(type)) {
        invalid(
          'type',
          raised
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
      if (raised) {
        nc = firm.iso.nonconformities.find((n) => n.id === finding.nonconformityId)!;
        // SUBMIT_NO_ACTION reads the severity, so its owner never moves it, and nobody after ROOT_CAUSE_FOUND.
        if (nc.ownerId === actor.person.id) {
          forbidden(
            'isoCertification.write',
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
      definedOf(fields) as Partial<Finding>,
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
