'use client';
// Step 1: choose the workbook. The browser hashes it and sends it straight to the presigned URL the API hands out
// (the URL never lands in the DOM or a log), then the API confirms the bytes and the wizard moves to the mapping.
import { FileDrop, type UploadItem } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { confirmUploadAction, startImportAction } from './actions';
import { batchHref } from './import-model';

const MAX_BYTES = 20 * 1024 * 1024;

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function UploadStep({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [item, setItem] = useState<UploadItem | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = async (chosen: File) => {
    setFile(chosen);
    setError(null);
    setItem({ id: 'workbook', name: chosen.name, size: chosen.size, state: 'uploading' });
    const fail = (message: string) => {
      setError(message);
      setItem((current) => (current ? { ...current, state: 'failed' } : current));
    };
    try {
      const started = await startImportAction(clientId, {
        fileName: chosen.name,
        sizeBytes: chosen.size,
      });
      if (!started.ok) return fail(started.message);
      const { batchId, upload: target } = started.value;
      if (target) {
        const res = await fetch(target.url, {
          method: 'PUT',
          headers: target.headers,
          body: chosen,
        });
        if (!res.ok) return fail('The workbook did not upload. Try again.');
      }
      const confirmed = await confirmUploadAction(clientId, batchId, await sha256Hex(chosen));
      if (!confirmed.ok) return fail(confirmed.message);
      setItem((current) => (current ? { ...current, state: 'ready' } : current));
      router.push(batchHref(clientId, batchId));
    } catch {
      fail('The workbook did not upload. Try again.');
    }
  };

  return (
    <section aria-labelledby="upload-heading" className="flex max-w-2xl flex-col gap-3">
      <h2 id="upload-heading" className="text-card text-ink">
        Upload the register workbook
      </h2>
      <p className="text-body text-muted">
        The register&apos;s Excel export, one row per instance. Nothing changes until you commit the
        last step, and you can come back to an import at any time.
      </p>
      <FileDrop
        label="Register workbook"
        accept={['xlsx']}
        maxBytes={MAX_BYTES}
        files={item ? [item] : []}
        onAdd={(files) => void upload(files[0]!)}
        onRemove={() => {
          setItem(null);
          setFile(null);
          setError(null);
        }}
        onRetry={() => {
          if (file) void upload(file);
        }}
        onCancel={() => setItem(null)}
      />
      {error ? (
        <p role="alert" className="text-body text-crit-ink">
          {error}
        </p>
      ) : null}
    </section>
  );
}
