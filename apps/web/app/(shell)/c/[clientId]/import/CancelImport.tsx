'use client';
// Cancels an import before it commits. Nothing has been written to the register by then, so the dialog says so.
import { Button, ConfirmDialog } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { cancelAction } from './actions';
import { batchHref } from './import-model';

export function CancelImport({ clientId, batchId }: { clientId: string; batchId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Cancel import
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Cancel this import?"
        body="Nothing has been added to the register yet. You can start a new import afterwards."
        confirmLabel="Cancel import"
        tone="danger"
        onConfirm={async () => {
          setError(null);
          const result = await cancelAction(clientId, batchId);
          // On a refusal the dialog closes too: its own failure line is generic, and the page behind it is inert.
          if (!result.ok) {
            setError(result.message);
            router.refresh();
            return;
          }
          router.push(batchHref(clientId, batchId));
        }}
      />
      {error ? (
        <p role="alert" className="text-body text-crit-ink">
          {error}
        </p>
      ) : null}
    </>
  );
}
