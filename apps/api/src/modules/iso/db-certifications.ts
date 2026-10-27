import type {
  Certification,
  CertificationView,
  ExternalAudit,
  ExternalAuditView,
  ManagementSystem,
  RequestContext,
} from '@canopy/contracts';
import {
  certifications,
  externalAudits,
  isoFiles,
  managementSystems,
  type TenantTx,
} from '@canopy/db';
import { certificationCycle, isoTransition } from '@canopy/engine';
import {
  authorize,
  canSee,
  certificateReach,
  holdsRole,
  isoResource,
  listScope,
  may,
  systemReach,
} from './access.js';
import { definedOf, liveIn, type Core } from './db-context.js';
import { checkVersion, invalid, invalidTransition, notFound, stepTo } from './errors.js';
import { pageOf } from './paging.js';
import type { IsoCall, IsoHandlers } from './types.js';

/**
 * Certificates and external audit visits (docs/iso/model.md §3.8, §4.4). ISO-8a takes an external audit through
 * RECORD_HELD and CANCEL; RECORD_RESPONSE, CLOSE and findings are ISO-8c's. The mock's picks
 * (docs/contracts/iso-mock.md "Certifications") hold here.
 */

type Ids =
  | 'listIsoCertifications'
  | 'createIsoCertification'
  | 'updateIsoCertification'
  | 'listIsoExternalAudits'
  | 'createIsoExternalAudit'
  | 'getIsoExternalAudit'
  | 'updateIsoExternalAudit'
  | 'recordIsoExternalAuditHeld'
  | 'cancelIsoExternalAudit';

/** States in which an external audit's fields may change; CLOSED and CANCELLED lock it (model §6). */
const EDITABLE: readonly string[] = ['PLANNED', 'HELD', 'RESPONDED'];
/** Scan states of a file that can stand as the body's report: not INFECTED, and not a failed scan. */
const REPORT_SCANS: readonly string[] = ['PENDING', 'CLEAN'];

/** The standards are standards of the management system (model §3.8). */
function checkStandards(
  system: ManagementSystem,
  standardIds: readonly string[],
  path: string,
): void {
  if (standardIds.some((id) => !system.standardIds.includes(id))) {
    invalid(path, 'Not a standard of this management system');
  }
}

/** Issuing sets the number, issue and expiry dates together, and the certificate expires after it is issued. */
function checkIssued(c: Pick<Certification, 'issuedOn' | 'expiresOn' | 'certificateNumber'>): void {
  const issued = c.issuedOn !== null;
  if (issued !== (c.expiresOn !== null))
    invalid('expiresOn', 'issuedOn and expiresOn are set together');
  if (issued !== (c.certificateNumber !== null)) {
    invalid('certificateNumber', 'An issued certificate has a number, and only an issued one');
  }
  if (c.expiresOn !== null && c.expiresOn <= c.issuedOn!) {
    invalid('expiresOn', 'expiresOn must be after issuedOn');
  }
}

/** The visit ends on or after its first day, and the body's response deadline is not before its last day. */
function checkVisit(visit: Pick<ExternalAudit, 'startOn' | 'endOn' | 'responseDueOn'>): void {
  if (visit.endOn < visit.startOn) invalid('endOn', 'The audit ends after it starts');
  if (visit.responseDueOn !== null && visit.responseDueOn < visit.endOn) {
    invalid('responseDueOn', 'The response is due on or after the last day of the visit');
  }
}

export function certificationsHandlers(core: Core): IsoHandlers<Ids> {
  /** The live external audits of a system, for the certification cycle. */
  async function auditsOf(tx: TenantTx, system: ManagementSystem): Promise<ExternalAudit[]> {
    const out: ExternalAudit[] = [];
    let cursor: string | null = null;
    do {
      const page = await externalAudits.list(tx, system.clientId, {
        managementSystemIds: [system.id],
        limit: 200,
        ...(cursor === null ? {} : { cursor }),
      });
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return out;
  }

  async function certificateView(
    tx: TenantTx,
    certificate: Certification,
    system: ManagementSystem,
  ): Promise<CertificationView> {
    const today = await core.today(tx, certificate.clientId);
    return {
      ...certificate,
      cycle: certificationCycle(certificate, await auditsOf(tx, system), today),
    };
  }

  /** The steps the actor may take now (model §4.4): RECORD_HELD and CANCEL while PLANNED, for a writer of its units. */
  function auditView(
    ctx: RequestContext,
    system: ManagementSystem,
    audit: ExternalAudit,
  ): ExternalAuditView {
    const writes = may(
      ctx,
      'isoCertification.write',
      isoResource(ctx, 'external_audit', systemReach(system)),
    );
    return {
      ...audit,
      allowedActions: writes && audit.state === 'PLANNED' ? ['RECORD_HELD', 'CANCEL'] : [],
    };
  }

  async function loadCertificate(tx: TenantTx, ctx: RequestContext, clientId: string, id: string) {
    const certificate = liveIn(await certifications.get(tx, id), clientId);
    const system = await managementSystems.require(tx, certificate.managementSystemId);
    const reach = certificateReach(system, certificate);
    if (!canSee(ctx, reach)) notFound();
    return { certificate, system, reach };
  }

  async function loadAudit(tx: TenantTx, ctx: RequestContext, clientId: string, id: string) {
    const audit = liveIn(await externalAudits.get(tx, id), clientId);
    const system = await managementSystems.require(tx, audit.managementSystemId);
    if (!canSee(ctx, systemReach(system))) notFound();
    return { audit, system };
  }

  /**
   * One arrow of the external-audit machine through the engine, audited as a TRANSITION naming the action. The
   * client admin takes these steps; an account admin or consultant takes them as delegate.
   */
  async function auditStep<K extends 'recordIsoExternalAuditHeld' | 'cancelIsoExternalAudit'>(
    call: IsoCall<K>,
    action: 'RECORD_HELD' | 'CANCEL',
    facts: (tx: TenantTx, audit: ExternalAudit) => Promise<Record<string, unknown>>,
    change: (audit: ExternalAudit) => Partial<ExternalAudit>,
  ): Promise<ExternalAuditView> {
    const { ctx, params, body } = call;
    return core.keyed(ctx, call.key, async (tx) => {
      const { audit, system } = await loadAudit(tx, ctx, params.clientId!, params.id!);
      authorize(
        ctx,
        'isoCertification.write',
        isoResource(ctx, 'external_audit', systemReach(system)),
      );
      checkVersion(audit, body.version);
      const to = stepTo(
        isoTransition('EXTERNAL_AUDIT', audit.state, action, await facts(tx, audit)),
        'external_audit',
        audit.state,
        action,
      );
      const patch = { ...change(audit), state: to } as Partial<ExternalAudit>;
      const keys = Object.keys(patch) as (keyof ExternalAudit)[];
      const updated = await externalAudits.update(tx, audit.id, audit.version, patch);
      await core.audit(tx, ctx, audit.clientId, {
        action: 'TRANSITION',
        entityType: 'external_audit',
        entityId: audit.id,
        before: Object.fromEntries(keys.map((k) => [k, audit[k]])),
        after: { action, ...Object.fromEntries(keys.map((k) => [k, updated[k]])) },
        reason: 'reason' in body ? body.reason : null,
        delegated: !holdsRole(ctx, audit.clientId, ['CLIENT_ADMIN']),
      });
      return auditView(ctx, system, updated);
    });
  }

  return {
    /**
     * Soonest expiry first, certificates not yet issued last, then by creation. AP and OW see the certificates over
     * their units (an empty list means the system's units).
     */
    async listIsoCertifications({ ctx, params, query }) {
      const clientId = params.clientId!;
      authorize(ctx, 'isoCertification.read', { type: 'certification', clientId });
      return core.run(ctx, async (tx) => {
        const all: Certification[] = [];
        let cursor: string | null = null;
        do {
          const page = await certifications.list(tx, clientId, {
            limit: 200,
            ...definedOf({
              cursor: cursor ?? undefined,
              managementSystemIds: query.managementSystemId,
              standardIds: query.standardId,
              scope: listScope(ctx, clientId),
            }),
          });
          all.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor !== null);
        // M3 lists by creation (uuid v7 ids); the expiry order is stable on top of it.
        all.sort((a, b) =>
          (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31'),
        );
        const page = pageOf(all, query);
        const items: CertificationView[] = [];
        for (const c of page.items) {
          items.push(
            await certificateView(tx, c, await managementSystems.require(tx, c.managementSystemId)),
          );
        }
        return { ...page, items };
      });
    },

    /** A certificate for one standard of a system, issued or being pursued, over units of the system. */
    async createIsoCertification({ ctx, params, body }) {
      const clientId = params.clientId!;
      return core.run(ctx, async (tx) => {
        const { managementSystemId, ...fields } = body;
        const system = await core.loadSystem(tx, ctx, clientId, managementSystemId);
        // The writer must cover the certificate's units (or, with none listed or units not of the system, the system's).
        const unitsOk =
          system.unitIds.length === 0 || fields.unitIds.every((u) => system.unitIds.includes(u));
        authorize(
          ctx,
          'isoCertification.write',
          isoResource(ctx, 'certification', {
            clientId,
            unitIds: unitsOk && fields.unitIds.length > 0 ? fields.unitIds : system.unitIds,
            people: [],
          }),
        );
        checkStandards(system, [fields.standardId], 'standardId');
        await core.checkSystemUnits(tx, system, fields.unitIds, 'unitIds');
        const certificate = await certifications.create(tx, {
          clientId,
          managementSystemId,
          ...fields,
        });
        await core.audit(tx, ctx, clientId, {
          action: 'CREATE',
          entityType: 'certification',
          entityId: certificate.id,
          after: { managementSystemId, ...fields },
        });
        return certificateView(tx, certificate, system);
      });
    },

    /** Field edits, and issuing: number, issue and expiry dates together, checked on the merged certificate. */
    async updateIsoCertification({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { certificate, system, reach } = await loadCertificate(
          tx,
          ctx,
          params.clientId!,
          params.id!,
        );
        authorize(ctx, 'isoCertification.write', isoResource(ctx, 'certification', reach));
        const { version, ...fields } = body;
        checkVersion(certificate, version);
        if (fields.unitIds !== undefined)
          await core.checkSystemUnits(tx, system, fields.unitIds, 'unitIds');
        checkIssued({ ...certificate, ...definedOf(fields) });
        const updated = await core.edit(tx, ctx, certificate, fields, 'certification', (changes) =>
          certifications.update(tx, certificate.id, version, changes),
        );
        return certificateView(tx, updated, system);
      });
    },

    /** By start date, then by creation. AP and OW see the visits of systems over their units. */
    async listIsoExternalAudits({ ctx, params, query }) {
      const clientId = params.clientId!;
      authorize(ctx, 'isoCertification.read', { type: 'external_audit', clientId });
      return core.run(ctx, async (tx) => {
        const page = await externalAudits.list(tx, clientId, {
          limit: query.limit,
          ...definedOf({
            cursor: query.cursor,
            count: query.count,
            managementSystemIds: query.managementSystemId,
            state: query.state,
            type: query.type,
            from: query.from,
            to: query.to,
            scope: listScope(ctx, clientId),
          }),
        });
        const items: ExternalAuditView[] = [];
        for (const audit of page.items) {
          items.push(
            auditView(ctx, await managementSystems.require(tx, audit.managementSystemId), audit),
          );
        }
        return { ...page, items };
      });
    },

    /** Plans a visit (PLANNED) covering standards of one system. */
    async createIsoExternalAudit({ ctx, params, body }) {
      const clientId = params.clientId!;
      return core.run(ctx, async (tx) => {
        const system = await core.loadSystem(tx, ctx, clientId, body.managementSystemId);
        authorize(
          ctx,
          'isoCertification.write',
          isoResource(ctx, 'external_audit', systemReach(system)),
        );
        checkStandards(system, body.standardIds, 'standardIds');
        checkVisit(body);
        const audit = await externalAudits.create(tx, {
          clientId,
          ...body,
          recommendation: null,
          state: 'PLANNED',
          cancelReason: null,
        });
        await core.audit(tx, ctx, clientId, {
          action: 'CREATE',
          entityType: 'external_audit',
          entityId: audit.id,
          after: { ...body, recommendation: null, state: 'PLANNED', cancelReason: null },
        });
        return auditView(ctx, system, audit);
      });
    },

    async getIsoExternalAudit({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const { audit, system } = await loadAudit(tx, ctx, params.clientId!, params.id!);
        authorize(
          ctx,
          'isoCertification.read',
          isoResource(ctx, 'external_audit', systemReach(system)),
        );
        return auditView(ctx, system, audit);
      });
    },

    /**
     * Field edits until CLOSED or CANCELLED. A recommendation is recorded once the visit is held; a held visit keeps
     * its end in the past. Moving the body's response deadline is a due-date change with the reason.
     */
    async updateIsoExternalAudit({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { audit, system } = await loadAudit(tx, ctx, params.clientId!, params.id!);
        authorize(
          ctx,
          'isoCertification.write',
          isoResource(ctx, 'external_audit', systemReach(system)),
        );
        const { version, reason, ...fields } = body;
        checkVersion(audit, version);
        if (!EDITABLE.includes(audit.state))
          invalidTransition('external_audit', audit.state, 'UPDATE');
        const merged: ExternalAudit = { ...audit, ...definedOf(fields) };
        if (fields.standardIds !== undefined)
          checkStandards(system, fields.standardIds, 'standardIds');
        checkVisit(merged);
        if (audit.state === 'PLANNED') {
          if (merged.recommendation !== null) {
            invalid('recommendation', 'A recommendation is recorded once the visit is held');
          }
        } else if (merged.endOn > (await core.today(tx, audit.clientId))) {
          invalid('endOn', 'The visit has not ended yet');
        }
        const updated = await core.edit(
          tx,
          ctx,
          audit,
          fields,
          'external_audit',
          (changes) => externalAudits.update(tx, audit.id, version, changes),
          { split: { responseDueOn: 'DUE_DATE_CHANGE' }, reason: reason ?? null },
        );
        return auditView(ctx, system, updated);
      });
    },

    /** RECORD_HELD: PLANNED → HELD with the visit's dates, once the body's report is on the audit. */
    recordIsoExternalAuditHeld: (call) => {
      const { body } = call;
      const responseDueOn = (audit: ExternalAudit) =>
        body.responseDueOn === undefined ? audit.responseDueOn : body.responseDueOn;
      return auditStep(
        call,
        'RECORD_HELD',
        async (tx, audit) => {
          const files = await isoFiles.forSubject(tx, { type: 'external_audit', id: audit.id });
          return {
            startOn: body.startOn,
            endOn: body.endOn,
            responseDueOn: responseDueOn(audit),
            asOf: await core.today(tx, audit.clientId),
            reportFileCount: files.filter((f) => REPORT_SCANS.includes(f.scanStatus)).length,
          };
        },
        (audit) => ({
          startOn: body.startOn,
          endOn: body.endOn,
          recommendation: body.recommendation,
          responseDueOn: responseDueOn(audit),
        }),
      );
    },

    /** CANCEL: PLANNED → CANCELLED, with a reason. */
    cancelIsoExternalAudit: (call) =>
      auditStep(
        call,
        'CANCEL',
        async () => ({ reason: call.body.reason }),
        () => ({ cancelReason: call.body.reason }),
      ),
  };
}
