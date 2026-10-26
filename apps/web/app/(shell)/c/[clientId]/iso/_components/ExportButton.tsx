'use client';
// A download of an ISO list as the API's export (the risk register, later the NC log): starts the export with the list's
// filters, waits for it, then opens its short-lived link. Progress and failures are said in a status line.
import type { IsoExportKind } from '@canopy/contracts';
import { Button } from '@canopy/ui';
import { useState } from 'react';

import { isoExportProgress, startIsoExport } from '../_lib/export';

const POLL_TRIES = 20;
const POLL_MS = 1500;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function ExportButton({
  clientId,
  kind,
  filters,
  label,
  note,
}: {
  clientId: string;
  kind: IsoExportKind;
  /** The list's filters as a query string, without paging or `ids`. */
  filters: string;
  label: string;
  /** Said beside the button, e.g. that the overview's selection is not exported. */
  note?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const download = async () => {
    if (busy) return;
    setBusy(true);
    setMessage({ tone: 'info', text: 'Preparing the download…' });
    try {
      const started = await startIsoExport(clientId, kind, filters);
      if (!started.ok) {
        setMessage({ tone: 'error', text: started.message });
        return;
      }
      for (let i = 0; i < POLL_TRIES; i++) {
        const progress = await isoExportProgress(started.id);
        if (progress.status === 'ready') {
          setMessage({ tone: 'info', text: 'The download has started.' });
          window.location.assign(progress.url);
          return;
        }
        if (progress.status === 'failed') {
          setMessage({ tone: 'error', text: progress.message });
          return;
        }
        await wait(POLL_MS);
      }
      setMessage({
        tone: 'error',
        text: 'The download is taking too long. Try again in a few minutes.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <Button size="sm" loading={busy} onClick={() => void download()}>
        {label}
      </Button>
      {note ? <p className="text-meta text-muted">{note}</p> : null}
      <p
        role={message?.tone === 'error' ? 'alert' : 'status'}
        className={message?.tone === 'error' ? 'text-meta text-crit-ink' : 'text-meta text-muted'}
      >
        {message?.text ?? ''}
      </p>
    </div>
  );
}
