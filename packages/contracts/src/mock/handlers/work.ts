// M7 endpoints: the register, workflow transitions, comments, evidence and audit.
// Uploads are not stored: the PUT URL points nowhere, and confirmed evidence passes its "scan" on the next read
// (a file name containing "eicar" fails it instead).
import { INSTANCE_EDIT_STATES, type InstanceAction, type WorkflowState } from '../../enums.js';
import {
  type Actor,
  asOfFor,
  audit,
  checkVersion,
  fileUrl,
  filterRows,
  instanceDetail,
  instanceRow,
  Lookup,
  membershipsFor,
  MockError,
  notFound,
  paginate,
  sortRows,
  touch,
  visibleClientIds,
  visibleInstances,
} from '../core.js';
import { SIGNED_URL_TTL_SECONDS } from '../../api/common.js';
import { actorOf, type EndpointId, type HandlerContext, type PartialHandlers } from '../handler.js';
import type { FirmState, InstanceRecord, Row } from '../store.js';

type Ctx = HandlerContext<EndpointId>;

function findInstance(actor: Actor, id: string | undefined): InstanceRecord {
  const instance = actor.firm.data.instances.find((i) => i.id === id && i.archivedAt === null);
  if (instance === undefined) throw notFound();
  return instance;
}

const instanceScope = (i: InstanceRecord) => ({
  clientId: i.clientId,
  unitId: i.unitId,
  ownerId: i.ownerId,
  approverId: i.approverId,
});

function requireState(
  instance: InstanceRecord,
  allowed: readonly WorkflowState[],
  action: InstanceAction,
): void {
  if (!allowed.includes(instance.workflowState)) {
    throw new MockError(
      'INVALID_TRANSITION',
      `Instance is ${instance.workflowState}; ${action} is not allowed.`,
      {
        from: instance.workflowState,
        action,
      },
    );
  }
}

function addComment(
  ctx: Ctx,
  actor: Actor,
  instance: InstanceRecord,
  kind: Row<'comments'>['kind'],
  body: string,
) {
  const now = ctx.clock.now();
  const comment = {
    id: ctx.store.newId(),
    firmId: actor.firm.data.firm.id,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    instanceId: instance.id,
    clientId: instance.clientId,
    authorId: actor.person.id,
    kind,
    body,
  };
  actor.firm.data.comments.push(comment);
  return comment;
}

const OPEN: WorkflowState[] = ['OPEN', 'SENT_BACK'];
const CLOSED: WorkflowState[] = ['APPROVED', 'NOT_APPLICABLE'];

/** Runs one transition: version check, state check, change, audit event and comment. */
function transition(
  ctx: Ctx,
  instance: InstanceRecord,
  version: number,
  action: InstanceAction,
  from: WorkflowState[],
  change: Partial<InstanceRecord>,
  comment?: { kind: Row<'comments'>['kind']; body: string | undefined },
  reason?: string,
  auditExtra: Record<string, unknown> = {},
): InstanceRecord {
  const actor = actorOf(ctx);
  checkVersion(instance, version);
  requireState(instance, from, action);
  const before = {
    workflowState: instance.workflowState,
    pendingKind: instance.pendingKind,
    completedOn: instance.completedOn,
  };
  Object.assign(instance, change);
  touch(instance, ctx.clock);
  audit(ctx, actor, {
    action: 'TRANSITION',
    entityType: 'instance',
    entityId: instance.id,
    clientId: instance.clientId,
    before,
    after: {
      workflowState: instance.workflowState,
      pendingKind: instance.pendingKind,
      completedOn: instance.completedOn,
      ...auditExtra,
    },
    reason: reason ?? null,
  });
  if (comment?.body !== undefined) addComment(ctx, actor, instance, comment.kind, comment.body);
  return instance;
}

/** A decision by someone other than the instance's approver (a CLIENT_ADMIN) is audited as delegated. */
const delegated = (ctx: Ctx, instance: InstanceRecord) => ({
  delegated: actorOf(ctx).person.id !== instance.approverId,
});

function approve(ctx: Ctx, instance: InstanceRecord, version: number, comment: string | undefined) {
  const na = instance.pendingKind === 'NA';
  return transition(
    ctx,
    instance,
    version,
    'APPROVE',
    ['SUBMITTED'],
    {
      workflowState: na ? 'NOT_APPLICABLE' : 'APPROVED',
      pendingKind: null,
      completedOn: na ? ctx.clock.today() : instance.completedOn,
      approvedAt: ctx.clock.now(),
    },
    { kind: 'APPROVE', body: comment },
    undefined,
    delegated(ctx, instance),
  );
}

function detail(ctx: Ctx, instance: InstanceRecord) {
  const actor = actorOf(ctx);
  return instanceDetail(new Lookup(actor.firm), actor, instance, ctx.clock.today());
}

/** Evidence confirmed through the mock passes (or, for "eicar" files, fails) its scan when next read. */
function finishScans(firm: FirmState): void {
  for (const e of firm.data.evidence) {
    if (firm.scanning.has(e.id)) {
      e.scanStatus = /eicar/i.test(e.fileName) ? 'INFECTED' : 'CLEAN';
      firm.scanning.delete(e.id);
    }
  }
}

function evidenceView(e: Row<'evidence'>) {
  const view: Partial<Row<'evidence'>> = { ...e };
  delete view.storageKey;
  return view as Omit<Row<'evidence'>, 'storageKey'>;
}

function findEvidence(actor: Actor, id: string | undefined) {
  const evidence = actor.firm.data.evidence.find((e) => e.id === id && e.archivedAt === null);
  if (evidence === undefined) throw notFound();
  return { evidence, instance: findInstance(actor, evidence.instanceId) };
}

function queue(
  ctx: HandlerContext<'myApprovals' | 'myTasks'>,
  pick: (i: InstanceRecord, actor: Actor) => boolean,
) {
  const actor = actorOf(ctx);
  ctx.authorize({ clientId: null });
  const look = new Lookup(actor.firm);
  const asOf = asOfFor(actor, null, ctx.query.asOf, ctx.clock);
  const rows = visibleClientIds(actor)
    .flatMap((clientId) => visibleInstances(actor, clientId))
    .filter((i) => pick(i, actor))
    .map((i) => instanceRow(look, i, asOf));
  return paginate(sortRows(rows, [{ field: 'dueDate', direction: 'asc' }]), ctx.query);
}

export const workHandlers: PartialHandlers<
  | 'listInstances'
  | 'getInstance'
  | 'submitInstance'
  | 'requestNa'
  | 'approveInstance'
  | 'sendBackInstance'
  | 'reopenInstance'
  | 'bulkApprove'
  | 'updateInstance'
  | 'myApprovals'
  | 'myTasks'
  | 'listComments'
  | 'createComment'
  | 'evidenceUploadUrl'
  | 'confirmEvidence'
  | 'listInstanceEvidence'
  | 'evidenceVault'
  | 'evidenceDownloadUrl'
  | 'removeEvidence'
  | 'clientAudit'
  | 'instanceAudit'
> = {
  listInstances(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const client = actor.firm.data.clients.find((c) => c.id === clientId)!;
    const look = new Lookup(actor.firm);
    const { limit, cursor, count, sort, asOf: asOfParam, ...filters } = ctx.query;
    const asOf = asOfFor(actor, clientId, asOfParam, ctx.clock);
    const rows = filterRows(
      visibleInstances(actor, clientId).map((i) => instanceRow(look, i, asOf)),
      filters,
      actor,
      look,
      client.settings.fyStartMonth,
    );
    const sorted = sortRows(
      rows,
      sort ?? [{ field: 'dueDate', direction: 'asc' }],
      (row) => look.instances.get(row.id)!.updatedAt,
    );
    return paginate(sorted, { limit, cursor, count });
  },

  getInstance(ctx) {
    const actor = actorOf(ctx);
    const instance = findInstance(actor, ctx.params.id);
    ctx.authorize(instanceScope(instance));
    const asOf = asOfFor(actor, instance.clientId, ctx.query.asOf, ctx.clock);
    return instanceDetail(new Lookup(actor.firm), actor, instance, asOf);
  },

  submitInstance(ctx) {
    const actor = actorOf(ctx);
    const instance = findInstance(actor, ctx.params.id);
    ctx.authorize(instanceScope(instance));
    // Version and state first, as for every transition; then the submission's own rules.
    checkVersion(instance, ctx.body.version);
    requireState(instance, OPEN, 'SUBMIT');
    const today = ctx.clock.today();
    if (ctx.body.completedOn > today) {
      throw new MockError('DATE_IN_FUTURE', 'The completion date is after today', { today });
    }
    const look = new Lookup(actor.firm);
    if (look.obligationOf(instance).evidenceRequired) {
      finishScans(actor.firm);
      const clean = (look.evidenceByInstance.get(instance.id) ?? []).some(
        (e) => e.scanStatus === 'CLEAN',
      );
      if (!clean)
        throw new MockError('EVIDENCE_REQUIRED', 'Attach evidence that has passed the virus scan');
    }
    transition(
      ctx,
      instance,
      ctx.body.version,
      'SUBMIT',
      OPEN,
      {
        workflowState: 'SUBMITTED',
        pendingKind: 'COMPLETION',
        completedOn: ctx.body.completedOn,
        submittedAt: ctx.clock.now(),
      },
      { kind: 'SUBMIT', body: ctx.body.comment },
    );
    return detail(ctx, instance);
  },

  requestNa(ctx) {
    const instance = findInstance(actorOf(ctx), ctx.params.id);
    ctx.authorize(instanceScope(instance));
    transition(
      ctx,
      instance,
      ctx.body.version,
      'REQUEST_NA',
      OPEN,
      {
        workflowState: 'SUBMITTED',
        pendingKind: 'NA',
        naReason: ctx.body.reason,
        submittedAt: ctx.clock.now(),
      },
      { kind: 'NA_REQUEST', body: ctx.body.reason },
      ctx.body.reason,
    );
    return detail(ctx, instance);
  },

  approveInstance(ctx) {
    const instance = findInstance(actorOf(ctx), ctx.params.id);
    ctx.authorize(instanceScope(instance));
    approve(ctx, instance, ctx.body.version, ctx.body.comment);
    return detail(ctx, instance);
  },

  sendBackInstance(ctx) {
    const instance = findInstance(actorOf(ctx), ctx.params.id);
    ctx.authorize(instanceScope(instance));
    transition(
      ctx,
      instance,
      ctx.body.version,
      'SEND_BACK',
      ['SUBMITTED'],
      { workflowState: 'SENT_BACK', pendingKind: null, completedOn: null, naReason: null },
      { kind: 'SEND_BACK', body: ctx.body.reason },
      ctx.body.reason,
      delegated(ctx, instance),
    );
    return detail(ctx, instance);
  },

  reopenInstance(ctx) {
    const instance = findInstance(actorOf(ctx), ctx.params.id);
    ctx.authorize(instanceScope(instance));
    transition(
      ctx,
      instance,
      ctx.body.version,
      'REOPEN',
      CLOSED,
      {
        workflowState: 'OPEN',
        pendingKind: null,
        completedOn: null,
        naReason: null,
        submittedAt: null,
        approvedAt: null,
      },
      { kind: 'REOPEN', body: ctx.body.reason },
      ctx.body.reason,
    );
    return detail(ctx, instance);
  },

  bulkApprove(ctx) {
    const actor = actorOf(ctx);
    // `own` (APPROVER) access is checked per item below.
    ctx.authorize({ clientId: ctx.params.clientId!, ownPerItem: true });
    return {
      results: ctx.body.items.map(({ id, version }) => {
        try {
          const instance = findInstance(actor, id);
          if (instance.clientId !== ctx.params.clientId) throw notFound();
          ctx.authorize(instanceScope(instance));
          approve(ctx, instance, version, ctx.body.comment);
          return {
            id,
            ok: true,
            item: instanceRow(new Lookup(actor.firm), instance, ctx.clock.today()),
          };
        } catch (error) {
          if (!(error instanceof MockError)) throw error;
          return { id, ok: false, error: { code: error.code, message: error.message } };
        }
      }),
    };
  },

  updateInstance(ctx) {
    const actor = actorOf(ctx);
    const instance = findInstance(actor, ctx.params.id);
    ctx.authorize(instanceScope(instance));
    const body = ctx.body;
    checkVersion(instance, body.version);
    const reassign = body.ownerId !== undefined || body.approverId !== undefined;
    requireState(instance, INSTANCE_EDIT_STATES, reassign ? 'REASSIGN' : 'CHANGE_DUE_DATE');
    for (const field of ['ownerId', 'approverId'] as const) {
      const id = body[field];
      if (
        id !== undefined &&
        !actor.firm.data.people.some((p) => p.id === id && p.archivedAt === null)
      ) {
        throw new MockError('VALIDATION', 'Unknown person', {
          issues: [{ path: [field], message: 'Unknown person' }],
        });
      }
    }
    if (reassign) {
      const before = { ownerId: instance.ownerId, approverId: instance.approverId };
      instance.ownerId = body.ownerId ?? instance.ownerId;
      instance.approverId = body.approverId ?? instance.approverId;
      audit(ctx, actor, {
        action: 'REASSIGN',
        entityType: 'instance',
        entityId: instance.id,
        clientId: instance.clientId,
        before,
        after: { ownerId: instance.ownerId, approverId: instance.approverId },
        reason: body.reason,
      });
    }
    if (body.dueDate !== undefined) {
      const before = { dueDate: instance.dueDate };
      instance.dueDate = body.dueDate;
      instance.dueDateOverridden = true;
      audit(ctx, actor, {
        action: 'DUE_DATE_CHANGE',
        entityType: 'instance',
        entityId: instance.id,
        clientId: instance.clientId,
        before,
        after: { dueDate: body.dueDate },
        reason: body.reason,
      });
    }
    touch(instance, ctx.clock);
    return detail(ctx, instance);
  },

  myApprovals(ctx) {
    return queue(
      ctx,
      (i, actor) =>
        i.workflowState === 'SUBMITTED' &&
        membershipsFor(actor, i.clientId, i.unitId).some(
          (m) =>
            m.role === 'CLIENT_ADMIN' ||
            (m.role === 'APPROVER' && i.approverId === actor.person.id),
        ),
    );
  },

  myTasks(ctx) {
    return queue(
      ctx,
      (i, actor) => OPEN.includes(i.workflowState) && i.ownerId === actor.person.id,
    );
  },

  listComments(ctx) {
    const actor = actorOf(ctx);
    const instance = findInstance(actor, ctx.params.id);
    ctx.authorize(instanceScope(instance));
    const rows = actor.firm.data.comments
      .filter((c) => c.instanceId === instance.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return paginate(rows, ctx.query);
  },

  createComment(ctx) {
    const actor = actorOf(ctx);
    const instance = findInstance(actor, ctx.params.id);
    ctx.authorize(instanceScope(instance));
    return addComment(ctx, actor, instance, 'NOTE', ctx.body.body);
  },

  evidenceUploadUrl(ctx) {
    const actor = actorOf(ctx);
    const instance = findInstance(actor, ctx.params.id);
    ctx.authorize(instanceScope(instance));
    requireState(instance, INSTANCE_EDIT_STATES, 'UPLOAD_EVIDENCE');
    const uploadId = ctx.store.newId();
    actor.firm.pendingUploads.set(uploadId, { instanceId: instance.id, ...ctx.body });
    return {
      uploadId,
      url: fileUrl(`uploads/${uploadId}`),
      headers: { 'content-type': ctx.body.mimeType },
      expiresAt: expiresAt(ctx),
    };
  },

  confirmEvidence(ctx) {
    const actor = actorOf(ctx);
    const instance = findInstance(actor, ctx.params.id);
    ctx.authorize(instanceScope(instance));
    requireState(instance, INSTANCE_EDIT_STATES, 'UPLOAD_EVIDENCE');
    const upload = actor.firm.pendingUploads.get(ctx.body.uploadId);
    if (upload === undefined || upload.instanceId !== instance.id) {
      throw new MockError('VALIDATION', 'Unknown upload', {
        issues: [{ path: ['uploadId'], message: 'Unknown upload' }],
      });
    }
    actor.firm.pendingUploads.delete(ctx.body.uploadId);
    const now = ctx.clock.now();
    const id = ctx.store.newId();
    const evidence = {
      id,
      firmId: actor.firm.data.firm.id,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      instanceId: instance.id,
      clientId: instance.clientId,
      fileName: ctx.body.fileName,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      sha256: ctx.body.sha256,
      scanStatus: 'PENDING' as const,
      uploadedById: actor.person.id,
      storageKey: `${actor.firm.data.firm.id}/${instance.clientId}/${instance.id}/${id}`,
    };
    actor.firm.data.evidence.push(evidence);
    actor.firm.scanning.add(id);
    audit(ctx, actor, {
      action: 'EVIDENCE_ADD',
      entityType: 'evidence',
      entityId: id,
      clientId: instance.clientId,
      after: { instanceId: instance.id },
    });
    return evidenceView(evidence);
  },

  listInstanceEvidence(ctx) {
    const actor = actorOf(ctx);
    const instance = findInstance(actor, ctx.params.id);
    ctx.authorize(instanceScope(instance));
    finishScans(actor.firm);
    return {
      items: actor.firm.data.evidence
        .filter((e) => e.instanceId === instance.id && e.archivedAt === null)
        .map(evidenceView),
    };
  },

  evidenceVault(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    finishScans(actor.firm);
    const look = new Lookup(actor.firm);
    const visible = new Set(visibleInstances(actor, clientId).map((i) => i.id));
    const q = ctx.query;
    const inList = <T>(list: T[] | undefined, value: T) =>
      list === undefined || list.includes(value);
    const rows = actor.firm.data.evidence.filter((e) => {
      if (e.archivedAt !== null || !visible.has(e.instanceId)) return false;
      const instance = look.instances.get(e.instanceId)!;
      const assignment = look.assignments.get(instance.assignmentId)!;
      const day = e.createdAt.slice(0, 10);
      return (
        inList(q.unitId, instance.unitId) &&
        inList(q.actId, look.obligationOf(instance).actId) &&
        inList(q.departmentId, assignment.departmentId) &&
        inList(q.scanStatus, e.scanStatus) &&
        (q.uploadedFrom === undefined || day >= q.uploadedFrom) &&
        (q.uploadedTo === undefined || day <= q.uploadedTo) &&
        (q.q === undefined || e.fileName.toLowerCase().includes(q.q.toLowerCase()))
      );
    });
    return paginate(rows.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1)).map(evidenceView), q);
  },

  evidenceDownloadUrl(ctx) {
    const actor = actorOf(ctx);
    const { evidence, instance } = findEvidence(actor, ctx.params.id);
    ctx.authorize(instanceScope(instance));
    finishScans(actor.firm);
    if (evidence.scanStatus !== 'CLEAN') {
      throw new MockError('EVIDENCE_NOT_READY', 'This file has not passed the virus scan', {
        scanStatus: evidence.scanStatus,
      });
    }
    audit(ctx, actor, {
      action: 'EVIDENCE_DOWNLOAD',
      entityType: 'evidence',
      entityId: evidence.id,
      clientId: evidence.clientId,
    });
    return { url: fileUrl(`evidence/${evidence.id}`), expiresAt: expiresAt(ctx) };
  },

  removeEvidence(ctx) {
    const actor = actorOf(ctx);
    const { evidence, instance } = findEvidence(actor, ctx.params.id);
    ctx.authorize(instanceScope(instance));
    const manager = membershipsFor(actor, instance.clientId).some((m) =>
      ['FIRM_ADMIN', 'CONSULTANT', 'CLIENT_ADMIN'].includes(m.role),
    );
    if (!manager && CLOSED.includes(instance.workflowState)) {
      throw new MockError('FORBIDDEN', 'Owners remove evidence only before approval', {
        action: 'evidence.remove',
      });
    }
    evidence.archivedAt = ctx.clock.now();
    evidence.updatedAt = ctx.clock.now();
    audit(ctx, actor, {
      action: 'EVIDENCE_REMOVE',
      entityType: 'evidence',
      entityId: evidence.id,
      clientId: evidence.clientId,
      after: { instanceId: instance.id },
      reason: ctx.body.reason,
    });
    return evidenceView(evidence);
  },

  clientAudit(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const q = ctx.query;
    const rows = actor.firm.data.auditEvents.filter(
      (e) =>
        e.clientId === clientId &&
        (q.entityType === undefined || e.entityType === q.entityType) &&
        (q.entityId === undefined || e.entityId === q.entityId) &&
        (q.actorId === undefined || e.actorId === q.actorId) &&
        (q.action === undefined || q.action.includes(e.action)) &&
        (q.from === undefined || e.at >= q.from) &&
        (q.to === undefined || e.at <= q.to),
    );
    return paginate(
      [...rows].sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0)),
      q,
    );
  },

  instanceAudit(ctx) {
    const actor = actorOf(ctx);
    const instance = findInstance(actor, ctx.params.id);
    ctx.authorize(instanceScope(instance));
    const evidenceIds = new Set(
      actor.firm.data.evidence.filter((e) => e.instanceId === instance.id).map((e) => e.id),
    );
    const rows = actor.firm.data.auditEvents.filter(
      (e) => e.entityId === instance.id || evidenceIds.has(e.entityId),
    );
    return paginate(
      [...rows].sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0)),
      ctx.query,
    );
  },
};

function expiresAt(ctx: Ctx): string {
  return new Date(Date.parse(ctx.clock.now()) + SIGNED_URL_TTL_SECONDS * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
}
