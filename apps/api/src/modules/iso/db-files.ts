import type {
  Action,
  IsoEntityType,
  IsoFileSubject,
  IsoFileSubjectType,
  RequestContext,
  Resource,
} from '@canopy/contracts';
import {
  auditFindings,
  auditProgrammes,
  certifications,
  clauseAssessments,
  controlledDocuments,
  documentRevisions,
  externalAudits,
  internalAudits,
  isoActions,
  managementReviews,
  managementSystems,
  nonconformities,
  objectiveReadings,
  objectives,
  riskItems,
  type TenantTx,
} from '@canopy/db';
import {
  authorize,
  canSee,
  certificateReach,
  checklistRowReach,
  documentReach,
  isoResource,
  objectiveReach,
  reviewReach,
  riskReach,
  selfResource,
  systemReach,
  type Reach,
} from './access.js';
import { actionReach, actionSubject, checkIncidentDownload } from './db-actions.js';
import { auditTeam, internalAuditReach } from './db-audits.js';
import { liveIn, type Core } from './db-context.js';
import { ncReach } from './db-nonconformities.js';
import { invalidTransition, notFound } from './errors.js';
import type { IsoFileCaller, IsoFiles } from './ports.js';
import type { IsoHandlers } from './types.js';

/**
 * ISO file routes (docs/iso/model.md §6) through the `IsoFiles` port. M16 resolves the subject (404 when the actor
 * cannot see it), checks the subject's own write action, then `isoFile.write` with the actor as owner and approver
 * (plan §3.2), then the lock rule (409); reads follow the subject's unit scope, and the current revision's file of an
 * active document is read by every member. Every file subject has its rules in `SUBJECTS`.
 */

type Ids =
  'isoFileUploadUrl' | 'confirmIsoFile' | 'listIsoFiles' | 'isoFileDownloadUrl' | 'removeIsoFile';

/** A file's subject as the file rules read it. */
export interface Subject extends IsoFileSubject {
  clientId: string;
  /** The subject's units (a child record takes its parent's) and the people it names. */
  reach: Reach;
  /** Readable by every member of the client: the current revision of an active document (model §4.2, §6). */
  clientWide: boolean;
  /** The subject's own write action (plan §3.2) and the `Resource` it takes for this actor. */
  write: { action: Action; resource: (ctx: RequestContext) => Resource };
  /** Why files can no longer be added or removed (model §6): the locked record and its state; null while open. */
  lock: { entity: IsoEntityType; from: string } | null;
  /** A download rule of the subject's own (ISO-8c: an incident's files); throws to refuse. */
  download?: (ctx: RequestContext) => void;
}

type Resolve = (tx: TenantTx, clientId: string, id: string) => Promise<Subject>;

const lockedIn = (states: readonly string[], entity: IsoEntityType, state: string) =>
  states.includes(state) ? { entity, from: state } : null;

/** REPORTED, CLOSED and CANCELLED internal audits lock their files and their findings' (model §6). */
const INTERNAL_AUDIT_LOCKED: readonly string[] = ['REPORTED', 'CLOSED', 'CANCELLED'];
const EXTERNAL_AUDIT_LOCKED: readonly string[] = ['CLOSED', 'CANCELLED'];
const REVIEW_LOCKED: readonly string[] = ['CLOSED', 'CANCELLED'];

/** An internal audit's file rules, for itself and its findings: the audit team writes them (`isoAudit.conduct`). */
async function internalAuditSubject(
  tx: TenantTx,
  clientId: string,
  auditId: string,
  ref: IsoFileSubject,
): Promise<Subject> {
  const audit = liveIn(await internalAudits.get(tx, auditId), clientId);
  const programme = await auditProgrammes.require(tx, audit.programmeId);
  const reach = internalAuditReach(
    await managementSystems.require(tx, programme.managementSystemId),
    audit,
  );
  return {
    ...ref,
    clientId,
    reach,
    clientWide: false,
    write: {
      action: 'isoAudit.conduct',
      resource: (ctx) => selfResource(ctx, ref.type, reach, auditTeam(audit)),
    },
    lock: lockedIn(INTERNAL_AUDIT_LOCKED, 'internal_audit', audit.state),
  };
}

/**
 * The subjects M16 serves files on: checklist rows, document revisions, external audits and certificates
 * (ISO-8a), risk items, objective readings and actions (ISO-8b), and nonconformities, internal audits, findings and
 * management reviews (ISO-8c).
 */
const SUBJECTS: Record<IsoFileSubjectType, Resolve> = {
  async clause_assessment(tx, clientId, id) {
    const row = liveIn(await clauseAssessments.get(tx, id), clientId);
    const system = await managementSystems.require(tx, row.managementSystemId);
    const reach = checklistRowReach(system, row);
    return {
      type: 'clause_assessment',
      id,
      clientId,
      reach,
      clientWide: false,
      write: {
        action: 'isoChecklist.write',
        resource: (ctx) => isoResource(ctx, 'clause_assessment', reach, { ownerId: row.ownerId }),
      },
      lock: null,
    };
  },
  async document_revision(tx, clientId, id) {
    const revision = liveIn(await documentRevisions.get(tx, id), clientId);
    const doc = await controlledDocuments.require(tx, revision.documentId);
    const system = await managementSystems.require(tx, doc.managementSystemId);
    const reach = documentReach(system, doc);
    return {
      type: 'document_revision',
      id,
      clientId,
      reach,
      clientWide: doc.status === 'ACTIVE' && doc.currentRevisionId === revision.id,
      write: {
        action: 'isoDocument.write',
        resource: (ctx) => isoResource(ctx, 'controlled_document', reach, { ownerId: doc.ownerId }),
      },
      // In review the approver sends it back to change the file; once approved, a new revision fixes it.
      lock:
        revision.state !== 'DRAFT'
          ? { entity: 'document_revision', from: revision.state }
          : lockedIn(['OBSOLETE'], 'controlled_document', doc.status),
    };
  },
  async external_audit(tx, clientId, id) {
    const audit = liveIn(await externalAudits.get(tx, id), clientId);
    const reach = systemReach(await managementSystems.require(tx, audit.managementSystemId));
    return {
      type: 'external_audit',
      id,
      clientId,
      reach,
      clientWide: false,
      write: {
        action: 'isoCertification.write',
        resource: (ctx) => isoResource(ctx, 'external_audit', reach),
      },
      lock: lockedIn(EXTERNAL_AUDIT_LOCKED, 'external_audit', audit.state),
    };
  },
  internal_audit: (tx, clientId, id) =>
    internalAuditSubject(tx, clientId, id, { type: 'internal_audit', id }),
  async audit_finding(tx, clientId, id) {
    const finding = liveIn(await auditFindings.get(tx, id), clientId);
    const ref = { type: 'audit_finding' as const, id };
    if (finding.internalAuditId !== null) {
      return internalAuditSubject(tx, clientId, finding.internalAuditId, ref);
    }
    const audit = await externalAudits.require(tx, finding.externalAuditId!);
    const reach = systemReach(await managementSystems.require(tx, audit.managementSystemId));
    return {
      ...ref,
      clientId,
      reach,
      clientWide: false,
      write: {
        action: 'isoCertification.write',
        resource: (ctx) => isoResource(ctx, 'audit_finding', reach),
      },
      lock: lockedIn(EXTERNAL_AUDIT_LOCKED, 'external_audit', audit.state),
    };
  },
  async management_review(tx, clientId, id) {
    const review = liveIn(await managementReviews.get(tx, id), clientId);
    const reach = reviewReach(
      await managementSystems.require(tx, review.managementSystemId),
      review,
    );
    return {
      type: 'management_review',
      id,
      clientId,
      reach,
      clientWide: false,
      // The chair is "own" (plan §3.2); an attendee reads the files but does not change them.
      write: {
        action: 'isoReview.write',
        resource: (ctx) => selfResource(ctx, 'management_review', reach, [review.chairId]),
      },
      lock: lockedIn(REVIEW_LOCKED, 'management_review', review.state),
    };
  },
  async certification(tx, clientId, id) {
    const certificate = liveIn(await certifications.get(tx, id), clientId);
    const system = await managementSystems.require(tx, certificate.managementSystemId);
    const reach = certificateReach(system, certificate);
    return {
      type: 'certification',
      id,
      clientId,
      reach,
      clientWide: false,
      write: {
        action: 'isoCertification.write',
        resource: (ctx) => isoResource(ctx, 'certification', reach),
      },
      lock: null,
    };
  },
  async risk_item(tx, clientId, id) {
    const item = liveIn(await riskItems.get(tx, id), clientId);
    const reach = riskReach(await managementSystems.require(tx, item.managementSystemId), item);
    return {
      type: 'risk_item',
      id,
      clientId,
      reach,
      clientWide: false,
      write: {
        action: 'isoRisk.write',
        resource: (ctx) => isoResource(ctx, 'risk_item', reach, { ownerId: item.ownerId }),
      },
      lock: null,
    };
  },
  async objective_reading(tx, clientId, id) {
    const reading = liveIn(await objectiveReadings.get(tx, id), clientId);
    const objective = liveIn(await objectives.get(tx, reading.objectiveId), clientId);
    const system = await managementSystems.require(tx, objective.managementSystemId);
    const reach = objectiveReach(system, objective);
    return {
      type: 'objective_reading',
      id,
      clientId,
      reach,
      clientWide: false,
      write: {
        action: 'isoObjective.write',
        resource: (ctx) => isoResource(ctx, 'objective', reach, { ownerId: objective.ownerId }),
      },
      lock: objective.closedOn === null ? null : { entity: 'objective', from: 'CLOSED' },
    };
  },
  async nonconformity(tx, clientId, id) {
    const nc = liveIn(await nonconformities.get(tx, id), clientId);
    const reach = ncReach(await managementSystems.require(tx, nc.managementSystemId), nc);
    return {
      type: 'nonconformity',
      id,
      clientId,
      reach,
      clientWide: false,
      // CA, or OW as its owner: FA and CO read an NC's files but do not add or remove them (iso-mock.md).
      write: {
        action: 'isoNc.work',
        resource: (ctx) => isoResource(ctx, 'nonconformity', reach, { ownerId: nc.ownerId }),
      },
      lock: lockedIn(['CLOSED', 'CANCELLED'], 'nonconformity', nc.state),
      download: (ctx) => checkIncidentDownload(ctx, nc),
    };
  },
  async iso_action(tx, clientId, id) {
    const action = liveIn(await isoActions.get(tx, id), clientId);
    const subject = await actionSubject(tx, clientId, action.subject, false);
    const reach = actionReach(subject, action);
    // "own" is the subject's owner or the action's (plan §3.2).
    const owners = [subject.ownerId, action.ownerId];
    return {
      type: 'iso_action',
      id,
      clientId,
      reach,
      clientWide: false,
      write: {
        action: 'isoAction.write',
        resource: (ctx) =>
          isoResource(ctx, 'iso_action', reach, {
            ownerId: owners.includes(ctx.personId) ? ctx.personId : subject.ownerId,
          }),
      },
      // Done or cancelled, its files are its record; on an open action, a closed nonconformity's lock (model §6).
      lock:
        action.state !== 'OPEN'
          ? { entity: 'iso_action', from: action.state }
          : subject.nc === undefined
            ? null
            : lockedIn(['CLOSED', 'CANCELLED'], 'nonconformity', subject.nc.state),
      download: (ctx) => checkIncidentDownload(ctx, subject.nc),
    };
  },
};

export function filesHandlers(core: Core, files: IsoFiles): IsoHandlers<Ids> {
  /** The subject, live in this client and seen by the actor (404 otherwise). */
  async function resolve(
    tx: TenantTx,
    ctx: RequestContext,
    clientId: string,
    ref: IsoFileSubject,
  ): Promise<Subject> {
    const subject = await SUBJECTS[ref.type](tx, clientId, ref.id);
    if (!canSee(ctx, subject.reach) && !subject.clientWide) notFound();
    return subject;
  }

  /** Who reads the subject reads its files (unit scope, plan §3.3); the current revision of a document, everyone. */
  function authorizeRead(ctx: RequestContext, subject: Subject): void {
    authorize(
      ctx,
      'isoFile.read',
      subject.clientWide && !canSee(ctx, subject.reach)
        ? { type: subject.type, clientId: subject.clientId }
        : isoResource(ctx, subject.type, subject.reach),
    );
  }

  /**
   * `isoFile.write` is "whoever may write the subject" (plan §3.2): the subject's own write action first, then
   * `isoFile.write` with the actor as owner and approver; then a locked subject answers 409 (model §6).
   */
  function authorizeWrite(ctx: RequestContext, subject: Subject): void {
    if (!canSee(ctx, subject.reach)) notFound();
    authorize(ctx, subject.write.action, subject.write.resource(ctx));
    authorize(
      ctx,
      'isoFile.write',
      isoResource(ctx, subject.type, subject.reach, {
        ownerId: ctx.personId,
        approverId: ctx.personId,
      }),
    );
    if (subject.lock !== null) invalidTransition(subject.lock.entity, subject.lock.from, 'UPDATE');
  }

  const callerOf = (ctx: RequestContext): IsoFileCaller => ({
    firmId: ctx.firmId,
    personId: ctx.personId,
    requestId: ctx.requestId,
  });

  /** A live file of this client and its subject. */
  async function fileAndSubject(tx: TenantTx, ctx: RequestContext, clientId: string, id: string) {
    const file = liveIn(await files.get(tx, id), clientId);
    return resolve(tx, ctx, clientId, file.subject);
  }

  return {
    async isoFileUploadUrl({ ctx, params, body }) {
      const clientId = params.clientId!;
      return core.run(ctx, async (tx) => {
        const { subject: ref, ...file } = body;
        const subject = await resolve(tx, ctx, clientId, ref);
        authorizeWrite(ctx, subject);
        return files.uploadUrl(tx, callerOf(ctx), ref, file);
      });
    },

    async confirmIsoFile({ ctx, params, body }) {
      const clientId = params.clientId!;
      return core.run(ctx, async (tx) => {
        const { subject: ref, ...upload } = body;
        const subject = await resolve(tx, ctx, clientId, ref);
        authorizeWrite(ctx, subject);
        return files.confirm(tx, callerOf(ctx), ref, upload);
      });
    },

    async listIsoFiles({ ctx, params, query }) {
      const clientId = params.clientId!;
      return core.run(ctx, async (tx) => {
        const ref = { type: query.subjectType, id: query.subjectId };
        authorizeRead(ctx, await resolve(tx, ctx, clientId, ref));
        return {
          items: await files.list(
            tx,
            ref,
            query.includeRemoved === true ? { includeRemoved: true } : {},
          ),
        };
      });
    },

    async isoFileDownloadUrl({ ctx, params }) {
      const clientId = params.clientId!;
      return core.run(ctx, async (tx) => {
        const subject = await fileAndSubject(tx, ctx, clientId, params.id!);
        authorizeRead(ctx, subject);
        subject.download?.(ctx);
        return files.downloadUrl(tx, callerOf(ctx), params.id!);
      });
    },

    async removeIsoFile({ ctx, params, body }) {
      const clientId = params.clientId!;
      return core.run(ctx, async (tx) => {
        authorizeWrite(ctx, await fileAndSubject(tx, ctx, clientId, params.id!));
        return files.remove(tx, callerOf(ctx), params.id!, body.reason);
      });
    },
  };
}
