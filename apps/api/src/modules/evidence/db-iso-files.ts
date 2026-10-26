import {
  MAX_EVIDENCE_BYTES,
  type IsoFileSubject,
  type IsoFileSubjectType,
  type IsoFileView,
  type RequestContext,
  type SignedUrl,
  type UploadTicket,
} from '@canopy/contracts';
import {
  auditEvents,
  auditFindings,
  certifications,
  clauseAssessments,
  documentRevisions,
  externalAudits,
  internalAudits,
  isoActions,
  isoFiles,
  isoFileSubject,
  isoFileView,
  managementReviews,
  nonconformities,
  objectiveReadings,
  riskItems,
  uuidv7,
  type TenantTx,
} from '@canopy/db';
import { ApiError } from '../../auth/index.js';
import { toApiError } from '../instances/access.js';
import { displayName, requireAllowedType } from './files.js';
import { SIGNED_URL_SECONDS, type EvidenceStorage } from './storage.js';

/**
 * Files on ISO records (docs/iso/model.md §6), the `IsoFiles` port M16 declares in `modules/iso/ports.ts`. The same
 * pipeline and rules as instance evidence: a 5-minute PUT for an allowed type and size, confirm (PENDING until the
 * M9 scan), CLEAN-only 5-minute GET, remove with a reason (archived, never deleted). Every call runs in the caller's
 * tenant transaction, so the `iso_file` row and its `AuditEvent` on the ISO subject commit or roll back together.
 * There is no route here: M16 checks the feature, the subject, unit scope, `can()` and the lock rule first.
 * Audit entries name the file id only, never the file name or a signed URL; nothing here logs (root CLAUDE.md rule 6).
 */

/** Who is calling: the audit actor, the uploader, and the firm in the storage key. */
export type IsoFileCaller = Pick<RequestContext, 'firmId' | 'personId' | 'requestId'>;

export interface IsoFilesOptions {
  readonly storage: EvidenceStorage;
  /** Defaults to the system clock. */
  readonly clock?: () => Date;
}

/** Each subject type's reader, for the subject's client (RLS hides other tenants, so they read as missing). */
const SUBJECT_READERS: Record<
  IsoFileSubjectType,
  (tx: TenantTx, id: string) => Promise<{ clientId: string; archivedAt: string | null } | null>
> = {
  clause_assessment: clauseAssessments.get,
  document_revision: documentRevisions.get,
  risk_item: riskItems.get,
  objective_reading: objectiveReadings.get,
  internal_audit: internalAudits.get,
  audit_finding: auditFindings.get,
  external_audit: externalAudits.get,
  certification: certifications.get,
  nonconformity: nonconformities.get,
  iso_action: isoActions.get,
  management_review: managementReviews.get,
};

/** Where an ISO upload is stored, inside the account purge prefix `evidence/<firmId>/` (model §6). */
export function isoStorageKey(input: {
  firmId: string;
  clientId: string;
  subject: IsoFileSubject;
  uploadId: string;
}): string {
  const { firmId, clientId, subject, uploadId } = input;
  return `evidence/${firmId}/${clientId}/iso/${subject.type}/${subject.id}/${uploadId}`;
}

export function createIsoFiles(options: IsoFilesOptions) {
  const { storage } = options;
  const clock = options.clock ?? (() => new Date());
  const expiresAt = () => new Date(clock().getTime() + SIGNED_URL_SECONDS * 1000).toISOString();

  /** The live subject's client; NOT_FOUND when it is missing, removed or in another tenant. */
  async function subjectClient(tx: TenantTx, subject: IsoFileSubject): Promise<string> {
    const record = await SUBJECT_READERS[subject.type](tx, subject.id);
    if (record === null || record.archivedAt !== null) throw new ApiError('NOT_FOUND');
    return record.clientId;
  }

  /** A live file; NOT_FOUND when it is missing, removed or in another tenant. */
  async function liveFile(tx: TenantTx, fileId: string) {
    const file = await isoFiles.get(tx, fileId);
    if (file === null || file.archivedAt !== null) throw new ApiError('NOT_FOUND');
    return file;
  }

  function audit(
    tx: TenantTx,
    caller: IsoFileCaller,
    entry: {
      clientId: string;
      subject: IsoFileSubject;
      action: 'EVIDENCE_ADD' | 'EVIDENCE_DOWNLOAD' | 'EVIDENCE_REMOVE';
      fileId: string;
      reason?: string;
    },
  ) {
    return auditEvents.append(tx, {
      clientId: entry.clientId,
      requestId: caller.requestId,
      actorId: caller.personId,
      actorKind: 'PERSON',
      action: entry.action,
      entityType: entry.subject.type,
      entityId: entry.subject.id,
      before: null,
      after: { fileId: entry.fileId },
      reason: entry.reason ?? null,
    });
  }

  return {
    /** A 5-minute PUT for exactly this type and size, on a live subject. Writes nothing. */
    async uploadUrl(
      tx: TenantTx,
      caller: IsoFileCaller,
      subject: IsoFileSubject,
      file: { fileName: string; mimeType: string; sizeBytes: number },
    ): Promise<UploadTicket> {
      const clientId = await subjectClient(tx, subject).catch(toApiError);
      requireAllowedType(displayName(file.fileName), file.mimeType);
      if (
        !Number.isInteger(file.sizeBytes) ||
        file.sizeBytes < 1 ||
        file.sizeBytes > MAX_EVIDENCE_BYTES
      ) {
        throw new ApiError('VALIDATION', {
          issues: [{ path: ['sizeBytes'], message: 'The file is empty or over 25 MB.' }],
        });
      }
      const uploadId = uuidv7();
      const key = isoStorageKey({ firmId: caller.firmId, clientId, subject, uploadId });
      const put = await storage.presignPut(key, {
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      });
      return { uploadId, url: put.url, headers: put.headers, expiresAt: expiresAt() };
    },

    /** Records an uploaded file as PENDING until the scan job runs; audited as EVIDENCE_ADD on the subject. */
    async confirm(
      tx: TenantTx,
      caller: IsoFileCaller,
      subject: IsoFileSubject,
      upload: { uploadId: string; fileName: string; sha256: string },
    ): Promise<IsoFileView> {
      try {
        const clientId = await subjectClient(tx, subject);
        const key = isoStorageKey({
          firmId: caller.firmId,
          clientId,
          subject,
          uploadId: upload.uploadId,
        });
        const stored = await storage.head(key);
        if (stored === null) {
          throw new ApiError('VALIDATION', {
            issues: [{ path: ['uploadId'], message: 'Nothing was uploaded for this upload id.' }],
          });
        }
        // The PUT was signed for one type and size; check what arrived against the same rules.
        const fileName = displayName(upload.fileName);
        requireAllowedType(fileName, stored.mimeType);
        if (stored.sizeBytes < 1 || stored.sizeBytes > MAX_EVIDENCE_BYTES) {
          throw new ApiError('VALIDATION', {
            issues: [{ path: ['uploadId'], message: 'The uploaded file is empty or over 25 MB.' }],
          });
        }
        const created = await isoFiles.create(tx, {
          clientId,
          subject,
          fileName,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: upload.sha256,
          storageKey: key,
          uploadedById: caller.personId,
        });
        await audit(tx, caller, { clientId, subject, action: 'EVIDENCE_ADD', fileId: created.id });
        return isoFileView(created);
      } catch (error) {
        return toApiError(error);
      }
    },

    /** One subject's files, oldest first, metadata only; removed ones only when asked. Writes nothing. */
    list(
      tx: TenantTx,
      subject: IsoFileSubject,
      options: { includeRemoved?: boolean } = {},
    ): Promise<IsoFileView[]> {
      return isoFiles.forSubject(tx, subject, options).catch(toApiError);
    },

    /** One file with its subject, removed or not, so M16 can check the subject first; null when not found. */
    async get(tx: TenantTx, fileId: string): Promise<IsoFileView | null> {
      const file = await isoFiles.get(tx, fileId).catch(toApiError);
      return file === null ? null : isoFileView(file);
    },

    /** A 5-minute GET for a CLEAN live file; audited as EVIDENCE_DOWNLOAD on the subject. */
    async downloadUrl(tx: TenantTx, caller: IsoFileCaller, fileId: string): Promise<SignedUrl> {
      try {
        const file = await liveFile(tx, fileId);
        if (file.scanStatus !== 'CLEAN') {
          throw new ApiError('EVIDENCE_NOT_READY', { scanStatus: file.scanStatus });
        }
        const url = await storage.presignGet(file.storageKey, file.fileName);
        await audit(tx, caller, {
          clientId: file.clientId,
          subject: isoFileSubject(file),
          action: 'EVIDENCE_DOWNLOAD',
          fileId: file.id,
        });
        return { url, expiresAt: expiresAt() };
      } catch (error) {
        return toApiError(error);
      }
    },

    /** Archives a live file with its reason (never deletes it); audited as EVIDENCE_REMOVE on the subject. */
    async remove(
      tx: TenantTx,
      caller: IsoFileCaller,
      fileId: string,
      reason: string,
    ): Promise<IsoFileView> {
      try {
        const trimmed = reason.trim();
        if (trimmed === '') throw new ApiError('REASON_REQUIRED');
        const file = await liveFile(tx, fileId);
        const archived = await isoFiles.archive(tx, file.id, trimmed);
        await audit(tx, caller, {
          clientId: file.clientId,
          subject: isoFileSubject(file),
          action: 'EVIDENCE_REMOVE',
          fileId: file.id,
          reason: trimmed,
        });
        return isoFileView(archived);
      } catch (error) {
        return toApiError(error);
      }
    },
  };
}

export type IsoFilesService = ReturnType<typeof createIsoFiles>;
