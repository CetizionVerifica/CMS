import type {
  IsoFileSubject,
  IsoFileView,
  RequestContext,
  SignedUrl,
  UploadTicket,
} from '@canopy/contracts';
import type { TenantTx } from '@canopy/db';

/**
 * The ISO file service M16 calls for its file routes (docs/iso/model.md §6). M7 implements it (ISO-15,
 * `createIsoFiles` in `apps/api/src/modules/evidence/`); M16 never imports M7 code. M16 checks the feature, the
 * subject, unit scope, `can()` and the lock rule first, then calls the port inside the request's tenant transaction,
 * so the `iso_file` row and its `AuditEvent` (on the ISO subject) commit together.
 *
 * Model §6's sketch passes only `tx`; every write also takes the caller, since the tenant transaction does not carry
 * the person or the request id an `AuditEvent` and a storage key need (the client comes from the subject).
 */

/** Who is acting, for the storage key and the `AuditEvent`. */
export type IsoFileCaller = Pick<RequestContext, 'firmId' | 'personId' | 'requestId'>;

export interface IsoFileUpload {
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface IsoFileConfirm {
  readonly uploadId: string;
  readonly fileName: string;
  readonly sha256: string;
}

export interface IsoFiles {
  /** A 5-minute presigned PUT for one file on the subject. Writes no `AuditEvent`. */
  uploadUrl(
    tx: TenantTx,
    caller: IsoFileCaller,
    subject: IsoFileSubject,
    file: IsoFileUpload,
  ): Promise<UploadTicket>;
  /** The actor's own upload for this subject, stored PENDING until scanned; audited as `EVIDENCE_ADD`. */
  confirm(
    tx: TenantTx,
    caller: IsoFileCaller,
    subject: IsoFileSubject,
    upload: IsoFileConfirm,
  ): Promise<IsoFileView>;
  /** The subject's files, oldest first; removed ones only when asked. Writes no `AuditEvent`. */
  list(
    tx: TenantTx,
    subject: IsoFileSubject,
    options?: { includeRemoved?: boolean },
  ): Promise<IsoFileView[]>;
  /** One file by id, removed ones included, so M16 can check its subject and lock first; null if none. */
  get(tx: TenantTx, fileId: string): Promise<IsoFileView | null>;
  /** A 5-minute signed GET for a CLEAN file (422 EVIDENCE_NOT_READY otherwise); audited as `EVIDENCE_DOWNLOAD`. */
  downloadUrl(tx: TenantTx, caller: IsoFileCaller, fileId: string): Promise<SignedUrl>;
  /** Archives the file with the reason (never deletes); audited as `EVIDENCE_REMOVE`. */
  remove(tx: TenantTx, caller: IsoFileCaller, fileId: string, reason: string): Promise<IsoFileView>;
}
