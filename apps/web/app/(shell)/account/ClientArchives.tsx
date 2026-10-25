'use client';
// "Download your data": one zip per client with its whole register and clean evidence files, for account admins, and
// the one thing a closing account still offers (ADR M15-0001, ADR M10-0002). The API builds the zip in the background,
// so this asks after it until the download link is ready.
import { Button } from '@canopy/ui';
import { useState } from 'react';

import { archiveProgressAction, startArchiveAction } from './actions';

// A large client's evidence takes minutes to pack, so this waits longer than the reports page: up to five minutes.
export const ARCHIVE_POLL_MS = 3000;
export const ARCHIVE_POLL_TRIES = 100;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ArchiveClient = { id: string; name: string };

export function ClientArchives({
  clients,
  closing,
  pollMs = ARCHIVE_POLL_MS,
}: {
  clients: ArchiveClient[];
  closing: boolean;
  pollMs?: number;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const download = async (client: ArchiveClient) => {
    if (busy) return;
    setBusy(client.id);
    setMessage({
      tone: 'info',
      text: `Preparing the archive of ${client.name}. A large client can take a few minutes.`,
    });
    try {
      const started = await startArchiveAction(client.id);
      if (!started.ok) {
        setMessage({ tone: 'error', text: started.message });
        return;
      }
      for (let i = 0; i < ARCHIVE_POLL_TRIES; i++) {
        const progress = await archiveProgressAction(started.id);
        if (progress.status === 'ready') {
          setMessage({ tone: 'info', text: `The archive of ${client.name} is downloading.` });
          window.location.assign(progress.url);
          return;
        }
        if (progress.status === 'failed') {
          setMessage({ tone: 'error', text: progress.message });
          return;
        }
        await wait(pollMs);
      }
      setMessage({
        tone: 'error',
        text: 'The archive is taking too long. Try again in a few minutes.',
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="data-heading" className="flex flex-col gap-3">
      <h2 id="data-heading" className="text-section text-ink">
        Download your data
      </h2>
      <p className="text-body text-muted">
        {closing
          ? 'This account is closing. Download each client’s data before the account is deleted.'
          : 'Each client’s whole register, every date and unit, with its evidence files, as one zip file.'}{' '}
        The register opens in Excel and can be imported again. Files still being scanned for viruses
        are left out, and the zip’s README says how many.
      </p>
      {clients.length === 0 ? (
        <p className="text-body text-muted">This account has no clients yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {clients.map((client) => (
            <li
              key={client.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-surface p-3"
            >
              <p className="text-body font-semibold text-ink">{client.name}</p>
              <Button
                variant="secondary"
                onClick={() => void download(client)}
                loading={busy === client.id}
                disabledReason={
                  busy !== null && busy !== client.id
                    ? 'Another archive is being prepared'
                    : undefined
                }
                aria-label={`Download archive of ${client.name}`}
              >
                Download archive
              </Button>
            </li>
          ))}
        </ul>
      )}
      {/* Two fixed live regions, as on the reports page: progress politely, a refusal at once. */}
      <p role="status" className="text-body text-muted">
        {message?.tone === 'info' ? message.text : ''}
      </p>
      <p role="alert" className="text-body text-crit-ink">
        {message?.tone === 'error' ? message.text : ''}
      </p>
    </section>
  );
}
