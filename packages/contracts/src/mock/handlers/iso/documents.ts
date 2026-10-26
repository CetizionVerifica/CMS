// Mock handlers for the ISO add-on: Controlled documents and their revisions (model §3.4, §4.2).
// The server answers 403 FEATURE_NOT_ENABLED or 409 FEATURE_NOT_READY before any of these run.
import type { z } from 'zod';
import type { DocumentView, RevisionView } from '../../../api/iso.js';
import {
  type Actor,
  diff,
  matches,
  MockError,
  notFound,
  paginate,
  type Scope,
  visibleClientIds,
} from '../../core.js';
import { actorOf, type PartialHandlers } from '../../handler.js';
import {
  canSee,
  checkIsoPerson,
  checkIsoVersion,
  checkSystemClauses,
  finishIsoScans,
  forbidden,
  holdsRole,
  invalid,
  invalidTransition,
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
  touchIso,
} from '../../iso/common.js';
import { isoTiming } from '../../iso/derive.js';
import type { FirmState, AuditRecord, IsoRow } from '../../store.js';

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

type Doc = IsoRow<'documents'>;
type Revision = IsoRow<'revisions'>;
type DocumentOut = z.input<typeof DocumentView>;
type RevisionOut = z.input<typeof RevisionView>;
type Ctx = IsoCtx & { authorize(scope: Scope): void };

const WRITE = 'isoDocument.write';
const APPROVE = 'isoDocument.approve';

// ---------- lookups and reach ----------

const requireDocument = (actor: Actor, clientId: string | undefined, id: string | undefined) =>
  requireIso(actor.firm, 'documents', clientId!, id!);

/** A revision of `doc`, or 404 (another document's revision included). */
function requireRevision(firm: FirmState, doc: Doc, id: string | undefined): Revision {
  const revision = requireIso(firm, 'revisions', doc.clientId, id!);
  if (revision.documentId !== doc.id) throw notFound();
  return revision;
}

/** The document's live revisions, in the order they were drafted. */
const revisionsOf = (firm: FirmState, doc: Doc) =>
  liveIso(firm, 'revisions', doc.clientId).filter((r) => r.documentId === doc.id);

/** The revision in DRAFT or IN_REVIEW, if any (DRAFT_REVISION keeps it to one). */
const openRevision = (firm: FirmState, doc: Doc) =>
  revisionsOf(firm, doc).find((r) => r.state === 'DRAFT' || r.state === 'IN_REVIEW');

/** A document takes its management system's units; its owner and approver always see it (plan §3.3). */
const reachOfDocument = (firm: FirmState, doc: Doc): IsoReach =>
  reachOf(firm, {
    clientId: doc.clientId,
    systemId: doc.managementSystemId,
    people: [doc.ownerId, doc.approverId],
  });

/** An ACTIVE document with an approved revision: every member of the client reads it (model §4.2, plan §3.3). */
const inForce = (doc: Doc) => doc.status === 'ACTIVE' && doc.currentRevisionId !== null;

/**
 * How the actor reaches a document: within unit scope or named on it (`scope`), only as a member of the client reading
 * the revision in force (`inForce`), or not at all.
 */
function accessTo(actor: Actor, doc: Doc, reach: IsoReach): 'scope' | 'inForce' | 'none' {
  if (canSee(actor, reach)) return 'scope';
  if (inForce(doc) && visibleClientIds(actor).includes(doc.clientId)) return 'inForce';
  return 'none';
}

/** The role check for a read; true when the actor reads the document only through its revision in force. */
function authorizeRead(ctx: Ctx, actor: Actor, doc: Doc): boolean {
  const reach = reachOfDocument(actor.firm, doc);
  const inForceOnly = accessTo(actor, doc, reach) === 'inForce';
  ctx.authorize(inForceOnly ? { clientId: doc.clientId } : isoScope(actor, reach));
  return inForceOnly;
}

/**
 * The role check for the owner's steps (`isoDocument.write`, OW own) or the approver's (`isoDocument.approve`, AP own).
 * A member who reads the document only through its revision in force may not change it (403, not 404).
 */
function authorizeStep(ctx: Ctx, actor: Actor, doc: Doc, step: 'owner' | 'approver'): void {
  const reach = reachOfDocument(actor.firm, doc);
  if (accessTo(actor, doc, reach) === 'inForce') {
    forbidden(step === 'owner' ? WRITE : APPROVE, 'This document is outside your units');
  }
  ctx.authorize(
    isoScope(
      actor,
      reach,
      step === 'owner' ? { ownerId: doc.ownerId } : { approverId: doc.approverId },
    ),
  );
}

/** The units a role must cover for the actor to act: none when the document names them (plan §3.3). */
const unitsFor = (actor: Actor, reach: IsoReach) =>
  reach.people.includes(actor.person.id) ? undefined : reach.unitIds;

/** The owner's steps: the document's owner, or FA, CO or CA as delegate (plan §3.2 `isoDocument.write`). */
function takesOwnerSteps(actor: Actor, doc: Doc, reach: IsoReach): boolean {
  return (
    (doc.ownerId === actor.person.id && holdsRole(actor, doc.clientId, ['OWNER'])) ||
    holdsRole(
      actor,
      doc.clientId,
      ['FIRM_ADMIN', 'CONSULTANT', 'CLIENT_ADMIN'],
      unitsFor(actor, reach),
    )
  );
}

/** The approver's steps: the document's approver, or a CA as delegate (plan §3.2 `isoDocument.approve`). */
function takesApproverSteps(actor: Actor, doc: Doc, reach: IsoReach): boolean {
  return (
    (doc.approverId === actor.person.id && holdsRole(actor, doc.clientId, ['APPROVER'])) ||
    holdsRole(actor, doc.clientId, ['CLIENT_ADMIN'], unitsFor(actor, reach))
  );
}

/**
 * Who took a maker step on a revision (model §4 preamble, §4.2): its preparer and everyone who submitted it. A revision
 * starts at DRAFT_REVISION, so every SUBMIT it has had counts. None of them approves it.
 */
function makersOf(firm: FirmState, revision: Revision): string[] {
  const submitters = firm.data.auditEvents
    .filter(
      (e) =>
        e.entityType === 'document_revision' &&
        e.entityId === revision.id &&
        e.action === 'TRANSITION' &&
        e.after?.state === 'IN_REVIEW',
    )
    .map((e) => e.actorId)
    .filter((id): id is string => id !== null);
  return [revision.preparedById, ...submitters];
}

// ---------- views ----------

function documentView(ctx: IsoCtx, actor: Actor, doc: Doc): DocumentOut {
  const firm = actor.firm;
  const reach = reachOfDocument(firm, doc);
  const current = firm.iso.revisions.find((r) => r.id === doc.currentRevisionId);
  // Only readers within scope learn of a revision in the works.
  const open = canSee(actor, reach) ? openRevision(firm, doc) : undefined;
  const allowedActions: DocumentOut['allowedActions'] = [];
  if (doc.status === 'ACTIVE') {
    if (open === undefined && takesOwnerSteps(actor, doc, reach)) {
      allowedActions.push('DRAFT_REVISION');
    }
    if (takesApproverSteps(actor, doc, reach)) {
      if (doc.currentRevisionId !== null) allowedActions.push('REVIEW');
      allowedActions.push('MAKE_OBSOLETE');
    }
  }
  return {
    ...doc,
    currentRevision: current?.revision ?? null,
    openRevisionId: open?.id ?? null,
    // `reviewDue` (model §5.2); an obsolete document is no longer reviewed.
    reviewStatus: isoTiming(
      doc.reviewDueOn,
      doc.status === 'OBSOLETE',
      ctx.clock.today(),
      firm.data.firm.settings.dueSoonDays,
    ),
    allowedActions,
  };
}

function revisionView(actor: Actor, doc: Doc, revision: Revision): RevisionOut {
  const reach = reachOfDocument(actor.firm, doc);
  const external = doc.type === 'EXTERNAL';
  const allowedActions: RevisionOut['allowedActions'] = [];
  if (doc.status === 'ACTIVE') {
    if (revision.state === 'DRAFT' && takesOwnerSteps(actor, doc, reach)) {
      allowedActions.push(external ? 'RECORD_EDITION' : 'SUBMIT');
    }
    if (revision.state === 'IN_REVIEW' && !external && takesApproverSteps(actor, doc, reach)) {
      if (!makersOf(actor.firm, revision).includes(actor.person.id)) allowedActions.push('APPROVE');
      allowedActions.push('SEND_BACK');
    }
  }
  return { ...revision, allowedActions };
}

// ---------- checks ----------

/** Codes are unique per client, whatever the document's status (model §3.4); compared without case. */
function checkCode(firm: FirmState, clientId: string, code: string): void {
  const clash = liveIso(firm, 'documents', clientId).find(
    (d) => d.code.toLowerCase() === code.toLowerCase(),
  );
  if (clash !== undefined) {
    throw new MockError('DUPLICATE', `A document with code "${code}" already exists`, {
      field: 'code',
      existingId: clash.id,
    });
  }
}

/** A revision label names one revision of its document, so the history reads unambiguously. */
function checkLabel(firm: FirmState, doc: Doc, label: string, exceptId?: string): void {
  const clash = revisionsOf(firm, doc).find(
    (r) => r.id !== exceptId && r.revision.toLowerCase() === label.toLowerCase(),
  );
  if (clash !== undefined) {
    throw new MockError('DUPLICATE', `This document already has a revision "${label}"`, {
      field: 'revision',
      existingId: clash.id,
    });
  }
}

/** `retention` belongs to FORM documents, `issuer` and `externalRef` to EXTERNAL ones (model §3.4). */
function checkTypeFields(
  type: Doc['type'],
  fields: { retention?: string | null; issuer?: string | null; externalRef?: string | null },
): void {
  if (type !== 'FORM' && fields.retention != null) {
    invalid('retention', 'Only a FORM has retention');
  }
  if (type !== 'EXTERNAL') {
    if (fields.issuer != null) invalid('issuer', 'Only an EXTERNAL document has an issuer');
    if (fields.externalRef != null) {
      invalid('externalRef', 'Only an EXTERNAL document has an external reference');
    }
  }
}

/** A field edit, new revision or step on a revision of an OBSOLETE document is refused (model §1.8). */
function requireActive(doc: Doc, action: string): void {
  if (doc.status !== 'ACTIVE') invalidTransition('controlled_document', doc.status, action);
}

/** SUBMIT and RECORD_EDITION need exactly one live file on the revision, and it has passed the scan (model §3.4). */
function checkFile(firm: FirmState, revision: Revision): void {
  finishIsoScans(firm);
  const files = firm.iso.files.filter(
    (f) =>
      f.clientId === revision.clientId &&
      f.documentRevisionId === revision.id &&
      f.archivedAt === null,
  );
  if (files.length === 0) invalid('file', "Upload the revision's file first");
  if (files.length > 1) invalid('file', 'A revision has one file; remove the others');
  if (files[0]!.scanStatus !== 'CLEAN') {
    invalid('file', "The revision's file has not passed the virus scan");
  }
}

// ---------- writes ----------

/**
 * Applies a step to a revision and audits it as a TRANSITION naming the action (model §8); `note` is the approver's
 * comment, and `delegated` marks a step a manager took for the person named (model §4 preamble).
 */
function moveRevision(
  ctx: IsoCtx,
  actor: Actor,
  revision: Revision,
  action: string,
  change: Partial<Revision>,
  options: {
    reason?: string;
    note?: string;
    delegated?: boolean;
    after?: Record<string, unknown>;
  } = {},
): void {
  const keys = Object.keys(change) as (keyof Revision)[];
  const before = Object.fromEntries(keys.map((k) => [k, revision[k]]));
  Object.assign(revision, change);
  touchIso(ctx, revision);
  isoAudit(ctx, actor, {
    action: 'TRANSITION',
    entityType: 'document_revision',
    entityId: revision.id,
    clientId: revision.clientId,
    before,
    after: {
      action,
      ...change,
      ...(options.note === undefined ? {} : { note: options.note }),
      ...options.after,
    },
    reason: options.reason ?? null,
    ...(options.delegated === true ? { delegated: true } : {}),
  });
}

/**
 * APPROVE and RECORD_EDITION: the revision comes into force, the one it replaces becomes SUPERSEDED, and the document's
 * `currentRevisionId` moves, all in one step (model §4.2).
 */
function putInForce(
  ctx: IsoCtx,
  actor: Actor,
  doc: Doc,
  revision: Revision,
  action: string,
  change: Partial<Revision>,
  options: { note?: string; delegated: boolean },
): void {
  for (const previous of revisionsOf(actor.firm, doc)) {
    if (previous.state !== 'APPROVED' || previous.id === revision.id) continue;
    moveRevision(
      ctx,
      actor,
      previous,
      'SUPERSEDE',
      { state: 'SUPERSEDED' },
      {
        after: { supersededById: revision.id },
      },
    );
  }
  moveRevision(ctx, actor, revision, action, change, options);
  const before = { currentRevisionId: doc.currentRevisionId };
  doc.currentRevisionId = revision.id;
  touchIso(ctx, doc);
  isoAudit(ctx, actor, {
    action: 'UPDATE',
    entityType: 'controlled_document',
    entityId: doc.id,
    clientId: doc.clientId,
    before,
    after: { currentRevisionId: revision.id },
  });
}

/**
 * Audit groups of a document edit: a change of people is a reassignment, of `reviewDueOn` a due-date change (§8), each
 * with the body's reason.
 */
const EDIT_GROUPS: [AuditRecord['action'], string[]][] = [
  ['REASSIGN', ['ownerId', 'approverId']],
  ['DUE_DATE_CHANGE', ['reviewDueOn']],
  ['UPDATE', ['title', 'clauseIds', 'retention', 'issuer', 'externalRef']],
];

// ---------- handlers ----------

export const documentsHandlers: PartialHandlers<Ids> = {
  /**
   * Sorted by code (unique in the client). AP and OW see their units' documents, those naming them, and every
   * document in force.
   */
  listIsoDocuments(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const q = ctx.query;
    const me = (ref: string | undefined) => (ref === 'me' ? actor.person.id : ref);
    const ownerId = me(q.ownerId);
    const approverId = me(q.approverId);
    // ACTIVE only by default; a document `ids` names is listed in either status.
    const statuses: readonly string[] | undefined =
      q.status ?? (q.ids === undefined ? ['ACTIVE'] : undefined);
    const rows = liveIso(actor.firm, 'documents', clientId)
      .filter(
        (d) =>
          (statuses === undefined || statuses.includes(d.status)) &&
          (q.ids === undefined || q.ids.includes(d.id)) &&
          (q.managementSystemId === undefined ||
            q.managementSystemId.includes(d.managementSystemId)) &&
          (q.type === undefined || q.type.includes(d.type)) &&
          (ownerId === undefined || d.ownerId === ownerId) &&
          (approverId === undefined || d.approverId === approverId) &&
          (q.clauseId === undefined || d.clauseIds.some((c) => q.clauseId!.includes(c))) &&
          matches(q.q, d.code, d.title, d.issuer, d.externalRef) &&
          accessTo(actor, d, reachOfDocument(actor.firm, d)) !== 'none',
      )
      .sort((a, b) => a.code.localeCompare(b.code));
    return paginate(
      rows.map((d) => documentView(ctx, actor, d)),
      q,
    );
  },

  createIsoDocument(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    const body = ctx.body;
    const system = requireSystem(actor.firm, clientId, body.managementSystemId);
    // The creator must see the system; an owner adds documents only as their owner.
    ctx.authorize(
      isoScope(actor, reachOf(actor.firm, { clientId, systemId: system.id }), {
        ownerId: body.ownerId,
      }),
    );
    checkIsoPerson(actor, clientId, body.ownerId, 'ownerId');
    checkIsoPerson(actor, clientId, body.approverId, 'approverId');
    checkSystemClauses(actor.firm, system, body.clauseIds, 'clauseIds');
    checkCode(actor.firm, clientId, body.code);
    const doc: Doc = {
      ...isoFresh(ctx, actor, clientId),
      managementSystemId: system.id,
      code: body.code,
      title: body.title,
      type: body.type,
      clauseIds: body.clauseIds,
      status: 'ACTIVE',
      currentRevisionId: null,
      ownerId: body.ownerId,
      approverId: body.approverId,
      reviewDueOn: body.reviewDueOn,
      lastReviewedOn: null,
      retention: body.retention,
      issuer: body.issuer,
      externalRef: body.externalRef,
    };
    actor.firm.iso.documents.push(doc);
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'controlled_document',
      entityId: doc.id,
      clientId,
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
    return documentView(ctx, actor, doc);
  },

  getIsoDocument(ctx) {
    const actor = actorOf(ctx);
    const doc = requireDocument(actor, ctx.params.clientId, ctx.params.id);
    authorizeRead(ctx, actor, doc);
    return documentView(ctx, actor, doc);
  },

  /** Title, clauses, people, review date and type fields, while ACTIVE; `code` and `type` never change. */
  updateIsoDocument(ctx) {
    const actor = actorOf(ctx);
    const doc = requireDocument(actor, ctx.params.clientId, ctx.params.id);
    authorizeStep(ctx, actor, doc, 'owner');
    const { version, reason, ...fields } = ctx.body;
    checkIsoVersion(doc, version);
    requireActive(doc, 'UPDATE');
    checkTypeFields(doc.type, fields);
    if (fields.clauseIds !== undefined) {
      const system = actor.firm.iso.managementSystems.find((s) => s.id === doc.managementSystemId)!;
      checkSystemClauses(actor.firm, system, fields.clauseIds, 'clauseIds');
    }
    if (fields.ownerId !== undefined) {
      checkIsoPerson(actor, doc.clientId, fields.ownerId, 'ownerId');
    }
    if (fields.approverId !== undefined) {
      checkIsoPerson(actor, doc.clientId, fields.approverId, 'approverId');
    }
    const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const changes = diff(doc, { ...doc, ...defined });
    const changed = Object.keys(changes.after);
    if (changed.length === 0) return documentView(ctx, actor, doc);
    Object.assign(doc, defined);
    touchIso(ctx, doc);
    for (const [action, keys] of EDIT_GROUPS) {
      const inGroup = changed.filter((k) => keys.includes(k));
      if (inGroup.length === 0) continue;
      isoAudit(ctx, actor, {
        action,
        entityType: 'controlled_document',
        entityId: doc.id,
        clientId: doc.clientId,
        before: Object.fromEntries(inGroup.map((k) => [k, changes.before[k]])),
        after: Object.fromEntries(inGroup.map((k) => [k, changes.after[k]])),
        reason: action === 'UPDATE' ? null : (reason ?? null),
      });
    }
    return documentView(ctx, actor, doc);
  },

  /** REVIEW: the current revision still fits; no new revision. The note goes on the audit event. */
  reviewIsoDocument(ctx) {
    const actor = actorOf(ctx);
    const doc = requireDocument(actor, ctx.params.clientId, ctx.params.id);
    authorizeStep(ctx, actor, doc, 'approver');
    const body = ctx.body;
    checkIsoVersion(doc, body.version);
    requireActive(doc, 'REVIEW');
    if (doc.currentRevisionId === null) {
      invalid('currentRevisionId', 'Approve a first revision before reviewing the document');
    }
    const today = ctx.clock.today();
    if (body.nextReviewDueOn <= today) {
      invalid('nextReviewDueOn', 'The next review date is after today');
    }
    const before = { lastReviewedOn: doc.lastReviewedOn, reviewDueOn: doc.reviewDueOn };
    doc.lastReviewedOn = today;
    doc.reviewDueOn = body.nextReviewDueOn;
    touchIso(ctx, doc);
    isoAudit(ctx, actor, {
      action: 'TRANSITION',
      entityType: 'controlled_document',
      entityId: doc.id,
      clientId: doc.clientId,
      before,
      after: {
        action: 'REVIEW',
        lastReviewedOn: today,
        reviewDueOn: doc.reviewDueOn,
        note: body.note,
      },
      delegated: actor.person.id !== doc.approverId,
    });
    return documentView(ctx, actor, doc);
  },

  /** MAKE_OBSOLETE: the document leaves default lists; its revisions stay readable as history. */
  obsoleteIsoDocument(ctx) {
    const actor = actorOf(ctx);
    const doc = requireDocument(actor, ctx.params.clientId, ctx.params.id);
    authorizeStep(ctx, actor, doc, 'approver');
    checkIsoVersion(doc, ctx.body.version);
    requireActive(doc, 'MAKE_OBSOLETE');
    doc.status = 'OBSOLETE';
    touchIso(ctx, doc);
    isoAudit(ctx, actor, {
      action: 'TRANSITION',
      entityType: 'controlled_document',
      entityId: doc.id,
      clientId: doc.clientId,
      before: { status: 'ACTIVE' },
      after: { action: 'MAKE_OBSOLETE', status: 'OBSOLETE' },
      reason: ctx.body.reason,
      delegated: actor.person.id !== doc.approverId,
    });
    return documentView(ctx, actor, doc);
  },

  /**
   * Newest first (drafted later first). A member who reads the document only through its revision in force sees that
   * revision alone.
   */
  listIsoRevisions(ctx) {
    const actor = actorOf(ctx);
    const doc = requireDocument(actor, ctx.params.clientId, ctx.params.id);
    const inForceOnly = authorizeRead(ctx, actor, doc);
    const rows = revisionsOf(actor.firm, doc)
      .reverse()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .filter((r) => !inForceOnly || r.id === doc.currentRevisionId);
    return { items: rows.map((r) => revisionView(actor, doc, r)) };
  },

  /** DRAFT_REVISION: for an EXTERNAL document, the row its next edition's file is uploaded to. */
  draftIsoRevision(ctx) {
    const actor = actorOf(ctx);
    const doc = requireDocument(actor, ctx.params.clientId, ctx.params.id);
    authorizeStep(ctx, actor, doc, 'owner');
    requireActive(doc, 'UPDATE');
    const open = openRevision(actor.firm, doc);
    if (open !== undefined) invalidTransition('document_revision', open.state, 'DRAFT_REVISION');
    checkLabel(actor.firm, doc, ctx.body.revision);
    const revision: Revision = {
      ...isoFresh(ctx, actor, doc.clientId),
      documentId: doc.id,
      revision: ctx.body.revision,
      changeNote: ctx.body.changeNote,
      state: 'DRAFT',
      preparedById: actor.person.id,
      approvedById: null,
      approvedAt: null,
      sendBackReason: null,
    };
    actor.firm.iso.revisions.push(revision);
    isoAudit(ctx, actor, {
      action: 'CREATE',
      entityType: 'document_revision',
      entityId: revision.id,
      clientId: revision.clientId,
      after: {
        action: 'DRAFT_REVISION',
        documentId: doc.id,
        revision: revision.revision,
        state: 'DRAFT',
      },
      delegated: actor.person.id !== doc.ownerId,
    });
    return revisionView(actor, doc, revision);
  },

  updateIsoRevision(ctx) {
    const actor = actorOf(ctx);
    const doc = requireDocument(actor, ctx.params.clientId, ctx.params.id);
    const revision = requireRevision(actor.firm, doc, ctx.params.revisionId);
    authorizeStep(ctx, actor, doc, 'owner');
    const { version, ...fields } = ctx.body;
    checkIsoVersion(revision, version);
    requireActive(doc, 'UPDATE');
    if (revision.state !== 'DRAFT') {
      invalidTransition('document_revision', revision.state, 'UPDATE');
    }
    if (fields.revision !== undefined) checkLabel(actor.firm, doc, fields.revision, revision.id);
    patchIso(ctx, actor, revision, version, fields, 'document_revision');
    return revisionView(actor, doc, revision);
  },

  submitIsoRevision(ctx) {
    const actor = actorOf(ctx);
    const doc = requireDocument(actor, ctx.params.clientId, ctx.params.id);
    const revision = requireRevision(actor.firm, doc, ctx.params.revisionId);
    authorizeStep(ctx, actor, doc, 'owner');
    checkIsoVersion(revision, ctx.body.version);
    requireActive(doc, 'SUBMIT');
    if (doc.type === 'EXTERNAL' || revision.state !== 'DRAFT') {
      invalidTransition('document_revision', revision.state, 'SUBMIT');
    }
    if (revision.changeNote === null) {
      invalid('changeNote', 'Say what changed before submitting the revision');
    }
    checkFile(actor.firm, revision);
    moveRevision(
      ctx,
      actor,
      revision,
      'SUBMIT',
      { state: 'IN_REVIEW', sendBackReason: null },
      { delegated: actor.person.id !== doc.ownerId },
    );
    return revisionView(actor, doc, revision);
  },

  approveIsoRevision(ctx) {
    const actor = actorOf(ctx);
    const doc = requireDocument(actor, ctx.params.clientId, ctx.params.id);
    const revision = requireRevision(actor.firm, doc, ctx.params.revisionId);
    authorizeStep(ctx, actor, doc, 'approver');
    checkIsoVersion(revision, ctx.body.version);
    requireActive(doc, 'APPROVE');
    if (doc.type === 'EXTERNAL' || revision.state !== 'IN_REVIEW') {
      invalidTransition('document_revision', revision.state, 'APPROVE');
    }
    if (makersOf(actor.firm, revision).includes(actor.person.id)) {
      forbidden(APPROVE, 'You prepared or submitted this revision, so someone else approves it');
    }
    putInForce(
      ctx,
      actor,
      doc,
      revision,
      'APPROVE',
      { state: 'APPROVED', approvedById: actor.person.id, approvedAt: ctx.clock.now() },
      {
        ...(ctx.body.comment === undefined ? {} : { note: ctx.body.comment }),
        delegated: actor.person.id !== doc.approverId,
      },
    );
    return revisionView(actor, doc, revision);
  },

  sendBackIsoRevision(ctx) {
    const actor = actorOf(ctx);
    const doc = requireDocument(actor, ctx.params.clientId, ctx.params.id);
    const revision = requireRevision(actor.firm, doc, ctx.params.revisionId);
    authorizeStep(ctx, actor, doc, 'approver');
    checkIsoVersion(revision, ctx.body.version);
    requireActive(doc, 'SEND_BACK');
    if (doc.type === 'EXTERNAL' || revision.state !== 'IN_REVIEW') {
      invalidTransition('document_revision', revision.state, 'SEND_BACK');
    }
    moveRevision(
      ctx,
      actor,
      revision,
      'SEND_BACK',
      { state: 'DRAFT', sendBackReason: ctx.body.reason },
      { reason: ctx.body.reason, delegated: actor.person.id !== doc.approverId },
    );
    return revisionView(actor, doc, revision);
  },

  /** RECORD_EDITION: an EXTERNAL document's edition comes into force with no internal approval (`approvedById` null). */
  recordIsoEdition(ctx) {
    const actor = actorOf(ctx);
    const doc = requireDocument(actor, ctx.params.clientId, ctx.params.id);
    const revision = requireRevision(actor.firm, doc, ctx.params.revisionId);
    authorizeStep(ctx, actor, doc, 'owner');
    checkIsoVersion(revision, ctx.body.version);
    requireActive(doc, 'RECORD_EDITION');
    if (doc.type !== 'EXTERNAL' || revision.state !== 'DRAFT') {
      invalidTransition('document_revision', revision.state, 'RECORD_EDITION');
    }
    if (doc.issuer === null) invalid('issuer', "Record the document's issuer first");
    if (doc.externalRef === null) {
      invalid('externalRef', "Record the document's external reference first");
    }
    checkFile(actor.firm, revision);
    putInForce(
      ctx,
      actor,
      doc,
      revision,
      'RECORD_EDITION',
      { state: 'APPROVED', approvedById: null, approvedAt: ctx.clock.now() },
      { delegated: actor.person.id !== doc.ownerId },
    );
    return revisionView(actor, doc, revision);
  },
};
