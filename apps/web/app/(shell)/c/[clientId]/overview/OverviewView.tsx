'use client';
// The client overview (apps/web/CLAUDE.md "Overview"): greeting, KPI cards, readiness by department, upcoming
// deadlines, status by Act and "My open items". Composed only from @canopy/ui; every number is a link to the register
// filtered to exactly its rows. Client Component because DataTable sorts and handles the keyboard in the browser.
import {
  DataTable,
  DeadlineList,
  formatNumber,
  KpiCard,
  ProgressBar,
  ScoreRing,
  TaskList,
  type DataTableProps,
} from '@canopy/ui';
import NextLink from 'next/link';
import type { ReactNode } from 'react';

import type { ActSegment, DepartmentRow, KpiDetail, OverviewModel } from './overview-model';

const renderLink = ({
  href,
  children,
  ...rest
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) => (
  <NextLink href={href} {...rest}>
    {children}
  </NextLink>
);

// The legend swatches match @canopy/ui's stacked ProgressBar fills (tokens only).
const swatch: Record<ActSegment['key'], string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  crit: 'bg-crit',
  neutral: 'bg-neutral-soft shadow-[inset_0_0_0_1px_var(--line-strong)]',
};

const detailTone: Record<KpiDetail['tone'], string> = {
  ok: 'text-ok-ink',
  warn: 'text-warn-ink',
  crit: 'text-crit-ink',
  neutral: 'text-muted',
};

/** A count as a link to its rows; 0 stays plain text, since an empty register teaches nothing. */
function CountLink({
  count,
  href,
  label,
  className,
}: {
  count: number;
  href: string;
  label: string;
  className?: string;
}) {
  if (count === 0) return <span className="tabular text-muted">0</span>;
  return (
    <NextLink
      href={href}
      aria-label={label}
      className={`tabular underline-offset-2 hover:underline focus-visible:underline ${className ?? 'text-ink'}`}
    >
      {formatNumber(count)}
    </NextLink>
  );
}

const departmentColumns: DataTableProps<DepartmentRow>['columns'] = [
  {
    id: 'department',
    header: 'Department',
    accessorFn: (row) => row.name as never,
    meta: { type: 'title', locked: true },
  },
  {
    id: 'overdue',
    header: 'Overdue',
    accessorFn: (row) => row.overdue as never,
    meta: { type: 'number' },
    cell: ({ row }) => {
      const { overdue, overdueHref, name } = row.original;
      return (
        <CountLink
          count={overdue}
          href={overdueHref}
          label={`${formatNumber(overdue)} overdue in ${name}, open these instances`}
          className="font-semibold text-crit-ink"
        />
      );
    },
  },
  {
    id: 'readiness',
    header: 'Readiness',
    accessorFn: (row) => (row.score ?? -1) as never,
    cell: ({ row }) => {
      const { score, name } = row.original;
      return score === null ? (
        <span className="text-muted">No items due</span>
      ) : (
        <ProgressBar value={score} label={`${name} readiness`} width="table" showValue />
      );
    },
  },
  {
    id: 'complied',
    header: 'Complied',
    accessorFn: (row) => row.complied as never,
    meta: { type: 'number' },
    cell: ({ row }) => {
      const { complied, compliedHref, name } = row.original;
      return (
        <CountLink
          count={complied}
          href={compliedHref}
          label={`${formatNumber(complied)} complied in ${name}, open these instances`}
        />
      );
    },
  },
];

export function OverviewView({ model }: { model: OverviewModel }) {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {model.kpis.map((kpi) => (
          <div key={kpi.label} className="flex min-w-0 flex-col gap-1">
            <KpiCard
              label={kpi.label}
              value={kpi.value}
              unit={kpi.unit}
              context={kpi.context}
              visual={
                kpi.score === undefined ? undefined : (
                  <ScoreRing value={kpi.score} size="md" label={kpi.label} />
                )
              }
              href={kpi.href}
              linkHint={kpi.linkHint}
              renderLink={renderLink}
            />
            {kpi.detail ? (
              <NextLink
                href={kpi.detail.href}
                aria-label={kpi.detail.label}
                className={`inline-flex min-h-6 items-center self-start px-1 text-meta tabular underline underline-offset-2 ${detailTone[kpi.detail.tone]}`}
              >
                {kpi.detail.text}
              </NextLink>
            ) : null}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-labelledby="readiness-heading" className="flex min-w-0 flex-col gap-2">
          <h2 id="readiness-heading" className="text-card text-ink">
            Readiness by department
          </h2>
          {model.departments.length === 0 ? (
            <p className="rounded-card border border-line bg-surface p-4 text-body text-muted">
              No departments have items in this period.
            </p>
          ) : (
            <DataTable
              label="Readiness by department"
              toolbar={false}
              columns={departmentColumns}
              data={model.departments}
              rowId={(row) => row.id}
              rowLabel={(row) => row.name}
              rowHref={(row) => row.href}
              renderLink={renderLink}
              countNoun={{ one: 'department', other: 'departments' }}
              maxHeight={320}
            />
          )}
        </section>
        <DeadlineList
          title="Upcoming deadlines"
          items={model.upcoming}
          groupBy="week"
          today={model.today}
          viewAllHref={model.calendarHref}
          viewAllLabel="Open the calendar"
          renderLink={renderLink}
        />
      </div>

      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2">
        <section
          aria-labelledby="acts-heading"
          className="flex min-w-0 flex-col gap-3 rounded-card border border-line bg-surface p-4"
        >
          <h2 id="acts-heading" className="text-card text-ink">
            Status by Act
          </h2>
          {model.acts.length === 0 ? (
            <p className="text-body text-muted">No Acts have items in this period.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {model.acts.map((act) => (
                <li key={act.id} className="flex flex-col gap-1">
                  <NextLink
                    href={act.href}
                    className="self-start text-body text-ink underline-offset-2 hover:underline focus-visible:underline"
                  >
                    {act.name}
                  </NextLink>
                  <ProgressBar
                    variant="stacked"
                    label={act.name}
                    segments={act.segments}
                    legend="none"
                  />
                  <ul className="flex flex-wrap gap-x-3 gap-y-1">
                    {act.segments.map((segment) => (
                      <li
                        key={segment.key}
                        className="inline-flex min-h-6 items-center gap-1.5 text-meta text-muted"
                      >
                        <span
                          aria-hidden
                          className={`size-[9px] rounded-[2px] ${swatch[segment.key]}`}
                        />
                        {segment.label}{' '}
                        <CountLink
                          count={segment.count}
                          href={segment.href}
                          label={`${formatNumber(segment.count)} ${segment.label.toLowerCase()} under ${act.name}, open these instances`}
                        />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section
          aria-labelledby="mine-heading"
          className="flex min-w-0 flex-col gap-2 rounded-card border border-line bg-surface p-4"
        >
          <h2 id="mine-heading" className="text-card text-ink">
            My open items
          </h2>
          {model.myTasks.length === 0 ? (
            <p className="text-body text-muted">Nothing is waiting on you.</p>
          ) : (
            <TaskList
              label="My open items"
              items={model.myTasks}
              max={5}
              viewAllHref={model.myItemsHref}
              renderLink={renderLink}
            />
          )}
        </section>
      </div>
    </div>
  );
}
