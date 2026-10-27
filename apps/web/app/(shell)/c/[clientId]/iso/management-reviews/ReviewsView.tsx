'use client';
// The management reviews of the client's systems (model §3.13): each with its standards, dates, state and chair, filtered
// by the API. A row opens the review's page, where it is prepared, held and closed.
import type { IsoStandard, ManagementReviewDue } from '@canopy/contracts';
import { Button, formatDate, type DataTableProps, type FilterDef } from '@canopy/ui';
import { useState } from 'react';

import { IsoFilterBar } from '../_components/IsoFilterBar';
import { StatePill } from '../_components/IsoStates';
import { IsoTable } from '../_components/IsoTable';
import { ReviewDue } from '../overview/OverviewView';
import type { ReviewRow } from './review-model';
import { PlanReview, type ReviewPlanProps } from './ReviewForms';

const columns: DataTableProps<ReviewRow>['columns'] = [
  {
    id: 'title',
    header: 'Review',
    accessorFn: (r) => ({ title: r.title, sub: r.sub }) as never,
    meta: { type: 'title', locked: true },
    size: 400,
  },
  {
    id: 'planned',
    header: 'Planned for',
    accessorFn: (r) => formatDate(r.review.plannedOn) as never,
    meta: { type: 'text' },
    size: 150,
  },
  {
    id: 'held',
    header: 'Held on',
    accessorFn: (r) => (r.review.heldOn ? formatDate(r.review.heldOn) : 'Not yet') as never,
    meta: { type: 'text' },
    size: 150,
  },
  {
    id: 'state',
    header: 'State',
    accessorFn: (r) => r.review.state as never,
    cell: (ctx) => <StatePill of="ManagementReviewState" value={ctx.row.original.review.state} />,
    size: 130,
  },
  {
    id: 'chair',
    header: 'Chair',
    accessorFn: (r) => r.chairName as never,
    meta: { type: 'text' },
    size: 170,
  },
];

export function ReviewsView({
  clientId,
  due,
  standards,
  rows,
  filters,
  filterValue,
  plan,
}: {
  clientId: string;
  /** When each system's next review is due, by standard; the system's name when the client has more than one. */
  due: { systemId: string; systemName: string | null; due: ManagementReviewDue }[];
  standards: IsoStandard[];
  rows: ReviewRow[];
  filters: FilterDef[];
  filterValue: Record<string, string[]>;
  plan: ReviewPlanProps | null;
}) {
  const [planning, setPlanning] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      {due.length > 0 ? (
        <section
          aria-labelledby="reviews-due"
          className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4"
        >
          <h2 id="reviews-due" className="text-card text-ink">
            Next review due
          </h2>
          {due.map((d) => (
            <div key={d.systemId} className="flex flex-col gap-2">
              {d.systemName ? (
                <h3 className="text-body font-semibold text-ink">{d.systemName}</h3>
              ) : null}
              <ReviewDue due={d.due} standards={standards} />
            </div>
          ))}
        </section>
      ) : null}
      <section aria-labelledby="reviews" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="reviews" className="text-section text-ink">
            Reviews
          </h2>
          {plan ? (
            <Button variant="primary" onClick={() => setPlanning(true)}>
              Plan a management review
            </Button>
          ) : null}
        </div>
        <IsoFilterBar
          filters={filters}
          value={filterValue}
          resultText={`${rows.length} ${rows.length === 1 ? 'review' : 'reviews'}`}
          resultCount={rows.length}
        />
        <IsoTable
          label="Management reviews"
          columns={columns}
          data={rows}
          rowId={(r) => r.id}
          rowLabel={(r) => r.title}
          rowHref={(r) => `/c/${clientId}/iso/management-reviews/${r.id}`}
          countNoun={{ one: 'review', other: 'reviews' }}
          empty={
            <p className="p-6 text-body text-muted">
              Nothing matches. Clear a filter, or plan the first review.
            </p>
          }
        />
        {planning && plan ? <PlanReview {...plan} onClose={() => setPlanning(false)} /> : null}
      </section>
    </div>
  );
}
