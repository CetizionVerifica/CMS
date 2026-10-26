// An ISO file from the browser (docs/iso/model.md §6, the evidence pipeline): ask for a presigned PUT, send the bytes
// straight to storage, then confirm with the file's SHA-256. The file stays PENDING until the virus scan. File names,
// contents and signed URLs are never logged (root rule 6).
import type { IsoFileSubject, IsoFileView, UploadTicket } from '@canopy/contracts';

import type { Outcome } from './outcome';

export type IsoUploadCalls = {
  ticket: (file: {
    subject: IsoFileSubject;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  }) => Promise<Outcome<UploadTicket>>;
  confirm: (upload: {
    subject: IsoFileSubject;
    uploadId: string;
    fileName: string;
    sha256: string;
  }) => Promise<Outcome<IsoFileView>>;
};

/** Lower-case hex SHA-256, which the confirm step checks against the stored bytes. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The demo API's storage has no host to send bytes to (`*.invalid`), so its uploads skip the PUT. */
export function storageHasNoHost(url: string): boolean {
  return new URL(url).hostname.endsWith('.invalid');
}

export async function uploadIsoFile(
  file: File,
  subject: IsoFileSubject,
  calls: IsoUploadCalls,
  put: (url: string, headers: Record<string, string>, body: Blob) => Promise<Response> = (
    url,
    headers,
    body,
  ) => fetch(url, { method: 'PUT', headers, body }),
): Promise<Outcome<IsoFileView>> {
  const sha256 = await sha256Hex(await file.arrayBuffer());
  const ticket = await calls.ticket({
    subject,
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
  });
  if (!ticket.ok) return ticket;
  if (!storageHasNoHost(ticket.data.url)) {
    const res = await put(ticket.data.url, ticket.data.headers, file).catch(() => null);
    if (!res?.ok) {
      return { ok: false, code: 'UNKNOWN', message: 'The file didn’t upload. Try again.' };
    }
  }
  return calls.confirm({ subject, uploadId: ticket.data.uploadId, fileName: file.name, sha256 });
}
