'use client';
// Controlled documents (packages.md ISO-6a, model §3.4): code, title, type, the revision in force, owner and review
// timing. A row opens the document's own page with its revisions and steps.
import type { ManagementSystem } from '@canopy/contracts';
import { Button, type DataTableProps, type FilterDef } from '@canopy/ui';
import NextLink from 'next/link';
import { useState } from 'react';

import type { PersonOption } from '../_lib/people';
import type { ClauseOption } from '../_components/ClausePicker';
import { IsoFilterBar } from '../_components/IsoFilterBar';
import { StatePill, TimingPill } from '../_components/IsoStates';
import { IsoTable } from '../_components/IsoTable';
import type { DocumentRow } from './documents-model';
import { NewDocument } from './DocumentForm';

const columns: DataTableProps<DocumentRow>['columns'] = [
  {
    id: 'code',
    header: 'Code',
    accessorFn: (r) => r.code as never,
    meta: { type: 'text' },
    size: 120,
  },
  {
    id: 'title',
    header: 'Document',
    accessorFn: (r) => ({ title: r.title, sub: r.type }) as never,
    meta: { type: 'title', locked: true },
    size: 340,
  },
  {
    id: 'revision',
    header: 'In force',
    accessorFn: (r) => r.revision as never,
    meta: { type: 'text' },
    size: 140,
  },
  {
    id: 'owner',
    header: 'Owner',
    accessorFn: (r) => r.ownerName as never,
    meta: { type: 'text' },
    size: 170,
  },
  {
    id: 'review',
    header: 'Review',
    accessorFn: (r) => (r.doc.reviewDueOn ?? '') as never,
    cell: (ctx) => {
      const d = ctx.row.original.doc;
      if (d.status === 'OBSOLETE') return <StatePill of="DocumentStatus" value="OBSOLETE" />;
      return d.reviewDueOn ? (
        <TimingPill status={d.reviewStatus} />
      ) : (
        <span className="text-muted">No date set</span>
      );
    },
    size: 170,
  },
];

export function DocumentsView({
  clientId,
  rows,
  filters,
  filterValue,
  fromOverview,
  clearHref,
  create,
}: {
  clientId: string;
  rows: DocumentRow[];
  filters: FilterDef[];
  filterValue: Record<string, string[]>;
  /** The list is the exact set an overview number counts. */
  fromOverview: boolean;
  clearHref: string;
  create: {
    systems: Pick<ManagementSystem, 'id' | 'name'>[];
    clauseOptions: Record<string, ClauseOption[]>;
    people: PersonOption[];
    ownerOnly: string | null;
    today: string;
  } | null;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      {create ? (
        <div className="mb-3.5 flex justify-end">
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add document
          </Button>
        </div>
      ) : null}
      {fromOverview ? (
        <p className="mb-3.5 text-body text-muted">
          Showing the documents the ISO overview counted.{' '}
          <NextLink href={clearHref} prefetch={false} className="text-forest underline">
            Show all documents
          </NextLink>
        </p>
      ) : null}
      <IsoFilterBar
        filters={filters}
        value={filterValue}
        resultText={`${rows.length} ${rows.length === 1 ? 'document' : 'documents'}`}
        resultCount={rows.length}
        search={{ placeholder: 'Search code or title' }}
      />
      <IsoTable
        label="Documents"
        columns={columns}
        data={rows}
        rowId={(r) => r.id}
        rowLabel={(r) => `${r.code}, ${r.title}`}
        rowHref={(r) => `/c/${clientId}/iso/documents/${r.id}`}
        countNoun={{ one: 'document', other: 'documents' }}
        empty={
          <p className="p-6 text-body text-muted">
            No document matches. Clear a filter, or add the client&apos;s first controlled document.
          </p>
        }
      />
      {adding && create ? (
        <NewDocument clientId={clientId} {...create} onClose={() => setAdding(false)} />
      ) : null}
    </>
  );
}
