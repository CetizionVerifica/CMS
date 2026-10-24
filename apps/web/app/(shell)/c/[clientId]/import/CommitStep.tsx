'use client';
// Step 4: what the commit would create, update and leave alone, from the API's dry run; then the commit itself,
// confirmed in a dialog because it writes to the client's register.
import type { DryRunReport } from '@canopy/contracts';
import { Button, ConfirmDialog, formatNumber } from '@canopy/ui';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { commitAction } from './actions';
import { CancelImport } from './CancelImport';
import { batchHref, dryRunLines, type DryRunLine } from './import-model';

export type CommitStepProps = {
  clientId: string;
  clientName: string;
  batchId: string;
  report: DryRunReport;
};

export function CommitStep({ clientId, clientName, batchId, report }: CommitStepProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lines = dryRunLines(report);
  const instances = report.create.instances + report.update.instances;

  return (
    <section aria-labelledby="commit-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="commit-heading" className="text-card text-ink">
          Dry run
        </h2>
        <p className="text-body text-muted">
          This is what the import will do. Nothing has changed yet.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
        <Counts title="To add" lines={lines.create} empty="Nothing new." />
        <Counts title="To update" lines={lines.update} empty="Nothing to update." />
      </div>
      <p className="text-body text-ink">
        {formatNumber(lines.unchanged)} {lines.unchanged === 1 ? 'instance is' : 'instances are'}{' '}
        already in the register and stay as they are.
        {lines.skipped > 0
          ? ` ${formatNumber(lines.skipped)} ${lines.skipped === 1 ? 'row is' : 'rows are'} skipped.`
          : ''}
      </p>
      {lines.blocking > 0 ? (
        <p role="alert" className="text-body text-crit-ink">
          {formatNumber(lines.blocking)} {lines.blocking === 1 ? 'row has' : 'rows have'} errors
          that stop the commit. Go back to the review.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-body text-crit-ink">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => setOpen(true)}
          disabledReason={lines.blocking > 0 ? 'Errors stop the commit' : undefined}
        >
          Commit the import
        </Button>
        <Button variant="secondary" asChild>
          <NextLink href={batchHref(clientId, batchId, 'review')}>Change decisions</NextLink>
        </Button>
        <CancelImport clientId={clientId} batchId={batchId} />
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Commit this import to ${clientName}?`}
        body={`${formatNumber(instances)} ${instances === 1 ? 'instance' : 'instances'} will be added or updated in the register. Each change is recorded in the audit trail.`}
        confirmLabel="Commit the import"
        onConfirm={async () => {
          setError(null);
          const result = await commitAction(clientId, batchId);
          // On a refusal the dialog closes too: its own failure line is generic, and the page behind it is inert.
          if (!result.ok) setError(result.message);
          router.refresh();
        }}
      />
    </section>
  );
}

function Counts({ title, lines, empty }: { title: string; lines: DryRunLine[]; empty: string }) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4"
    >
      <h3 className="text-body font-semibold text-ink">{title}</h3>
      {lines.length === 0 ? (
        <p className="text-body text-muted">{empty}</p>
      ) : (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-body">
          {lines.map((l) => (
            <div key={l.label} className="contents">
              <dt className="text-muted">{l.label}</dt>
              <dd className="text-right tabular text-ink">{formatNumber(l.count)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
