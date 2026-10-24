import { Id } from '@canopy/contracts';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';

import { isApiError } from '../../../../../lib/api/client';
import { redirectIfSignedOut } from '../overview/signed-out';
import { serverApi } from '../../../../../lib/api/server';
import { NoPermission, PageHeader } from '../../../../../lib/patterns';
import { homeHref } from '../../../../../lib/shell/model';
import { loadShell } from '../../../../../lib/shell/server';
import { CommitStep } from './CommitStep';
import { Committed } from './Committed';
import { ImportHistory } from './ImportHistory';
import { ImportSteps } from './ImportSteps';
import { MapStep } from './MapStep';
import { ReviewStep } from './ReviewStep';
import { UploadStep } from './UploadStep';
import { Waiting } from './Waiting';
import { batchHref, batchView, currentStep, historyItems } from './import-model';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId } = await params;
  const client = (await loadShell()).clients.find((c) => c.id === clientId);
  return { title: ['Import', client?.name].filter(Boolean).join(' · ') };
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

const linkClass = 'text-body text-forest underline underline-offset-2';

// The import wizard (MODULES.md M13; apps/web/CLAUDE.md "Import"). `?batch=` names the import being worked on; its
// status on the server picks the step, so a person can leave and come back to the same place.
export default async function ImportPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const model = await loadShell();
  const client = model.clients.find((c) => c.id === clientId);
  if (!client) notFound();
  const query = await searchParams;
  const batchParam = Id.safeParse(first(query.batch));
  const api = await serverApi();

  const header = (
    <PageHeader
      title="Import"
      description={`Bring ${client.name}'s compliance register in from its Excel workbook.`}
    />
  );

  try {
    if (!batchParam.success) {
      const { data } = await api.call('listImports', {
        params: { clientId },
        query: { limit: '20' },
      });
      const items = historyItems(clientId, data.items);
      return (
        <>
          {header}
          <ImportSteps current="upload" />
          <UploadStep clientId={clientId} />
          {items.length > 0 ? (
            <section aria-labelledby="history-heading" className="mt-6 flex flex-col gap-2">
              <h2 id="history-heading" className="text-card text-ink">
                Earlier imports
              </h2>
              <ImportHistory items={items} timeZone={client.timeZone} />
            </section>
          ) : null}
        </>
      );
    }

    const batchId = batchParam.data;
    const { data: batch } = await api.call('getImport', { params: { id: batchId } });
    if (batch.clientId !== clientId) notFound();
    let view = batchView(batch, {
      parseStarted: first(query.parsing) === '1',
      wantReview: first(query.step) === 'review',
    });
    if (view.kind === 'commit' && batch.dryRun === null) view = { kind: 'review' };

    let body;
    switch (view.kind) {
      case 'map':
        body = (
          <MapStep
            clientId={clientId}
            batchId={batchId}
            fileName={batch.fileName}
            sheetName={batch.sheetName ?? ''}
            mapping={batch.mapping ?? []}
          />
        );
        break;
      case 'working':
        body = (
          <div className="flex flex-col gap-2">
            <Waiting message={view.message} />
            {view.step === 'map' ? (
              <NextLink href={batchHref(clientId, batchId)} className={linkClass}>
                Back to the column mapping
              </NextLink>
            ) : null}
          </div>
        );
        break;
      case 'review': {
        const { data } = await api.call('listImportIssues', { params: { id: batchId } });
        body = <ReviewStep clientId={clientId} batchId={batchId} groups={data.items} />;
        break;
      }
      case 'commit':
        body = (
          <CommitStep
            clientId={clientId}
            clientName={client.name}
            batchId={batchId}
            report={batch.dryRun!}
          />
        );
        break;
      case 'done':
        body = (
          <Committed
            clientId={clientId}
            clientName={client.name}
            fileName={batch.fileName}
            rows={batch.counts?.rows ?? 0}
          />
        );
        break;
      case 'closed':
        body = (
          <section className="flex flex-col gap-2">
            <p className="text-body text-ink">{view.message}</p>
            <NextLink href={`/c/${clientId}/import`} className={linkClass}>
              Start a new import
            </NextLink>
          </section>
        );
        break;
    }

    return (
      <>
        {header}
        <ImportSteps current={currentStep(view)} done={view.kind === 'done'} />
        {body}
      </>
    );
  } catch (error) {
    await redirectIfSignedOut(error);
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
      return <NoPermission what="imports" backHref={homeHref(model)} backLabel="Go to home" />;
    }
    if (isApiError(error, 'NOT_FOUND')) notFound();
    throw error;
  }
}
