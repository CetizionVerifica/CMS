'use client';
// The nonconformity log (packages.md ISO-6c, model §3.10): nonconformities, incidents and near misses with the API's
// filters, each with its state and due timing. A row opens its page; the log downloads as the API's Excel export.
import { Button, type DataTableProps, type FilterDef } from '@canopy/ui';
import NextLink from 'next/link';
import { useState } from 'react';

import { ExportButton } from '../_components/ExportButton';
import { IsoFilterBar } from '../_components/IsoFilterBar';
import { StatePill, TimingPill } from '../_components/IsoStates';
import { IsoTable } from '../_components/IsoTable';
import { RaiseNc, type NcRaiseProps } from './NcRaiseForm';
import type { NcRow } from './nc-model';

const columns: DataTableProps<NcRow>['columns'] = [
  {
    id: 'title',
    header: 'Nonconformity',
    accessorFn: (r) => ({ title: r.title, sub: r.sub }) as never,
    meta: { type: 'title', locked: true },
    size: 380,
  },
  {
    id: 'unit',
    header: 'Unit',
    accessorFn: (r) => r.unit as never,
    meta: { type: 'text' },
    size: 150,
  },
  {
    id: 'state',
    header: 'State',
    accessorFn: (r) => r.nc.state as never,
    cell: (ctx) => <StatePill of="NcState" value={ctx.row.original.nc.state} />,
    size: 190,
  },
  {
    id: 'due',
    header: 'Due',
    accessorFn: (r) => r.nc.dueOn as never,
    cell: (ctx) => <TimingPill status={ctx.row.original.nc.status} />,
    size: 150,
  },
  {
    id: 'owner',
    header: 'Owner',
    accessorFn: (r) => r.ownerName as never,
    meta: { type: 'text' },
    size: 160,
  },
  {
    id: 'approver',
    header: 'Approver',
    accessorFn: (r) => r.approverName as never,
    meta: { type: 'text' },
    size: 160,
  },
];

export function NcLogView({
  clientId,
  rows,
  filters,
  filterValue,
  fromOverview,
  clearHref,
  exportFilters,
  raise,
}: {
  clientId: string;
  rows: NcRow[];
  filters: FilterDef[];
  filterValue: Record<string, string[]>;
  /** The log is the exact set an overview number counts (`ids`). */
  fromOverview: boolean;
  clearHref: string;
  /** The log's filters for the download, without `ids`. */
  exportFilters: string;
  raise: NcRaiseProps | null;
}) {
  const [raising, setRaising] = useState(false);
  return (
    <>
      <div className="mb-3.5 flex flex-wrap items-start justify-between gap-3">
        <ExportButton
          clientId={clientId}
          kind="ISO_NC_LOG_XLSX"
          filters={exportFilters}
          label="Download NC log (Excel)"
          note={
            fromOverview
              ? 'Exports the log with these filters, without the overview’s selection.'
              : undefined
          }
        />
        {raise ? (
          <Button variant="primary" onClick={() => setRaising(true)}>
            Raise a nonconformity
          </Button>
        ) : null}
      </div>
      {fromOverview ? (
        <p className="mb-3.5 text-body text-muted">
          Showing the records the ISO overview counted.{' '}
          <NextLink href={clearHref} prefetch={false} className="text-forest underline">
            Show the whole log
          </NextLink>
        </p>
      ) : null}
      <IsoFilterBar
        filters={filters}
        value={filterValue}
        resultText={`${rows.length} ${rows.length === 1 ? 'record' : 'records'}`}
        resultCount={rows.length}
        search={{ placeholder: 'Search the description' }}
      />
      <IsoTable
        label="Nonconformity log"
        columns={columns}
        data={rows}
        rowId={(r) => r.id}
        rowLabel={(r) => r.title}
        rowHref={(r) => `/c/${clientId}/iso/nonconformities/${r.id}`}
        countNoun={{ one: 'record', other: 'records' }}
        empty={
          <p className="p-6 text-body text-muted">
            Nothing matches. Clear a filter, or raise the first nonconformity.
          </p>
        }
      />
      {raising && raise ? <RaiseNc {...raise} onClose={() => setRaising(false)} /> : null}
    </>
  );
}
