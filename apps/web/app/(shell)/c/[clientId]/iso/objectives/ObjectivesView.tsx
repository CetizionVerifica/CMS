'use client';
// Objectives (packages.md ISO-6b, model §3.6): what each aims at, its latest reading and whether it is on track, owner
// and due date. A row opens the objective's page with its readings and plan.
import type { IsoStandard, ObjectiveView } from '@canopy/contracts';
import { Button, type DataTableProps, type FilterDef } from '@canopy/ui';
import NextLink from 'next/link';
import { useState } from 'react';

import { IsoFilterBar } from '../_components/IsoFilterBar';
import { IsoPill } from '../_components/IsoStates';
import { IsoTable } from '../_components/IsoTable';
import { NewObjective, type ObjectiveFormProps } from './ObjectiveForm';
import type { PersonOption } from '../_lib/people';
import { objectiveRows, standing, type ObjectiveRow } from './objectives-words';

const columns: DataTableProps<ObjectiveRow>['columns'] = [
  {
    id: 'title',
    header: 'Objective',
    accessorFn: (r) => ({ title: r.title, sub: r.sub }) as never,
    meta: { type: 'title', locked: true },
    size: 360,
  },
  {
    id: 'target',
    header: 'Target',
    accessorFn: (r) => r.target as never,
    meta: { type: 'text' },
    size: 260,
  },
  {
    id: 'progress',
    header: 'Progress',
    accessorFn: (r) => r.progress as never,
    meta: { type: 'text' },
    size: 260,
  },
  {
    id: 'standing',
    header: 'Standing',
    accessorFn: (r) => standing(r.objective).text as never,
    cell: (ctx) => {
      const s = standing(ctx.row.original.objective);
      return <IsoPill tone={s.tone}>{s.text}</IsoPill>;
    },
    size: 140,
  },
  {
    id: 'owner',
    header: 'Owner',
    accessorFn: (r) => r.ownerName as never,
    meta: { type: 'text' },
    size: 160,
  },
];

export function ObjectivesView({
  clientId,
  objectives,
  standards,
  people,
  filters,
  filterValue,
  fromOverview,
  clearHref,
  create,
}: {
  clientId: string;
  objectives: ObjectiveView[];
  standards: IsoStandard[];
  people: PersonOption[];
  filters: FilterDef[];
  filterValue: Record<string, string[]>;
  fromOverview: boolean;
  clearHref: string;
  create: Omit<ObjectiveFormProps, 'onClose' | 'clientId'> | null;
}) {
  const [adding, setAdding] = useState(false);
  const rows = objectiveRows(objectives, standards, people);
  return (
    <>
      {create ? (
        <div className="mb-3.5 flex justify-end">
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add objective
          </Button>
        </div>
      ) : null}
      {fromOverview ? (
        <p className="mb-3.5 text-body text-muted">
          Showing the objectives the ISO overview counted.{' '}
          <NextLink href={clearHref} prefetch={false} className="text-forest underline">
            Show all objectives
          </NextLink>
        </p>
      ) : null}
      <IsoFilterBar
        filters={filters}
        value={filterValue}
        resultText={`${rows.length} ${rows.length === 1 ? 'objective' : 'objectives'}`}
        resultCount={rows.length}
        search={{ placeholder: 'Search objectives' }}
      />
      <IsoTable
        label="Objectives"
        columns={columns}
        data={rows}
        rowId={(r) => r.id}
        rowLabel={(r) => r.title}
        rowHref={(r) => `/c/${clientId}/iso/objectives/${r.id}`}
        countNoun={{ one: 'objective', other: 'objectives' }}
        empty={
          <p className="p-6 text-body text-muted">
            No objective matches. Clear a filter, or add the first objective.
          </p>
        }
      />
      {adding && create ? (
        <NewObjective clientId={clientId} {...create} onClose={() => setAdding(false)} />
      ) : null}
    </>
  );
}
