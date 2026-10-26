import type { Metadata } from 'next';
import NextLink from 'next/link';

import { serverApi } from '../../../../../../lib/api/server';
import { PageEmpty, PageHeader } from '../../../../../../lib/patterns';
import { people, standards, systems } from '../_lib/data';
import { isoGate, isoLoad, isoMetadata } from '../_lib/gate';
import { mayCall } from '../_lib/may';
import { clientToday, first, hrefWith } from '../_lib/people';
import { standardTitle } from '../_lib/words';
import { IsoRefusal } from '../_components/IsoStates';
import { isoPath, readinessText } from '../overview/overview-model';
import { ChecklistView } from './ChecklistView';
import { checklistQuery, checklistRows, filterDefs, filtersFrom } from './checklist-model';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TITLE = 'Checklist';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return isoMetadata((await params).clientId, TITLE);
}

// The clause checklist of one management system (packages.md ISO-6a). `?system=` picks the system when the client has
// more than one; the filters are the API's own query.
export default async function IsoChecklistPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  const search = await searchParams;
  const api = await serverApi();
  const loaded = await isoLoad(async () => {
    const [systemList, standardList, peopleList, overview] = await Promise.all([
      systems(api, clientId),
      standards(api, clientId),
      people(api, clientId),
      api.call('getIsoOverview', { params: { clientId } }).then((r) => r.data),
    ]);
    const system = systemList.find((s) => s.id === first(search.system)) ?? systemList[0];
    if (!system) return { systemList, standardList, peopleList, overview, system: null };
    const filters = filtersFrom(search, system.standardIds);
    const rows = (
      await api.call('listIsoChecklist', {
        params: { clientId, id: system.id },
        query: checklistQuery(filters),
      })
    ).data.items;
    return { systemList, standardList, peopleList, overview, system, filters, rows };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const { systemList, standardList, peopleList, overview, system } = loaded.data;
  const manager = mayCall('updateIsoSystem', gate.roles);

  if (!system || !loaded.data.filters) {
    return (
      <>
        <PageHeader title={TITLE} />
        <PageEmpty
          title="No management system yet"
          body={
            manager
              ? 'Set up a management system on the ISO overview. Its checklist is created with it.'
              : 'The checklist appears once your consultant or client admin sets up the management system.'
          }
          action={
            manager
              ? { label: 'Go to ISO overview', href: isoPath(clientId, 'overview') }
              : undefined
          }
        />
      </>
    );
  }

  const { filters, rows } = loaded.data;
  const readiness = overview.systems.find(
    (s) => s.managementSystemId === system.id,
  )?.clauseReadiness;
  const filterValue: Record<string, string[]> = {
    standardId: filters.standardId,
    status: filters.status,
    naState: filters.naState,
    ownerId: filters.ownerId ? [filters.ownerId] : [],
  };

  return (
    <>
      <PageHeader
        title={TITLE}
        description="Each clause of the system's standards: how far it is met, who owns it and the evidence."
        actions={
          manager ? (
            <NextLink
              href={`${isoPath(clientId, 'overview')}#system-setup`}
              prefetch={false}
              className="text-body text-forest underline"
            >
              Add a standard
            </NextLink>
          ) : undefined
        }
      />
      {systemList.length > 1 ? (
        <nav aria-label="Management systems" className="mb-3.5 flex flex-wrap gap-2">
          {systemList.map((s) => (
            <NextLink
              key={s.id}
              href={hrefWith(isoPath(clientId, 'checklist'), { system: s.id })}
              prefetch={false}
              aria-current={s.id === system.id ? 'page' : undefined}
              className={`rounded-pill border px-3 py-1 text-body ${
                s.id === system.id
                  ? 'border-forest bg-forest-soft text-forest'
                  : 'border-line text-ink hover:bg-neutral-soft'
              }`}
            >
              {s.name}
            </NextLink>
          ))}
        </nav>
      ) : null}
      {readiness ? (
        <p className="mb-3.5 text-body text-muted">
          Clause readiness {readinessText(readiness.overall.score)}
          {readiness.byStandard.length > 1
            ? ` (${readiness.byStandard
                .map(
                  (r) => `${standardTitle(standardList, r.standardId)} ${readinessText(r.score)}`,
                )
                .join(', ')})`
            : ''}
          .
        </p>
      ) : null}
      <ChecklistView
        clientId={clientId}
        systemId={system.id}
        rows={checklistRows(rows, standardList, peopleList, system.standardIds)}
        people={peopleList}
        filters={filterDefs(standardList, system.standardIds)}
        filterValue={filterValue}
        openRowId={first(search.row) ?? null}
        editable={{ all: mayCall('updateIsoChecklistRow', gate.roles), personId: gate.personId }}
        canReassign={manager}
        today={clientToday(gate.client.timeZone)}
      />
    </>
  );
}
