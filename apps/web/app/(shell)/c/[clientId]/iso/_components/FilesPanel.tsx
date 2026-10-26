'use client';
// The files on one ISO record (docs/iso/model.md §6): list, add, download and remove. A file can be downloaded once the
// virus scan has passed; adding and removing are offered only while the record is open for edits (`editable`), and the
// API refuses them on a locked record anyway.
import type { IsoFileSubject, IsoFileView, ScanStatus } from '@canopy/contracts';
import { Button, ConfirmDialog, formatDate } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useState } from 'react';

import { isoRead, isoWrite } from '../_lib/actions';
import { uploadIsoFile } from '../_lib/upload';
import { FormAlert } from './controls';
import { IsoPill, type Tone } from './IsoStates';

const SCAN: Record<ScanStatus, { words: string; tone: Tone }> = {
  PENDING: { words: 'Being checked', tone: 'neutral' },
  CLEAN: { words: 'Ready', tone: 'ok' },
  INFECTED: { words: 'Failed the virus check', tone: 'crit' },
  FAILED: { words: 'Could not be checked', tone: 'warn' },
};

export function FilesPanel({
  clientId,
  subject,
  editable,
  heading = 'Files',
  helper,
}: {
  clientId: string;
  subject: IsoFileSubject;
  editable: boolean;
  heading?: string;
  helper?: string;
}) {
  const router = useRouter();
  const inputId = useId();
  const [files, setFiles] = useState<IsoFileView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<IsoFileView | null>(null);

  const load = useCallback(async () => {
    const result = await isoRead(
      clientId,
      'listIsoFiles',
      {},
      {
        subjectType: subject.type,
        subjectId: subject.id,
      },
    );
    if (result.ok) setFiles(result.data.items);
    else setError(result.message);
  }, [clientId, subject.type, subject.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (file: File) => {
    setBusy(true);
    setError(null);
    const result = await uploadIsoFile(file, subject, {
      ticket: (body) => isoWrite(clientId, 'isoFileUploadUrl', {}, body),
      confirm: (body) => isoWrite(clientId, 'confirmIsoFile', {}, body),
    });
    setBusy(false);
    if (!result.ok) setError(result.message);
    await load();
    router.refresh();
  };

  const download = async (file: IsoFileView) => {
    setError(null);
    const result = await isoRead(clientId, 'isoFileDownloadUrl', { id: file.id });
    if (result.ok) window.location.assign(result.data.url);
    else setError(result.message);
  };

  return (
    <section aria-label={heading} className="flex flex-col gap-2">
      <h3 className="text-body font-semibold text-ink">{heading}</h3>
      {helper ? <p className="text-meta text-muted">{helper}</p> : null}
      {files === null && !error ? (
        <p className="text-meta text-muted" role="status">
          Loading files…
        </p>
      ) : null}
      {files?.length === 0 ? <p className="text-body text-muted">No files yet.</p> : null}
      {files && files.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
          {files.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 break-all text-body text-ink">{f.fileName}</span>
              <span className="text-meta text-muted">{formatDate(f.uploadedAt.slice(0, 10))}</span>
              <IsoPill tone={SCAN[f.scanStatus].tone}>{SCAN[f.scanStatus].words}</IsoPill>
              {f.scanStatus === 'CLEAN' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Download ${f.fileName}`}
                  onClick={() => void download(f)}
                >
                  Download
                </Button>
              ) : null}
              {editable ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${f.fileName}`}
                  onClick={() => setRemoving(f)}
                >
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <FormAlert message={error} />
      {editable ? (
        <div>
          <label
            htmlFor={inputId}
            className="inline-flex min-h-9 cursor-pointer items-center rounded-control border border-line-strong bg-surface px-3 text-body font-semibold text-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-forest"
          >
            {busy ? 'Uploading…' : 'Add a file'}
            <input
              id={inputId}
              type="file"
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void add(file);
              }}
            />
          </label>
        </div>
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.fileName ?? 'this file'}?`}
        body="It stays in the record's history and can't be downloaded from here any more."
        confirmLabel="Remove"
        tone="danger"
        reason={{ label: 'Reason', required: true, maxLength: 2000 }}
        onConfirm={async (reason) => {
          if (!removing) return;
          const result = await isoWrite(
            clientId,
            'removeIsoFile',
            { id: removing.id },
            { reason: reason ?? '' },
          );
          if (!result.ok) {
            setError(result.message);
            throw new Error(result.message);
          }
          setRemoving(null);
          await load();
          router.refresh();
        }}
      />
    </section>
  );
}
