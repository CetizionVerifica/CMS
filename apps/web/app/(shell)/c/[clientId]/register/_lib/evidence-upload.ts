// Evidence uploads from the browser (api-conventions.md §6): ask the API for a presigned PUT, send the bytes straight
// to storage, then confirm with the file's SHA-256. File names, contents and the signed URL are never logged
// (root rule 6).
import type { EvidenceView, UploadTicket } from '@canopy/contracts';

import { sha256Hex, uploadHasNoHost, type Outcome } from './instance-api';

/** The calls an upload makes; the drawer passes its Server Actions, the tests pass fakes. */
export type UploadCalls = {
  start: (file: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  }) => Promise<Outcome<UploadTicket>>;
  confirm: (upload: {
    uploadId: string;
    fileName: string;
    sha256: string;
  }) => Promise<Outcome<EvidenceView>>;
};

export class UploadAborted extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadAborted';
  }
}

/** PUTs the file to a presigned URL with the ticket's headers, reporting bytes sent. Rejects on a non-2xx answer. */
export function putFile(
  ticket: Pick<UploadTicket, 'url' | 'headers'>,
  file: Blob,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new UploadAborted());
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', ticket.url);
    for (const [name, value] of Object.entries(ticket.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Storage answered ${xhr.status}`));
    xhr.onerror = () => reject(new Error('The upload didn’t reach storage'));
    xhr.onabort = () => reject(new UploadAborted());
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/**
 * One file, start to finish. Answers the confirmed evidence (PENDING until the virus check), or a message to show.
 * A cancel rejects with UploadAborted.
 */
export async function uploadEvidence(
  file: File,
  calls: UploadCalls,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
  put: typeof putFile = putFile,
): Promise<Outcome<EvidenceView>> {
  const sha256 = await sha256Hex(await file.arrayBuffer());
  if (signal.aborted) throw new UploadAborted();
  const ticket = await calls.start({
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
  });
  if (!ticket.ok) return ticket;
  if (!uploadHasNoHost(ticket.data.url)) {
    try {
      await put(ticket.data, file, onProgress, signal);
    } catch (error) {
      if (error instanceof UploadAborted) throw error;
      return { ok: false, code: 'UNKNOWN', message: 'The file didn’t upload. Try again.' };
    }
  }
  onProgress(file.size);
  if (signal.aborted) throw new UploadAborted();
  return calls.confirm({ uploadId: ticket.data.uploadId, fileName: file.name, sha256 });
}
