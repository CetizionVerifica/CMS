'use client';
// The risk register (packages.md ISO-6b, model §3.5): a tab per kind and an All tab, the API's filters, and each item's
// rating with its controls in place, the residual rating, significance and review timing. A row opens the item's page.
import type { RiskKind } from '@canopy/contracts';
import { Button, type DataTableProps, type FilterDef } from '@canopy/ui';
import NextLink from 'next/link';
import { useState } from 'react';

import { ExportButton } from '../_components/ExportButton';
import { IsoFilterBar } from '../_components/IsoFilterBar';
import { IsoPill, TimingPill } from '../_components/IsoStates';
import { IsoTable } from '../_components/IsoTable';
import { NewRisk, type RiskFormProps } from './RiskForm';
import type { RiskRow } from './risks-model';

const columns: DataTableProps<RiskRow>['columns'] = [
  {
    id: 'title',
    header: 'Item',
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
    id: 'rating',
    header: 'Rating',
    accessorFn: (r) => r.rating as never,
    cell: (ctx) => ctx.row.original.ratingText,
    size: 110,
  },
  {
    id: 'residual',
    header: 'Residual',
    accessorFn: (r) => (r.risk.residualRating ?? 0) as never,
    cell: (ctx) => ctx.row.original.residualText,
    size: 110,
  },
  {
    id: 'significant',
    header: 'Significance',
    accessorFn: (r) => (r.risk.significant ? 1 : 0) as never,
    cell: (ctx) =>
      ctx.row.original.risk.archivedAt ? (
        <IsoPill>Archived</IsoPill>
      ) : ctx.row.original.risk.significant ? (
        <IsoPill tone="warn">Significant</IsoPill>
      ) : (
        <IsoPill>Not significant</IsoPill>
      ),
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
    id: 'review',
    header: 'Review',
    accessorFn: (r) => (r.risk.reviewDueOn ?? '') as never,
    cell: (ctx) =>
      ctx.row.original.risk.reviewDueOn ? (
        <TimingPill status={ctx.row.original.risk.reviewStatus} />
      ) : (
        <span className="text-muted">No date set</span>
      ),
    size: 150,
  },
];

export function RisksView({
  clientId,
  rows,
  tabs,
  kind,
  filters,
  filterValue,
  fromOverview,
  clearHref,
  exportFilters,
  create,
}: {
  clientId: string;
  rows: RiskRow[];
  tabs: { label: string; href: string; current: boolean }[];
  kind: RiskKind | undefined;
  filters: FilterDef[];
  filterValue: Record<string, string[]>;
  /** The list is the exact set an overview number counts (`ids`). */
  fromOverview: boolean;
  clearHref: string;
  /** The register's filters for the download, without `ids`. */
  exportFilters: string;
  create: Omit<RiskFormProps, 'onClose' | 'clientId'> | null;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <div className="mb-3.5 flex flex-wrap items-start justify-between gap-3">
        <ExportButton
          clientId={clientId}
          kind="ISO_RISK_REGISTER_XLSX"
          filters={exportFilters}
          label="Download risk register (Excel)"
          note={
            fromOverview
              ? 'Exports the register with these filters, without the overview’s selection.'
              : undefined
          }
        />
        {create ? (
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add to the register
          </Button>
        ) : null}
      </div>
      <nav aria-label="Kinds" className="mb-3.5 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <NextLink
            key={t.label}
            href={t.href}
            prefetch={false}
            aria-current={t.current ? 'page' : undefined}
            className={`rounded-pill border px-3 py-1 text-body ${
              t.current
                ? 'border-forest bg-forest-soft text-forest'
                : 'border-line text-ink hover:bg-neutral-soft'
            }`}
          >
            {t.label}
          </NextLink>
        ))}
      </nav>
      {fromOverview ? (
        <p className="mb-3.5 text-body text-muted">
          Showing the items the ISO overview counted.{' '}
          <NextLink href={clearHref} prefetch={false} className="text-forest underline">
            Show the whole register
          </NextLink>
        </p>
      ) : null}
      <IsoFilterBar
        filters={filters}
        value={filterValue}
        resultText={`${rows.length} ${rows.length === 1 ? 'item' : 'items'}`}
        resultCount={rows.length}
        search={{ placeholder: 'Search activity or description' }}
      />
      <IsoTable
        label="Risk register"
        columns={columns}
        data={rows}
        rowId={(r) => r.id}
        rowLabel={(r) => r.title}
        rowHref={(r) => `/c/${clientId}/iso/risks/${r.id}`}
        countNoun={{ one: 'item', other: 'items' }}
        empty={
          <p className="p-6 text-body text-muted">
            Nothing matches. Clear a filter, or add the first item to the register.
          </p>
        }
      />
      {adding && create ? (
        <NewRisk clientId={clientId} {...create} kind={kind} onClose={() => setAdding(false)} />
      ) : null}
    </>
  );
}
