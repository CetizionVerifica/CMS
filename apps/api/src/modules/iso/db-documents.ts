import type {
  ControlledDocument,
  DocumentRevision,
  DocumentView,
  LocalDate,
  ManagementSystem,
  RequestContext,
  RevisionView,
} from '@canopy/contracts';
import {
  controlledDocuments,
  documentRevisions,
  isoCatalogue,
  isoFiles,
  managementSystems,
  type DocumentFilter,
  type TenantTx,
} from '@canopy/db';
import { isoMayCheck, isoTiming, isoTransition } from '@canopy/engine';
import { ApiError } from '../../auth/index.js';
import {
  authorize,
  canSee,
  documentReach,
  isoResource,
  listScope,
  may,
  systemReach,
  type Reach,
} from './access.js';
import { definedOf, liveIn, type Core } from './db-context.js';
import { checkVersion, forbidden, invalid, invalidTransition, notFound, stepTo } from './errors.js';
import type { IsoCall, IsoHandlers } from './types.js';

/**
 * Controlled documents and their revisions (docs/iso/model.md §3.4, §4.2). Steps go through the engine's DOCUMENT and
 * DOCUMENT_REVISION machines; the mock's picks (docs/contracts/iso-mock.md "Documents") hold here.
 */

type Ids =
  | 'listIsoDocuments'
  | 'createIsoDocument'
  | 'getIsoDocument'
  | 'updateIsoDocument'
  | 'reviewIsoDocument'
  | 'obsoleteIsoDocument'
  | 'listIsoRevisions'
  | 'draftIsoRevision'
  | 'updateIsoRevision'
  | 'submitIsoRevision'
  | 'approveIsoRevision'
  | 'sendBackIsoRevision'
  | 'recordIsoEdition';

type Access = 'scope' | 'inForce' | 'none';

interface Loaded {
  doc: ControlledDocument;
  system: ManagementSystem;
  reach: Reach;
  access: Access;
}

/** An ACTIVE document with an approved revision: every member of the client reads it (model §4.2, plan §3.3). */
const inForce = (doc: ControlledDocument) =>
  doc.status === 'ACTIVE' && doc.currentRevisionId !== null;

/**
 * How the actor reaches a document: within unit scope or named on it, only as a member of the client reading the
 * revision in force, or not at all.
 */
function accessTo(ctx: RequestContext, doc: ControlledDocument, reach: Reach): Access {
  if (canSee(ctx, reach)) return 'scope';
  if (inForce(doc) && ctx.clientIds.includes(doc.clientId)) return 'inForce';
  return 'none';
}

const OPEN_STATES: readonly string[] = ['DRAFT', 'IN_REVIEW'];

/** Edit audit groups: people are a reassignment, `reviewDueOn` a due-date change (model §8), each with the reason. */
const EDIT_SPLIT = {
  ownerId: 'REASSIGN',
  approverId: 'REASSIGN',
  reviewDueOn: 'DUE_DATE_CHANGE',
} as const;

export function documentsHandlers(core: Core): IsoHandlers<Ids> {
  async function load(
    tx: TenantTx,
    ctx: RequestContext,
    clientId: string,
    id: string,
  ): Promise<Loaded> {
    const doc = liveIn(await controlledDocuments.get(tx, id), clientId);
    const system = await managementSystems.require(tx, doc.managementSystemId);
    const reach = documentReach(system, doc);
    const access = accessTo(ctx, doc, reach);
    if (access === 'none') notFound();
    return { doc, system, reach, access };
  }

  /** A revision of the document, or 404 (another document's revision included). */
  async function revisionOf(
    tx: TenantTx,
    doc: ControlledDocument,
    id: string,
  ): Promise<DocumentRevision> {
    const revision = liveIn(await documentRevisions.get(tx, id), doc.clientId);
    if (revision.documentId !== doc.id) notFound();
    return revision;
  }

  /** The role check for a read: a member reading only the revision in force needs just the client. */
  function authorizeRead(ctx: RequestContext, { doc, reach, access }: Loaded): void {
    authorize(
      ctx,
      'isoDocument.read',
      access === 'inForce'
        ? { type: 'controlled_document', clientId: doc.clientId }
        : isoResource(ctx, 'controlled_document', reach),
    );
  }

  /** The `Resource` for the owner's steps (`isoDocument.write`, OW own) or the approver's (`isoDocument.approve`). */
  const stepResource = (ctx: RequestContext, { doc, reach }: Loaded, step: 'owner' | 'approver') =>
    isoResource(
      ctx,
      'controlled_document',
      reach,
      step === 'owner' ? { ownerId: doc.ownerId } : { approverId: doc.approverId },
    );

  const stepAction = (step: 'owner' | 'approver') =>
    step === 'owner' ? 'isoDocument.write' : 'isoDocument.approve';

  /** A member who reads the document only through its revision in force may not change it (403, not 404). */
  function authorizeStep(ctx: RequestContext, loaded: Loaded, step: 'owner' | 'approver'): void {
    if (loaded.access === 'inForce') {
      forbidden(stepAction(step), 'This document is outside your units');
    }
    authorize(ctx, stepAction(step), stepResource(ctx, loaded, step));
  }

  const takesStep = (ctx: RequestContext, loaded: Loaded, step: 'owner' | 'approver') =>
    loaded.access === 'scope' && may(ctx, stepAction(step), stepResource(ctx, loaded, step));

  async function documentView(
    tx: TenantTx,
    ctx: RequestContext,
    loaded: Loaded,
    today: LocalDate,
    dueSoonDays: number,
  ): Promise<DocumentView> {
    const { doc, access } = loaded;
    const revisions = await documentRevisions.forDocument(tx, doc.id);
    const current = revisions.find((r) => r.id === doc.currentRevisionId);
    // Only readers within scope learn of a revision in the works.
    const open =
      access === 'scope' ? revisions.find((r) => OPEN_STATES.includes(r.state)) : undefined;
    const allowedActions: DocumentView['allowedActions'] = [];
    if (doc.status === 'ACTIVE') {
      if (open === undefined && takesStep(ctx, loaded, 'owner'))
        allowedActions.push('DRAFT_REVISION');
      if (takesStep(ctx, loaded, 'approver')) {
        if (doc.currentRevisionId !== null) allowedActions.push('REVIEW');
        allowedActions.push('MAKE_OBSOLETE');
      }
    }
    return {
      ...doc,
      currentRevision: current?.revision ?? null,
      openRevisionId: open?.id ?? null,
      // `reviewDue` (model §5.2); an obsolete document is no longer reviewed.
      reviewStatus: isoTiming(doc.reviewDueOn, doc.status === 'OBSOLETE', today, { dueSoonDays }),
      allowedActions,
    };
  }

  async function revisionView(
    tx: TenantTx,
    ctx: RequestContext,
    loaded: Loaded,
    revision: DocumentRevision,
  ): Promise<RevisionView> {
    const { doc } = loaded;
    const external = doc.type === 'EXTERNAL';
    const allowedActions: RevisionView['allowedActions'] = [];
    if (doc.status === 'ACTIVE') {
      if (revision.state === 'DRAFT' && takesStep(ctx, loaded, 'owner')) {
        allowedActions.push(external ? 'RECORD_EDITION' : 'SUBMIT');
      }
      if (revision.state === 'IN_REVIEW' && !external && takesStep(ctx, loaded, 'approver')) {
        const steps = await core.steps(tx, 'document_revision', revision.id);
        if (isoMayCheck('DOCUMENT_REVISION', 'APPROVE', ctx.personId, steps)) {
          allowedActions.push('APPROVE');
        }
        allowedActions.push('SEND_BACK');
      }
    }
    return { ...revision, allowedActions };
  }

  async function view(tx: TenantTx, ctx: RequestContext, loaded: Loaded): Promise<DocumentView> {
    const cal = await core.calendar(tx, loaded.doc.clientId);
    return documentView(
      tx,
      ctx,
      loaded,
      await core.today(tx, loaded.doc.clientId),
      cal.dueSoonDays,
    );
  }

  /** Each clause id is a live clause of the account's catalogue in one of the system's standards (model §1.4). */
  async function checkClauses(
    tx: TenantTx,
    system: ManagementSystem,
    clauseIds: readonly string[],
  ): Promise<void> {
    for (const id of clauseIds) {
      const clause = await isoCatalogue.clause(tx, id);
      if (
        clause === null ||
        clause.archivedAt !== null ||
        !system.standardIds.includes(clause.standardId)
      ) {
        invalid('clauseIds', "Not a clause of the system's standards");
      }
    }
  }

  /** Codes are unique per client, whatever the document's status (model §3.4); compared without case. */
  async function checkCode(tx: TenantTx, clientId: string, code: string): Promise<void> {
    let cursor: string | null = null;
    do {
      const page = await controlledDocuments.list(tx, clientId, {
        q: code,
        status: ['ACTIVE', 'OBSOLETE'],
        limit: 200,
        ...(cursor === null ? {} : { cursor }),
      });
      const clash = page.items.find((d) => d.code.toLowerCase() === code.toLowerCase());
      if (clash !== undefined) {
        throw new ApiError(
          'DUPLICATE',
          { field: 'code', existingId: clash.id },
          `A document with code "${code}" already exists`,
        );
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  /** A revision label names one revision of its document, ignoring case, so the history reads unambiguously. */
  async function checkLabel(
    tx: TenantTx,
    doc: ControlledDocument,
    label: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = (await documentRevisions.forDocument(tx, doc.id)).find(
      (r) => r.id !== exceptId && r.revision.toLowerCase() === label.toLowerCase(),
    );
    if (clash !== undefined) {
      throw new ApiError(
        'DUPLICATE',
        { field: 'revision', existingId: clash.id },
        `This document already has a revision "${label}"`,
      );
    }
  }

  /** `retention` belongs to FORM documents, `issuer` and `externalRef` to EXTERNAL ones (model §3.4). */
  function checkTypeFields(
    type: ControlledDocument['type'],
    fields: { retention?: string | null; issuer?: string | null; externalRef?: string | null },
  ): void {
    if (type !== 'FORM' && fields.retention != null)
      invalid('retention', 'Only a FORM has retention');
    if (type !== 'EXTERNAL') {
      if (fields.issuer != null) invalid('issuer', 'Only an EXTERNAL document has an issuer');
      if (fields.externalRef != null) {
        invalid('externalRef', 'Only an EXTERNAL document has an external reference');
      }
    }
  }

  /** The revision's live files and how many passed the scan: the facts of ONE_CLEAN_FILE. */
  async function fileFacts(tx: TenantTx, revision: DocumentRevision) {
    const files = await isoFiles.forSubject(tx, { type: 'document_revision', id: revision.id });
    return {
      liveFileCount: files.length,
      cleanFileCount: files.filter((f) => f.scanStatus === 'CLEAN').length,
    };
  }

  /** A step on a revision of an OBSOLETE document names the document (model §1.8); else the revision. */
  function refuse(doc: ControlledDocument, revision: DocumentRevision, action: string): never {
    if (doc.status !== 'ACTIVE') invalidTransition('controlled_document', doc.status, action);
    return invalidTransition('document_revision', revision.state, action);
  }

  /** Applies a step to a revision and audits it as a TRANSITION naming the action (model §8). */
  async function moveRevision(
    tx: TenantTx,
    ctx: RequestContext,
    revision: DocumentRevision,
    action: string,
    change: Partial<DocumentRevision>,
    options: {
      reason?: string;
      note?: string;
      delegated?: boolean;
      after?: Record<string, unknown>;
    } = {},
  ): Promise<DocumentRevision> {
    const updated = await documentRevisions.update(tx, revision.id, revision.version, change);
    const keys = Object.keys(change) as (keyof DocumentRevision)[];
    await core.audit(tx, ctx, revision.clientId, {
      action: 'TRANSITION',
      entityType: 'document_revision',
      entityId: revision.id,
      before: Object.fromEntries(keys.map((k) => [k, revision[k]])),
      after: {
        action,
        ...Object.fromEntries(keys.map((k) => [k, updated[k]])),
        ...(options.note === undefined ? {} : { note: options.note }),
        ...options.after,
      },
      reason: options.reason ?? null,
      delegated: options.delegated === true,
    });
    return updated;
  }

  /**
   * APPROVE and RECORD_EDITION (model §4.2), in this order in one transaction: the APPROVED revision it replaces becomes
   * SUPERSEDED (one APPROVED revision per document), this one APPROVED, then the document's `currentRevisionId` moves
   * to it (a trigger checks it names an APPROVED revision of the document).
   */
  async function putInForce(
    tx: TenantTx,
    ctx: RequestContext,
    doc: ControlledDocument,
    revision: DocumentRevision,
    action: 'APPROVE' | 'RECORD_EDITION',
    change: Partial<DocumentRevision>,
    options: { note?: string; delegated: boolean },
  ): Promise<{ doc: ControlledDocument; revision: DocumentRevision }> {
    for (const previous of await documentRevisions.forDocument(tx, doc.id)) {
      if (previous.state !== 'APPROVED' || previous.id === revision.id) continue;
      await moveRevision(
        tx,
        ctx,
        previous,
        'SUPERSEDE',
        { state: 'SUPERSEDED' },
        {
          after: { supersededById: revision.id },
        },
      );
    }
    const approved = await moveRevision(tx, ctx, revision, action, change, options);
    const updated = await controlledDocuments.update(tx, doc.id, doc.version, {
      currentRevisionId: revision.id,
    });
    await core.audit(tx, ctx, doc.clientId, {
      action: 'UPDATE',
      entityType: 'controlled_document',
      entityId: doc.id,
      before: { currentRevisionId: doc.currentRevisionId },
      after: { currentRevisionId: revision.id },
    });
    return { doc: updated, revision: approved };
  }

  /** The client's systems by id, archived ones included (a document keeps its system's units). */
  async function systemsOf(tx: TenantTx, clientId: string): Promise<Map<string, ManagementSystem>> {
    const out = new Map<string, ManagementSystem>();
    let cursor: string | null = null;
    do {
      const page = await managementSystems.list(tx, clientId, {
        includeArchived: true,
        limit: 200,
        ...(cursor === null ? {} : { cursor }),
      });
      for (const system of page.items) out.set(system.id, system);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return out;
  }

  /**
   * One revision step on a document (`step` names whose it is): load, role check, version, then the engine's arrow
   * with its facts; maker-checker for APPROVE; then the change.
   */
  async function revisionStep<
    K extends
      'submitIsoRevision' | 'approveIsoRevision' | 'sendBackIsoRevision' | 'recordIsoEdition',
  >(
    call: IsoCall<K>,
    step: 'owner' | 'approver',
    action: 'SUBMIT' | 'APPROVE' | 'SEND_BACK' | 'RECORD_EDITION',
    apply: (tx: TenantTx, loaded: Loaded, revision: DocumentRevision) => Promise<DocumentRevision>,
  ): Promise<RevisionView> {
    const { ctx, params, body } = call;
    return core.keyed(ctx, call.key, async (tx) => {
      const loaded = await load(tx, ctx, params.clientId!, params.id!);
      const revision = await revisionOf(tx, loaded.doc, params.revisionId!);
      authorizeStep(ctx, loaded, step);
      checkVersion(revision, body.version);
      const { doc } = loaded;
      const files =
        action === 'SUBMIT' || action === 'RECORD_EDITION' ? await fileFacts(tx, revision) : {};
      const result = isoTransition('DOCUMENT_REVISION', revision.state, action, {
        documentType: doc.type,
        documentStatus: doc.status,
        changeNote: revision.changeNote,
        issuer: doc.issuer,
        externalRef: doc.externalRef,
        reason: 'reason' in body ? body.reason : null,
        ...files,
      });
      if (!result.ok && result.error === 'INVALID_TRANSITION') refuse(doc, revision, action);
      if (
        !isoMayCheck(
          'DOCUMENT_REVISION',
          action,
          ctx.personId,
          await core.steps(tx, 'document_revision', revision.id),
        )
      ) {
        forbidden(
          'isoDocument.approve',
          'You prepared or submitted this revision, so someone else approves it',
        );
      }
      stepTo(result, 'document_revision', revision.state, action);
      const moved = await apply(tx, loaded, revision);
      const reloaded = await load(tx, ctx, doc.clientId, doc.id);
      return revisionView(tx, ctx, reloaded, moved);
    });
  }

  /** A document step (REVIEW, MAKE_OBSOLETE): the approver's, through the engine's DOCUMENT machine. */
  async function documentStep<K extends 'reviewIsoDocument' | 'obsoleteIsoDocument'>(
    call: IsoCall<K>,
    action: 'REVIEW' | 'MAKE_OBSOLETE',
    apply: (tx: TenantTx, loaded: Loaded, today: LocalDate) => Promise<ControlledDocument>,
  ): Promise<DocumentView> {
    const { ctx, params, body } = call;
    return core.keyed(ctx, call.key, async (tx) => {
      const loaded = await load(tx, ctx, params.clientId!, params.id!);
      authorizeStep(ctx, loaded, 'approver');
      const { doc } = loaded;
      checkVersion(doc, body.version);
      const today = await core.today(tx, doc.clientId);
      stepTo(
        isoTransition('DOCUMENT', doc.status, action, {
          currentRevisionId: doc.currentRevisionId,
          asOf: today,
          ...body,
        }),
        'controlled_document',
        doc.status,
        action,
      );
      const updated = await apply(tx, loaded, today);
      return view(tx, ctx, { ...loaded, doc: updated });
    });
  }

  return {
    /**
     * Sorted by code (unique in the client). AP and OW see their units' documents, those naming them, and every
     * document in force.
     */
    async listIsoDocuments({ ctx, params, query }) {
      const clientId = params.clientId!;
      authorize(ctx, 'isoDocument.read', { type: 'controlled_document', clientId });
      const me = (ref: string | undefined) => (ref === 'me' ? ctx.personId : ref);
      const filter: DocumentFilter = definedOf({
        managementSystemIds: query.managementSystemId,
        q: query.q,
        type: query.type,
        status: query.status,
        ownerId: me(query.ownerId),
        approverId: me(query.approverId),
        clauseIds: query.clauseId,
      });
      return core.run(ctx, async (tx) => {
        const cal = await core.calendar(tx, clientId);
        const today = await core.today(tx, clientId);
        const systems = await systemsOf(tx, clientId);
        const loadedOf = (doc: ControlledDocument): Loaded => {
          const system = systems.get(doc.managementSystemId)!;
          const reach = documentReach(system, doc);
          return { doc, system, reach, access: accessTo(ctx, doc, reach) };
        };
        const page = { limit: query.limit, ...definedOf({ cursor: query.cursor }) };
        let items: ControlledDocument[];
        let nextCursor: string | null;
        let total: number | undefined;
        if (listScope(ctx, clientId) === undefined) {
          ({ items, nextCursor, total } = await controlledDocuments.list(tx, clientId, {
            ...filter,
            ...page,
            ...definedOf({ count: query.count }),
          }));
        } else {
          // Unit scope, or in force: walk the unscoped pages so documents of other units in force are listed too. Each
          // page read is used up, so its cursor is the next page's.
          const visible = (d: ControlledDocument) => loadedOf(d).access !== 'none';
          items = [];
          let cursor = page.cursor ?? null;
          do {
            const read = await controlledDocuments.list(tx, clientId, {
              ...filter,
              limit: page.limit - items.length,
              ...(cursor === null ? {} : { cursor }),
            });
            items.push(...read.items.filter(visible));
            cursor = read.nextCursor;
          } while (items.length < page.limit && cursor !== null);
          nextCursor = cursor;
          if (query.count === true) {
            total = 0;
            let next: string | null = null;
            do {
              const read = await controlledDocuments.list(tx, clientId, {
                ...filter,
                limit: 200,
                ...(next === null ? {} : { cursor: next }),
              });
              total += read.items.filter(visible).length;
              next = read.nextCursor;
            } while (next !== null);
          }
        }
        const views: DocumentView[] = [];
        for (const doc of items) {
          views.push(await documentView(tx, ctx, loadedOf(doc), today, cal.dueSoonDays));
        }
        return { items: views, nextCursor, ...(total === undefined ? {} : { total }) };
      });
    },

    async createIsoDocument({ ctx, params, body }) {
      const clientId = params.clientId!;
      return core.run(ctx, async (tx) => {
        const system = await core.loadSystem(tx, ctx, clientId, body.managementSystemId);
        // The creator must see the system; an owner adds documents only as their owner.
        authorize(
          ctx,
          'isoDocument.write',
          isoResource(ctx, 'controlled_document', systemReach(system), { ownerId: body.ownerId }),
        );
        await core.checkPerson(tx, clientId, body.ownerId, 'ownerId');
        await core.checkPerson(tx, clientId, body.approverId, 'approverId');
        await checkClauses(tx, system, body.clauseIds);
        await checkCode(tx, clientId, body.code);
        const doc = await controlledDocuments.create(tx, {
          clientId,
          ...body,
          status: 'ACTIVE',
          currentRevisionId: null,
          lastReviewedOn: null,
        });
        await core.audit(tx, ctx, clientId, {
          action: 'CREATE',
          entityType: 'controlled_document',
          entityId: doc.id,
          after: {
            managementSystemId: doc.managementSystemId,
            code: doc.code,
            title: doc.title,
            type: doc.type,
            clauseIds: doc.clauseIds,
            ownerId: doc.ownerId,
            approverId: doc.approverId,
            reviewDueOn: doc.reviewDueOn,
          },
        });
        return view(tx, ctx, { doc, system, reach: documentReach(system, doc), access: 'scope' });
      });
    },

    async getIsoDocument({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const loaded = await load(tx, ctx, params.clientId!, params.id!);
        authorizeRead(ctx, loaded);
        return view(tx, ctx, loaded);
      });
    },

    /** Title, clauses, people, review date and type fields, while ACTIVE; `code` and `type` never change. */
    async updateIsoDocument({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const loaded = await load(tx, ctx, params.clientId!, params.id!);
        authorizeStep(ctx, loaded, 'owner');
        const { doc, system } = loaded;
        const { version, reason, ...fields } = body;
        checkVersion(doc, version);
        if (doc.status !== 'ACTIVE') invalidTransition('controlled_document', doc.status, 'UPDATE');
        checkTypeFields(doc.type, fields);
        if (fields.clauseIds !== undefined) await checkClauses(tx, system, fields.clauseIds);
        if (fields.ownerId !== undefined) {
          await core.checkPerson(tx, doc.clientId, fields.ownerId, 'ownerId');
        }
        if (fields.approverId !== undefined) {
          await core.checkPerson(tx, doc.clientId, fields.approverId, 'approverId');
        }
        const updated = await core.edit(
          tx,
          ctx,
          doc,
          fields,
          'controlled_document',
          (changes) => controlledDocuments.update(tx, doc.id, version, changes),
          { split: EDIT_SPLIT, reason: reason ?? null },
        );
        const reach = documentReach(system, updated);
        return view(tx, ctx, {
          doc: updated,
          system,
          reach,
          access: accessTo(ctx, updated, reach),
        });
      });
    },

    /** REVIEW: the current revision still fits; no new revision. The note goes on the audit event. */
    reviewIsoDocument: (call) =>
      documentStep(call, 'REVIEW', async (tx, { doc }, today) => {
        const updated = await controlledDocuments.update(tx, doc.id, doc.version, {
          lastReviewedOn: today,
          reviewDueOn: call.body.nextReviewDueOn,
        });
        await core.audit(tx, call.ctx, doc.clientId, {
          action: 'TRANSITION',
          entityType: 'controlled_document',
          entityId: doc.id,
          before: { lastReviewedOn: doc.lastReviewedOn, reviewDueOn: doc.reviewDueOn },
          after: {
            action: 'REVIEW',
            lastReviewedOn: today,
            reviewDueOn: updated.reviewDueOn,
            note: call.body.note,
          },
          delegated: call.ctx.personId !== doc.approverId,
        });
        return updated;
      }),

    /** MAKE_OBSOLETE: the document leaves default lists; its revisions stay readable as history. */
    obsoleteIsoDocument: (call) =>
      documentStep(call, 'MAKE_OBSOLETE', async (tx, { doc }) => {
        const updated = await controlledDocuments.update(tx, doc.id, doc.version, {
          status: 'OBSOLETE',
        });
        await core.audit(tx, call.ctx, doc.clientId, {
          action: 'TRANSITION',
          entityType: 'controlled_document',
          entityId: doc.id,
          before: { status: 'ACTIVE' },
          after: { action: 'MAKE_OBSOLETE', status: 'OBSOLETE' },
          reason: call.body.reason,
          delegated: call.ctx.personId !== doc.approverId,
        });
        return updated;
      }),

    /**
     * Newest first. A member who reads the document only through its revision in force sees that revision alone.
     */
    async listIsoRevisions({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const loaded = await load(tx, ctx, params.clientId!, params.id!);
        authorizeRead(ctx, loaded);
        const rows = (await documentRevisions.forDocument(tx, loaded.doc.id)).filter(
          (r) => loaded.access === 'scope' || r.id === loaded.doc.currentRevisionId,
        );
        const items: RevisionView[] = [];
        for (const row of rows) items.push(await revisionView(tx, ctx, loaded, row));
        return { items };
      });
    },

    /** DRAFT_REVISION: for an EXTERNAL document, the row its next edition's file is uploaded to. */
    async draftIsoRevision({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const loaded = await load(tx, ctx, params.clientId!, params.id!);
        authorizeStep(ctx, loaded, 'owner');
        const { doc } = loaded;
        const open = (await documentRevisions.forDocument(tx, doc.id)).find((r) =>
          OPEN_STATES.includes(r.state),
        );
        const result = isoTransition('DOCUMENT_REVISION', 'NEW', 'DRAFT_REVISION', {
          documentStatus: doc.status,
          openRevisionCount: open === undefined ? 0 : 1,
        });
        if (!result.ok) {
          if (doc.status !== 'ACTIVE')
            invalidTransition('controlled_document', doc.status, 'UPDATE');
          invalidTransition('document_revision', open!.state, 'DRAFT_REVISION');
        }
        await checkLabel(tx, doc, body.revision);
        const revision = await documentRevisions.create(tx, {
          clientId: doc.clientId,
          documentId: doc.id,
          revision: body.revision,
          changeNote: body.changeNote,
          state: 'DRAFT',
          preparedById: ctx.personId,
          approvedById: null,
          approvedAt: null,
          sendBackReason: null,
        });
        await core.audit(tx, ctx, doc.clientId, {
          action: 'CREATE',
          entityType: 'document_revision',
          entityId: revision.id,
          after: {
            action: 'DRAFT_REVISION',
            documentId: doc.id,
            revision: revision.revision,
            state: 'DRAFT',
          },
          delegated: ctx.personId !== doc.ownerId,
        });
        return revisionView(tx, ctx, loaded, revision);
      });
    },

    async updateIsoRevision({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const loaded = await load(tx, ctx, params.clientId!, params.id!);
        const revision = await revisionOf(tx, loaded.doc, params.revisionId!);
        authorizeStep(ctx, loaded, 'owner');
        const { version, ...fields } = body;
        checkVersion(revision, version);
        if (loaded.doc.status !== 'ACTIVE' || revision.state !== 'DRAFT') {
          refuse(loaded.doc, revision, 'UPDATE');
        }
        if (fields.revision !== undefined) {
          await checkLabel(tx, loaded.doc, fields.revision, revision.id);
        }
        const updated = await core.edit(tx, ctx, revision, fields, 'document_revision', (changes) =>
          documentRevisions.update(tx, revision.id, version, changes),
        );
        return revisionView(tx, ctx, loaded, updated);
      });
    },

    submitIsoRevision: (call) =>
      revisionStep(call, 'owner', 'SUBMIT', (tx, { doc }, revision) =>
        moveRevision(
          tx,
          call.ctx,
          revision,
          'SUBMIT',
          { state: 'IN_REVIEW', sendBackReason: null },
          {
            delegated: call.ctx.personId !== doc.ownerId,
          },
        ),
      ),

    approveIsoRevision: (call) =>
      revisionStep(call, 'approver', 'APPROVE', async (tx, { doc }, revision) => {
        const { revision: approved } = await putInForce(
          tx,
          call.ctx,
          doc,
          revision,
          'APPROVE',
          { state: 'APPROVED', approvedById: call.ctx.personId, approvedAt: core.now() },
          {
            ...(call.body.comment === undefined ? {} : { note: call.body.comment }),
            delegated: call.ctx.personId !== doc.approverId,
          },
        );
        return approved;
      }),

    sendBackIsoRevision: (call) =>
      revisionStep(call, 'approver', 'SEND_BACK', (tx, { doc }, revision) =>
        moveRevision(
          tx,
          call.ctx,
          revision,
          'SEND_BACK',
          { state: 'DRAFT', sendBackReason: call.body.reason },
          { reason: call.body.reason, delegated: call.ctx.personId !== doc.approverId },
        ),
      ),

    /** RECORD_EDITION: an EXTERNAL document's edition comes into force with no internal approval (`approvedById` null). */
    recordIsoEdition: (call) =>
      revisionStep(call, 'owner', 'RECORD_EDITION', async (tx, { doc }, revision) => {
        const { revision: recorded } = await putInForce(
          tx,
          call.ctx,
          doc,
          revision,
          'RECORD_EDITION',
          { state: 'APPROVED', approvedById: null, approvedAt: core.now() },
          { delegated: call.ctx.personId !== doc.ownerId },
        );
        return recorded;
      }),
  };
}
