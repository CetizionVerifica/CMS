import {
  MAX_EVIDENCE_BYTES,
  type ComplianceInstance,
  type Evidence,
  type EvidenceView,
  type RequestContext,
  type ScanStatus,
  type SignedUrl,
  type UploadTicket,
} from '@canopy/contracts';
import {
  assignments,
  auditEvents,
  evidence,
  obligations,
  instances,
  systemContext,
  tenantFromRequest,
  uuidv7,
  type Database,
  type TenantTx,
} from '@canopy/db';
import { ApiError } from '../../auth/index.js';
import { loadInstance, toApiError } from '../instances/access.js';
import { instanceResource } from '../instances/allowed-actions.js';
import { emit, emitAs } from '../instances/events.js';
import { rolesIn } from '../instances/scope.js';
import type { Actor } from '../instances/service.js';
import { ACTIVE_STATES } from '../instances/workflow.js';
import { displayName, requireAllowedType, storageKey } from './files.js';
import { SIGNED_URL_SECONDS, type EvidenceStorage } from './storage.js';

/**
 * Evidence for M7's routes (endpoints.md §4, api-conventions.md §6). Each change writes its AuditEvent (on the
 * instance, so the instance history shows it) and its outbox event in the same transaction (root CLAUDE.md
 * rule 2). Audit and event payloads carry ids, sizes and types, never file names: they can name employees
 * (rule 6). Signed URLs go to the caller only.
 */

export interface EvidenceServiceOptions {
  readonly db: Database;
  readonly storage: EvidenceStorage;
  /** Defaults to the system clock. */
  readonly clock?: () => Date;
}

/** Roles that may remove evidence in any state; an OWNER only before approval (endpoints.md §4). */
const REMOVE_ANY_STATE = ['FIRM_ADMIN', 'CONSULTANT', 'CLIENT_ADMIN'] as const;

const view = ({ storageKey: _key, ...rest }: Evidence): EvidenceView => rest;

export function createEvidenceService(options: EvidenceServiceOptions) {
  const { db, storage } = options;
  const clock = options.clock ?? (() => new Date());
  const expiresAt = () => new Date(clock().getTime() + SIGNED_URL_SECONDS * 1000).toISOString();

  function inTenant<T>(ctx: RequestContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return db.withTenant(tenantFromRequest(ctx), fn).catch(toApiError);
  }

  /** Uploads go to instances that are still being worked on (ADR 0004 §7). */
  function requireActive(state: string): void {
    if (!(ACTIVE_STATES as readonly string[]).includes(state)) {
      throw new ApiError('INVALID_TRANSITION', { from: state, action: 'UPLOAD_EVIDENCE' });
    }
  }

  /**
   * A completion waiting for approval keeps the clean file it was submitted with when the obligation needs
   * evidence; send it back to change the evidence instead. Approval checks again (workflow.ts).
   */
  async function keepRequiredEvidence(
    tx: TenantTx,
    instance: ComplianceInstance,
    file: EvidenceView,
  ): Promise<void> {
    if (instance.workflowState !== 'SUBMITTED' || instance.pendingKind !== 'COMPLETION') return;
    if (file.scanStatus !== 'CLEAN') return;
    const assignment = await assignments.require(tx, instance.assignmentId);
    const obligation = await obligations.require(tx, assignment.obligationId);
    if (!obligation.evidenceRequired) return;
    const others = await evidence.forInstance(tx, instance.id);
    if (others.some((f) => f.id !== file.id && f.scanStatus === 'CLEAN')) return;
    throw new ApiError(
      'EVIDENCE_REQUIRED',
      undefined,
      'This is the only clean evidence for a submitted completion. Send it back before removing it.',
    );
  }

  /** Live evidence the actor's tenant can see, with its instance. */
  async function loadEvidence(tx: TenantTx, ctx: RequestContext, id: string) {
    const file = await evidence.get(tx, id);
    if (file === null || file.archivedAt !== null) throw new ApiError('NOT_FOUND');
    const instance = await loadInstance(tx, ctx, file.instanceId);
    return { file, instance };
  }

  function audit(
    tx: TenantTx,
    ctx: RequestContext,
    entry: {
      clientId: string;
      instanceId: string;
      action: 'EVIDENCE_ADD' | 'EVIDENCE_REMOVE' | 'EVIDENCE_DOWNLOAD';
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      reason?: string | null;
    },
  ) {
    return auditEvents.append(tx, {
      clientId: entry.clientId,
      requestId: ctx.requestId,
      actorId: ctx.personId,
      actorKind: 'PERSON',
      action: entry.action,
      entityType: 'instance',
      entityId: entry.instanceId,
      before: entry.before,
      after: entry.after,
      reason: entry.reason ?? null,
    });
  }

  return {
    /** POST /instances/{id}/evidence/upload-url: a 5-minute PUT for exactly this type and size. */
    async uploadUrl(
      actor: Actor,
      instanceId: string,
      body: { fileName: string; mimeType: string; sizeBytes: number },
    ): Promise<UploadTicket> {
      const { ctx } = actor;
      const instance = await inTenant(ctx, async (tx) => {
        const found = await loadInstance(tx, ctx, instanceId);
        actor.authorize('evidence.write', instanceResource(found));
        return found;
      });
      requireActive(instance.workflowState);
      requireAllowedType(displayName(body.fileName), body.mimeType);
      const uploadId = uuidv7();
      const key = storageKey({
        firmId: ctx.firmId,
        clientId: instance.clientId,
        instanceId: instance.id,
        uploadId,
      });
      const put = await storage.presignPut(key, {
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
      });
      return { uploadId, url: put.url, headers: put.headers, expiresAt: expiresAt() };
    },

    /** POST /instances/{id}/evidence: records an uploaded file as PENDING until the scan job runs. */
    async confirm(
      actor: Actor,
      instanceId: string,
      body: { uploadId: string; fileName: string; sha256: string },
    ): Promise<EvidenceView> {
      const { ctx } = actor;
      return inTenant(ctx, async (tx) => {
        const instance = await loadInstance(tx, ctx, instanceId);
        actor.authorize('evidence.write', instanceResource(instance));
        requireActive(instance.workflowState);
        const key = storageKey({
          firmId: ctx.firmId,
          clientId: instance.clientId,
          instanceId: instance.id,
          uploadId: body.uploadId,
        });
        const stored = await storage.head(key);
        if (stored === null) {
          throw new ApiError('VALIDATION', {
            issues: [{ path: ['uploadId'], message: 'Nothing was uploaded for this upload id.' }],
          });
        }
        // The PUT was signed for one type and size; check what arrived against the same rules.
        const fileName = displayName(body.fileName);
        requireAllowedType(fileName, stored.mimeType);
        if (stored.sizeBytes < 1 || stored.sizeBytes > MAX_EVIDENCE_BYTES) {
          throw new ApiError('VALIDATION', {
            issues: [{ path: ['uploadId'], message: 'The uploaded file is empty or over 25 MB.' }],
          });
        }
        const created = await evidence.create(tx, {
          instanceId: instance.id,
          clientId: instance.clientId,
          storageKey: key,
          fileName,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: body.sha256,
          uploadedById: ctx.personId,
        });
        const facts = {
          evidenceId: created.id,
          mimeType: created.mimeType,
          sizeBytes: created.sizeBytes,
        };
        await audit(tx, ctx, {
          clientId: instance.clientId,
          instanceId: instance.id,
          action: 'EVIDENCE_ADD',
          before: null,
          after: { ...facts, scanStatus: created.scanStatus },
        });
        await emit(
          tx,
          ctx,
          { type: 'evidence.uploaded', data: { ...facts, instanceId: instance.id } },
          instance.clientId,
          { type: 'instance', id: instance.id, version: instance.version },
        );
        return view(created);
      });
    },

    /** GET /instances/{id}/evidence: live files, metadata only. */
    async listForInstance(actor: Actor, instanceId: string): Promise<{ items: EvidenceView[] }> {
      const { ctx } = actor;
      return inTenant(ctx, async (tx) => {
        const instance = await loadInstance(tx, ctx, instanceId);
        actor.authorize('evidence.read', instanceResource(instance));
        return { items: await evidence.forInstance(tx, instance.id) };
      });
    },

    /** GET /evidence/{id}/download-url: a 5-minute GET for a CLEAN file, audited. */
    async downloadUrl(actor: Actor, id: string): Promise<SignedUrl> {
      const { ctx } = actor;
      return inTenant(ctx, async (tx) => {
        const { file, instance } = await loadEvidence(tx, ctx, id);
        actor.authorize('evidence.download', instanceResource(instance));
        if (file.scanStatus !== 'CLEAN') {
          throw new ApiError('EVIDENCE_NOT_READY', { scanStatus: file.scanStatus });
        }
        const url = await storage.presignGet(file.storageKey, file.fileName);
        await audit(tx, ctx, {
          clientId: instance.clientId,
          instanceId: instance.id,
          action: 'EVIDENCE_DOWNLOAD',
          before: null,
          after: { evidenceId: file.id },
        });
        await emit(
          tx,
          ctx,
          { type: 'evidence.downloaded', data: { evidenceId: file.id, instanceId: instance.id } },
          instance.clientId,
          { type: 'instance', id: instance.id, version: instance.version },
        );
        return { url, expiresAt: expiresAt() };
      });
    },

    /** POST /evidence/{id}/remove: archives the file (never deletes it), with a reason. */
    async remove(actor: Actor, id: string, body: { reason: string }): Promise<EvidenceView> {
      const { ctx } = actor;
      return inTenant(ctx, async (tx) => {
        const { file, instance } = await loadEvidence(tx, ctx, id);
        actor.authorize('evidence.remove', instanceResource(instance));
        const held = rolesIn(ctx, instance.clientId);
        const anyState = REMOVE_ANY_STATE.some((role) => held.has(role));
        if (!anyState && !(ACTIVE_STATES as readonly string[]).includes(instance.workflowState)) {
          // An owner may not change the evidence behind an approved result.
          throw new ApiError('FORBIDDEN', { action: 'evidence.remove' });
        }
        const reason = body.reason.trim();
        if (reason === '') throw new ApiError('REASON_REQUIRED');
        await keepRequiredEvidence(tx, instance, file);
        const archived = await evidence.archive(tx, file.id);
        await audit(tx, ctx, {
          clientId: instance.clientId,
          instanceId: instance.id,
          action: 'EVIDENCE_REMOVE',
          before: { evidenceId: file.id, archived: false },
          after: { evidenceId: file.id, archived: true },
          reason,
        });
        await emit(
          tx,
          ctx,
          { type: 'evidence.removed', data: { evidenceId: file.id, instanceId: instance.id } },
          instance.clientId,
          { type: 'instance', id: instance.id, version: instance.version },
        );
        return view(archived);
      });
    },

    /**
     * For the virus-scan job (M9; endpoints.md §4 "internal only"): records the result as the system. A file
     * already scanned keeps its first result, so a retried job changes nothing.
     */
    async scanned(
      input: { firmId: string; requestId: string; job: string },
      id: string,
      result: Exclude<ScanStatus, 'PENDING'>,
    ): Promise<EvidenceView> {
      return db
        .withTenant(systemContext(input.firmId, input.requestId), async (tx) => {
          const file = await evidence.require(tx, id);
          if (file.scanStatus !== 'PENDING') return view(file);
          const instance = await instances.require(tx, file.instanceId);
          const updated = await evidence.setScanStatus(tx, id, result);
          await auditEvents.append(tx, {
            clientId: file.clientId,
            requestId: input.requestId,
            actorId: null,
            actorKind: 'SYSTEM',
            action: 'UPDATE',
            entityType: 'instance',
            entityId: file.instanceId,
            before: { evidenceId: file.id, scanStatus: file.scanStatus },
            after: { evidenceId: file.id, scanStatus: result },
            reason: null,
          });
          await emitAs(
            tx,
            { actor: { kind: 'SYSTEM', job: input.job }, requestId: input.requestId },
            {
              type: 'evidence.scanned',
              data: { evidenceId: file.id, instanceId: file.instanceId, scanStatus: result },
            },
            file.clientId,
            { type: 'instance', id: instance.id, version: instance.version },
          );
          return view(updated);
        })
        .catch(toApiError);
    },
  };
}

export type EvidenceService = ReturnType<typeof createEvidenceService>;
