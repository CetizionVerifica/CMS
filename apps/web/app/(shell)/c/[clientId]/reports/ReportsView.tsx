'use client';
// The reports page: scores by Act and by department, the overdue list and the downloads. Client Component because
// DataTable handles the keyboard in the browser and a download polls its export until the file is ready.
import {
  Button,
  DataTable,
  formatDate,
  formatNumber,
  formatPercent,
  type DataTableProps,
} from '@canopy/ui';
import NextLink from 'next/link';
import { useState, type ReactNode } from 'react';

import { exportProgressAction, startExportAction } from './actions';
import { DOWNLOADS, type OverdueRow, type ReportCount, type ReportRow } from './reports-model';

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

const percent = (value: number | null) =>
  value === null ? (
    <span className="text-muted">No items due</span>
  ) : (
    <span className="tabular">{formatPercent(value)}</span>
  );

function count(label: (row: ReportRow) => string, pick: (row: ReportRow) => ReportCount) {
  return ({ row }: { row: { original: ReportRow } }) => {
    const { value, href } = pick(row.original);
    if (value === 0) return <span className="tabular text-muted">0</span>;
    return (
      <NextLink
        href={href}
        className="tabular text-forest underline-offset-2 hover:underline focus-visible:underline"
        aria-label={`${formatNumber(value)} ${label(row.original)}`}
      >
        {formatNumber(value)}
      </NextLink>
    );
  };
}

function reportColumns(noun: string): DataTableProps<ReportRow>['columns'] {
  return [
    {
      id: 'name',
      header: noun,
      accessorFn: (row) => row.name as never,
      meta: { type: 'title', locked: true },
    },
    {
      id: 'score',
      header: 'Score',
      accessorFn: (row) => (row.score ?? -1) as never,
      meta: { type: 'number' },
      cell: ({ row }) => percent(row.original.score),
    },
    {
      id: 'onTime',
      header: 'On time',
      accessorFn: (row) => (row.onTimeRate ?? -1) as never,
      meta: { type: 'number' },
      cell: ({ row }) => percent(row.original.onTimeRate),
    },
    {
      id: 'complied',
      header: 'Complied',
      accessorFn: (row) => row.complied.value as never,
      meta: { type: 'number' },
      cell: count(
        (r) => `complied under ${r.name}`,
        (r) => r.complied,
      ),
    },
    {
      id: 'overdue',
      header: 'Overdue',
      accessorFn: (row) => row.overdue.value as never,
      meta: { type: 'number' },
      cell: count(
        (r) => `overdue under ${r.name}`,
        (r) => r.overdue,
      ),
    },
    {
      id: 'open',
      header: 'Still open',
      accessorFn: (row) => row.open.value as never,
      meta: { type: 'number' },
      cell: count(
        (r) => `still open under ${r.name}`,
        (r) => r.open,
      ),
    },
    {
      id: 'na',
      header: 'Not applicable',
      accessorFn: (row) => row.notApplicable.value as never,
      meta: { type: 'number' },
      cell: count(
        (r) => `not applicable under ${r.name}`,
        (r) => r.notApplicable,
      ),
    },
  ];
}

const ACT_COLUMNS = reportColumns('Act');
const DEPARTMENT_COLUMNS = reportColumns('Department');

const OVERDUE_COLUMNS: DataTableProps<OverdueRow>['columns'] = [
  {
    id: 'title',
    header: 'Obligation',
    accessorFn: (row) => row.title as never,
    meta: { type: 'title', locked: true },
  },
  {
    id: 'days',
    header: 'Days overdue',
    accessorFn: (row) => row.days as never,
    meta: { type: 'number' },
    cell: ({ row }) => (
      <span className="tabular font-semibold text-crit-ink">{formatNumber(row.original.days)}</span>
    ),
  },
  {
    id: 'due',
    header: 'Due',
    accessorFn: (row) => row.dueDate as never,
    meta: { type: 'text' },
    cell: ({ row }) => <span className="tabular">{formatDate(row.original.dueDate)}</span>,
  },
  { id: 'act', header: 'Act', accessorFn: (row) => row.act as never, meta: { type: 'text' } },
  { id: 'unit', header: 'Unit', accessorFn: (row) => row.unit as never, meta: { type: 'text' } },
  {
    id: 'department',
    header: 'Department',
    accessorFn: (row) => row.department as never,
    meta: { type: 'text' },
  },
  { id: 'owner', header: 'Owner', accessorFn: (row) => row.owner as never, meta: { type: 'text' } },
];

const POLL_TRIES = 20;
const POLL_MS = 1500;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function Downloads({ clientId, fy }: { clientId: string; fy: string | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const download = async (kind: string, label: string) => {
    if (busy) return;
    setBusy(kind);
    setMessage({ tone: 'info', text: `Preparing the ${label}…` });
    try {
      const started = await startExportAction(clientId, kind, fy);
      if (!started.ok) {
        setMessage({ tone: 'error', text: started.message });
        return;
      }
      for (let i = 0; i < POLL_TRIES; i++) {
        const progress = await exportProgressAction(started.id);
        if (progress.status === 'ready') {
          setMessage({ tone: 'info', text: `The ${label} is downloading.` });
          window.location.assign(progress.url);
          return;
        }
        if (progress.status === 'failed') {
          setMessage({ tone: 'error', text: progress.message });
          return;
        }
        await wait(POLL_MS);
      }
      setMessage({
        tone: 'error',
        text: 'The download is taking too long. Try again in a few minutes.',
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="downloads-heading" className="flex flex-col gap-3">
      <h2 id="downloads-heading" className="text-h2 font-semibold">
        Downloads
      </h2>
      <p className="text-body text-muted">
        {fy
          ? `Each download covers the whole financial year ${fy}.`
          : 'Each download covers the current financial year.'}
      </p>
      <ul className="flex flex-col gap-2">
        {DOWNLOADS.map(({ kind, label, description }) => (
          <li
            key={kind}
            className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line p-3"
          >
            <div>
              <p className="text-body font-semibold">{label}</p>
              <p className="text-meta text-muted">{description}</p>
            </div>
            <Button
              variant="secondary"
              onClick={() => void download(kind, label.replace(/ \(.*\)$/, '').toLowerCase())}
              loading={busy === kind}
              disabledReason={
                busy !== null && busy !== kind ? 'Another download is being prepared' : undefined
              }
              aria-label={`Download the ${label}`}
            >
              Download
            </Button>
          </li>
        ))}
      </ul>
      {/* Two fixed live regions, so a screen reader hears progress politely and a refusal at once. */}
      <p role="status" className="text-body text-muted">
        {message?.tone === 'info' ? message.text : ''}
      </p>
      <p role="alert" className="text-body text-crit-ink">
        {message?.tone === 'error' ? message.text : ''}
      </p>
    </section>
  );
}

export function ReportsView({
  clientId,
  fy,
  acts,
  departments,
  overdue,
}: {
  clientId: string;
  fy: string | null;
  acts: ReportRow[];
  departments: ReportRow[];
  overdue: OverdueRow[];
}) {
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="acts-heading" className="flex flex-col gap-3">
        <h2 id="acts-heading" className="text-h2 font-semibold">
          By Act
        </h2>
        <DataTable
          label="Scores by Act"
          toolbar={false}
          columns={ACT_COLUMNS}
          data={acts}
          rowId={(row) => row.id}
          rowLabel={(row) => row.name}
          rowHref={(row) => row.href}
          renderLink={renderLink}
          empty={<p className="p-4 text-body text-muted">No Acts have items in this period.</p>}
          countNoun={{ one: 'Act', other: 'Acts' }}
        />
      </section>
      <section aria-labelledby="departments-heading" className="flex flex-col gap-3">
        <h2 id="departments-heading" className="text-h2 font-semibold">
          By department
        </h2>
        <DataTable
          label="Scores by department"
          toolbar={false}
          columns={DEPARTMENT_COLUMNS}
          data={departments}
          rowId={(row) => row.id}
          rowLabel={(row) => row.name}
          rowHref={(row) => row.href}
          renderLink={renderLink}
          empty={
            <p className="p-4 text-body text-muted">No departments have items in this period.</p>
          }
          countNoun={{ one: 'department', other: 'departments' }}
        />
      </section>
      <section aria-labelledby="overdue-heading" className="flex flex-col gap-3">
        <h2 id="overdue-heading" className="text-h2 font-semibold">
          Overdue
        </h2>
        <DataTable
          label="Overdue instances"
          toolbar={false}
          columns={OVERDUE_COLUMNS}
          data={overdue}
          rowId={(row) => row.id}
          rowLabel={(row) => row.title}
          rowHref={(row) => row.href}
          renderLink={renderLink}
          empty={<p className="p-4 text-body text-muted">Nothing is overdue in this period.</p>}
          countNoun={{ one: 'instance', other: 'instances' }}
        />
      </section>
      <Downloads clientId={clientId} fy={fy} />
    </div>
  );
}
