'use client';
// The end of the wizard: what was imported, and where to look at it.
import { formatNumber } from '@canopy/ui';
import NextLink from 'next/link';

const linkClass = 'text-body text-forest underline underline-offset-2';

export function Committed({
  clientId,
  clientName,
  fileName,
  rows,
}: {
  clientId: string;
  clientName: string;
  fileName: string;
  rows: number;
}) {
  return (
    <section aria-labelledby="done-heading" className="flex flex-col gap-2">
      <h2 id="done-heading" className="text-card text-ink">
        Import committed
      </h2>
      <p role="status" className="text-body text-ink">
        {formatNumber(rows)} {rows === 1 ? 'row' : 'rows'} from {fileName} are now in {clientName}
        &apos;s compliance register.
      </p>
      <div className="flex flex-wrap gap-4">
        <NextLink href={`/c/${clientId}/overview`} className={linkClass}>
          Open the overview
        </NextLink>
        <NextLink href={`/c/${clientId}/import`} className={linkClass}>
          Start another import
        </NextLink>
      </div>
    </section>
  );
}
