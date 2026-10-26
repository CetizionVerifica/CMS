import type {
  Action,
  IsoEntityType,
  IsoFileSubject,
  IsoFileSubjectType,
  RequestContext,
  Resource,
} from '@canopy/contracts';
import {
  certifications,
  clauseAssessments,
  controlledDocuments,
  documentRevisions,
  externalAudits,
  managementSystems,
  type TenantTx,
} from '@canopy/db';
import {
  authorize,
  canSee,
  certificateReach,
  checklistRowReach,
  documentReach,
  isoResource,
  systemReach,
  type Reach,
} from './access.js';
import { liveIn, type Core } from './db-context.js';
import { invalid, invalidTransition, notFound } from './errors.js';
import type { IsoFileCaller, IsoFiles } from './ports.js';
import type { IsoHandlers } from './types.js';

/**
 * ISO file routes (docs/iso/model.md §6) through the `IsoFiles` port. M16 resolves the subject (404 when the actor
 * cannot see it), checks the subject's own write action, then `isoFile.write` with the actor as owner and approver
 * (plan §3.2), then the lock rule (409); reads follow the subject's unit scope, and the current revision's file of an
 * active document is read by every member. ISO-8b and ISO-8c add their subjects to `SUBJECTS`.
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

/**
 * The subjects M3 stores files on until ISO-2e's tables are served (ISO-15): checklist rows, document revisions,
 * external audits and certificates.
 */
const SUBJECTS: Partial<Record<IsoFileSubjectType, Resolve>> = {
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
      lock: lockedIn(['CLOSED', 'CANCELLED'], 'external_audit', audit.state),
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
};

export function filesHandlers(core: Core, files: IsoFiles): IsoHandlers<Ids> {
  /** The subject, live in this client and seen by the actor (404 otherwise). */
  async function resolve(
    tx: TenantTx,
    ctx: RequestContext,
    clientId: string,
    ref: IsoFileSubject,
  ): Promise<Subject> {
    const resolver = SUBJECTS[ref.type];
    if (resolver === undefined)
      invalid('subject', 'Files cannot be added to this kind of record yet');
    const subject = await resolver(tx, clientId, ref.id);
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
