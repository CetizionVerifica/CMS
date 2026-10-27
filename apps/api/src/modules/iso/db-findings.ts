import {
  IsoStandardCode,
  NC_FINDING_TYPES,
  type Action,
  type AuditFinding,
  type FindingType,
  type LocalDate,
  type ManagementSystem,
  type Nonconformity,
  type RequestContext,
} from '@canopy/contracts';
import {
  auditFindings,
  isoActions,
  isoCatalogue,
  nonconformities,
  type TenantTx,
} from '@canopy/db';
import type { Core } from './db-context.js';
import {
  auditRaised,
  NC_APPROVER_ROLES,
  NC_OWNER_ROLES,
  raiseNonconformity,
  unrecorded,
} from './db-nonconformities.js';
import { forbidden, invalid, invalidTransition } from './errors.js';

/**
 * Audit findings, internal and external (docs/iso/model.md §3.9): the clause check, recording a finding with the
 * nonconformity a MAJOR_NC or MINOR_NC raises in the same step, and the finding edit with its type rules. The mock's
 * picks (docs/contracts/iso-mock.md "Audits") hold here.
 */

/** Finding types that may change into one another (FindingUpdateBody). */
const NON_NC_TYPES: readonly FindingType[] = ['OBSERVATION', 'OFI', 'GOOD_PRACTICE'];
const NC_TYPES: readonly FindingType[] = NC_FINDING_TYPES;
/** Nonconformity states in which a finding's type may still move its severity (model §3.9). */
const SEVERITY_STATES: readonly string[] = ['OPEN', 'ROOT_CAUSE_FOUND'];

/** Each id is a live clause of one of `standardIds` in the account's catalogue; 400 on `path` otherwise. */
export async function checkClauses(
  tx: TenantTx,
  standardIds: readonly string[],
  clauseIds: readonly string[],
  path: string,
  message: string,
): Promise<void> {
  for (const id of clauseIds) {
    const clause = await isoCatalogue.clause(tx, id);
    if (clause === null || clause.archivedAt !== null || !standardIds.includes(clause.standardId)) {
      invalid(path, message);
    }
  }
}

/** Codes of the standards of `clauseIds`, else of `fallback` (standard ids), in code order. */
export async function standardsOf(
  tx: TenantTx,
  clauseIds: readonly string[],
  fallback: readonly string[],
): Promise<IsoStandardCode[]> {
  const codeOf = new Map((await isoCatalogue.standards(tx)).map((s) => [s.id, s.code]));
  const fromClauses: string[] = [];
  for (const id of clauseIds) {
    const clause = await isoCatalogue.clause(tx, id);
    if (clause !== null) fromClauses.push(clause.standardId);
  }
  const codes = new Set(
    (fromClauses.length > 0 ? fromClauses : fallback).map((id) => codeOf.get(id)),
  );
  return IsoStandardCode.options.filter((code) => codes.has(code));
}

/** What a MAJOR_NC or MINOR_NC finding's nonconformity needs from the body (FindingNcBody). */
export interface FindingNc {
  ownerId: string;
  approverId: string;
  dueOn: LocalDate;
}

/** The finding as recorded: its audit, its fields, and where its nonconformity sits. */
export interface NewFinding {
  audit: { internalAuditId: string } | { externalAuditId: string };
  type: FindingType;
  clauseIds: string[];
  unitId: string | null;
  description: string;
  nc?: {
    body: FindingNc;
    source: 'INTERNAL_AUDIT' | 'EXTERNAL_AUDIT';
    unitId: string | null;
    standards: IsoStandardCode[];
  };
}

/**
 * Records a finding (model §3.9). A MAJOR_NC or MINOR_NC first raises its nonconformity: its owner and approver work
 * in the client and cover its unit in a role that can take their steps, and it is due no earlier than the client's
 * today (400 on `nonconformity.<field>`). The RAISE event names the finding; neither event copies the description.
 */
export async function recordFinding(
  core: Core,
  tx: TenantTx,
  ctx: RequestContext,
  system: ManagementSystem,
  input: NewFinding,
): Promise<AuditFinding> {
  const clientId = system.clientId;
  let nc: Nonconformity | null = null;
  if (input.nc !== undefined) {
    const { body } = input.nc;
    const person = (field: 'ownerId' | 'approverId') =>
      core.checkPerson(tx, clientId, body[field], ['nonconformity', field], {
        unitId: input.nc!.unitId,
        roles: field === 'ownerId' ? NC_OWNER_ROLES : NC_APPROVER_ROLES,
      });
    await person('ownerId');
    await person('approverId');
    if (body.dueOn < (await core.today(tx, clientId))) {
      invalid(['nonconformity', 'dueOn'], 'The nonconformity is due today or later');
    }
    nc = await raiseNonconformity(
      core,
      tx,
      ctx,
      system,
      {
        source: input.nc.source,
        sourceInstanceId: null,
        raisedFromRiskItemId: null,
        severity: input.type === 'MAJOR_NC' ? 'MAJOR' : 'MINOR',
        standards: input.nc.standards,
        clauseIds: input.clauseIds,
        unitId: input.nc.unitId,
        description: input.description,
        containment: null,
        correction: null,
        ownerId: body.ownerId,
        approverId: body.approverId,
        dueOn: body.dueOn,
        incident: null,
      },
      { fromFinding: true },
    );
  }
  const internalAuditId = 'internalAuditId' in input.audit ? input.audit.internalAuditId : null;
  const externalAuditId = 'externalAuditId' in input.audit ? input.audit.externalAuditId : null;
  const finding = await auditFindings.create(tx, {
    clientId,
    internalAuditId,
    externalAuditId,
    type: input.type,
    clauseIds: input.clauseIds,
    unitId: input.unitId,
    description: input.description,
    nonconformityId: nc?.id ?? null,
  });
  if (nc !== null) await auditRaised(core, tx, ctx, nc, finding.id);
  await core.audit(tx, ctx, clientId, {
    action: 'CREATE',
    entityType: 'audit_finding',
    entityId: finding.id,
    after: {
      ...(internalAuditId === null ? { externalAuditId } : { internalAuditId }),
      type: finding.type,
      clauseIds: finding.clauseIds,
      unitId: finding.unitId,
      nonconformityId: finding.nonconformityId,
    },
  });
  return finding;
}

/**
 * Changes a finding (FindingUpdateBody, model §3.9). `type` moves only among OBSERVATION, OFI and GOOD_PRACTICE (not
 * to GOOD_PRACTICE while an action on it is live), or between MAJOR_NC and MINOR_NC, when its nonconformity's severity
 * follows: only while that nonconformity is OPEN or ROOT_CAUSE_FOUND (409 after) and never by its owner (403 naming
 * `grant`). The description is audited as changed, not copied (non-negotiable 6).
 */
export async function editFinding(
  core: Core,
  tx: TenantTx,
  ctx: RequestContext,
  finding: AuditFinding,
  fields: Partial<Pick<AuditFinding, 'type' | 'clauseIds' | 'unitId' | 'description'>>,
  version: number,
  grant: Action,
): Promise<AuditFinding> {
  const type = fields.type ?? finding.type;
  let nc: Nonconformity | null = null;
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
      const actions = await isoActions.forSubject(tx, { type: 'AUDIT_FINDING', id: finding.id });
      if (actions.some((a) => a.state !== 'CANCELLED')) {
        invalid('type', 'A GOOD_PRACTICE finding has no actions: cancel its actions first');
      }
    }
    if (raised) {
      nc = await nonconformities.require(tx, finding.nonconformityId!);
      // SUBMIT_NO_ACTION reads the severity, so its owner never moves it, and nobody after ROOT_CAUSE_FOUND.
      if (nc.ownerId === ctx.personId) {
        forbidden(grant, 'You own its nonconformity, so someone else moves its type');
      }
      if (!SEVERITY_STATES.includes(nc.state)) {
        invalidTransition('nonconformity', nc.state, 'UPDATE');
      }
    }
  }
  const updated = await core.edit<AuditFinding>(
    tx,
    ctx,
    finding,
    fields,
    'audit_finding',
    (changes) => auditFindings.update(tx, finding.id, version, changes),
    { record: unrecorded },
  );
  if (nc !== null) {
    const ncNow = nc;
    await core.edit<Nonconformity>(
      tx,
      ctx,
      ncNow,
      { severity: type === 'MAJOR_NC' ? 'MAJOR' : 'MINOR' },
      'nonconformity',
      (changes) => nonconformities.update(tx, ncNow.id, ncNow.version, changes),
    );
  }
  return updated;
}
