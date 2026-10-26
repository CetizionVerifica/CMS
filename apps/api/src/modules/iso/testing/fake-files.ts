import { randomUUID } from 'node:crypto';
import type { IsoFileSubject } from '@canopy/contracts';
import { isoFiles, isoFileView } from '@canopy/db';
import { ApiError } from '../../../auth/index.js';
import type { IsoFileCaller, IsoFiles } from '../ports.js';

/**
 * A fake `IsoFiles` for M16's tests (plan §7 item 2), for one client: it records every call but `get` (the lookup
 * M16 makes to find a file's subject), and stores what the real service would
 * through M3 (an `iso_file` row on confirm, archived on remove) in the caller's transaction. It writes no
 * `AuditEvent`: the events each call writes are ISO-15's to test.
 */

export interface FileCall {
  method: keyof IsoFiles;
  subject?: IsoFileSubject;
  fileId?: string;
}

export interface FakeIsoFiles extends IsoFiles {
  readonly calls: FileCall[];
}

export function createFakeIsoFiles(clientId: string): FakeIsoFiles {
  const calls: FileCall[] = [];
  const tickets = new Map<
    string,
    { subject: IsoFileSubject; personId: string; mimeType: string; sizeBytes: number }
  >();
  const expiresAt = '2099-01-01T00:00:00Z';
  const key = (caller: IsoFileCaller, subject: IsoFileSubject, uploadId: string) =>
    `evidence/${caller.firmId}/${clientId}/iso/${subject.type}/${subject.id}/${uploadId}`;
  return {
    calls,
    async uploadUrl(_tx, caller, subject, file) {
      calls.push({ method: 'uploadUrl', subject });
      const uploadId = randomUUID();
      tickets.set(uploadId, { subject, personId: caller.personId, ...file });
      return { uploadId, url: `https://files.example.test/${uploadId}`, headers: {}, expiresAt };
    },
    async confirm(tx, caller, subject, upload) {
      calls.push({ method: 'confirm', subject });
      const ticket = tickets.get(upload.uploadId);
      if (ticket === undefined || ticket.personId !== caller.personId) {
        throw new ApiError('VALIDATION', {
          issues: [{ path: ['uploadId'], message: 'Unknown upload' }],
        });
      }
      const file = await isoFiles.create(tx, {
        clientId,
        subject,
        fileName: upload.fileName,
        mimeType: ticket.mimeType,
        sizeBytes: ticket.sizeBytes,
        sha256: upload.sha256,
        storageKey: key(caller, subject, upload.uploadId),
        uploadedById: caller.personId,
      });
      return isoFileView(file);
    },
    async get(tx, fileId) {
      const file = await isoFiles.get(tx, fileId);
      return file === null ? null : isoFileView(file);
    },
    async list(tx, subject, options) {
      calls.push({ method: 'list', subject });
      return isoFiles.forSubject(tx, subject, options);
    },
    async downloadUrl(tx, _caller, fileId) {
      calls.push({ method: 'downloadUrl', fileId });
      const file = await isoFiles.require(tx, fileId);
      if (file.scanStatus !== 'CLEAN') {
        throw new ApiError('EVIDENCE_NOT_READY', { scanStatus: file.scanStatus });
      }
      return { url: `https://files.example.test/download/${fileId}`, expiresAt };
    },
    async remove(tx, _caller, fileId, reason) {
      calls.push({ method: 'remove', fileId });
      return isoFileView(await isoFiles.archive(tx, fileId, reason));
    },
  };
}
