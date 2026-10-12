import { createColumnHelper } from '@tanstack/react-table';

import {
  DataTable,
  DeadlineList,
  KpiCard,
  ProgressBar,
  ScoreRing,
  TaskList,
  type DeadlineItem,
  type StatusValue,
  type TaskItem,
  type TitleValue,
} from '../../src';

/*
 * The Canopy overview composed only from @canopy/ui components (spec/README.md "Acceptance demo").
 * Numbers follow the golden fixture: 424 instances, 211 complied, 201 pending, 12 not applicable.
 * In the app every number comes from the API, and each card links to the register filtered to exactly those rows.
 */

type DepartmentRow = {
  id: string;
  department: TitleValue;
  readiness: number;
  complied: number;
  overdue: number;
  status: StatusValue;
};

const departments: DepartmentRow[] = [
  {
    id: 'hr',
    department: { title: 'Human resources', sub: '118 instances' },
    readiness: 58,
    complied: 66,
    overdue: 2,
    status: { status: 'OVERDUE', days: 6 },
  },
  {
    id: 'ehs',
    department: { title: 'EHS', sub: '96 instances' },
    readiness: 41,
    complied: 37,
    overdue: 2,
    status: { status: 'OVERDUE', days: 2 },
  },
  {
    id: 'fin',
    department: { title: 'Finance and tax', sub: '84 instances' },
    readiness: 55,
    complied: 45,
    overdue: 1,
    status: { status: 'OVERDUE', days: 1 },
  },
  {
    id: 'admin',
    department: { title: 'Administration', sub: '62 instances' },
    readiness: 49,
    complied: 29,
    overdue: 0,
    status: { status: 'DUE_SOON', days: 3 },
  },
  {
    id: 'it',
    department: { title: 'IT', sub: '64 instances' },
    readiness: 53,
    complied: 34,
    overdue: 0,
    status: { status: 'UPCOMING' },
  },
];

const col = createColumnHelper<DepartmentRow>();
const columns = [
  col.accessor('department', {
    header: 'Department',
    size: 150,
    meta: { type: 'title', locked: true },
  }),
  col.accessor('readiness', {
    header: 'Readiness',
    size: 140,
    meta: { type: 'progress', label: 'Readiness' },
  }),
  col.accessor('complied', { header: 'Complied', size: 112, meta: { type: 'number' } }),
  col.accessor('overdue', { header: 'Overdue', size: 106, meta: { type: 'number' } }),
  col.accessor('status', {
    header: 'Most urgent',
    size: 140,
    enableSorting: false,
    meta: { type: 'status' },
  }),
];

const acts = [
  { name: 'Factories Act, 1948', ok: 52, warn: 14, crit: 2, na: 4 },
  { name: 'EPF and MP Act, 1952', ok: 36, warn: 22, crit: 1, na: 0 },
  { name: 'Income Tax Act, 1961', ok: 30, warn: 26, crit: 1, na: 2 },
  { name: 'Water Act, 1974', ok: 18, warn: 21, crit: 1, na: 3 },
  { name: 'ESI Act, 1948', ok: 24, warn: 16, crit: 0, na: 0 },
  { name: 'Contract Labour Act, 1970', ok: 15, warn: 19, crit: 0, na: 1 },
];

const upcoming: DeadlineItem[] = [
  {
    id: 'i-104',
    dueDate: '2022-12-08',
    title: 'Fire safety drill record',
    meta: 'EHS · Ravi Kumar',
    status: 'OVERDUE',
    days: 2,
    href: '#/shell/register',
  },
  {
    id: 'i-101',
    dueDate: '2022-12-10',
    title: 'Monthly PF challan',
    meta: 'Human resources · Priya Rane',
    status: 'DUE_SOON',
    days: 0,
    href: '#/shell/register',
  },
  {
    id: 'i-102',
    dueDate: '2022-12-12',
    title: 'ESI contribution',
    meta: 'Human resources · Arun Mehta',
    status: 'DUE_SOON',
    days: 2,
    href: '#/shell/register',
  },
  {
    id: 'i-103',
    dueDate: '2022-12-15',
    title: 'TDS return (24Q)',
    meta: 'Finance and tax · Kavya Iyer',
    status: 'UPCOMING',
    href: '#/shell/register',
  },
  {
    id: 'i-105',
    dueDate: '2022-12-20',
    title: 'Consent to operate renewal',
    meta: 'EHS · Ravi Kumar',
    status: 'UPCOMING',
    href: '#/shell/register',
  },
  {
    id: 'i-106',
    dueDate: '2022-12-31',
    title: 'Half-yearly return of contract labour',
    meta: 'Administration · Priya Rane',
    status: 'UPCOMING',
    href: '#/shell/register',
  },
];

const mine: TaskItem[] = [
  {
    id: 'i-104',
    title: 'Fire safety drill record',
    meta: 'Factories Act',
    dueDate: '2022-12-08',
    status: 'OVERDUE',
    days: 2,
    href: '#/shell/register',
  },
  {
    id: 'i-108',
    title: 'Half-yearly return of contract labour',
    meta: 'CLRA',
    dueDate: '2022-12-11',
    status: 'SENT_BACK',
    href: '#/shell/register',
  },
  {
    id: 'i-101',
    title: 'Monthly PF challan',
    meta: 'EPF Act',
    dueDate: '2022-12-10',
    status: 'SUBMITTED',
    href: '#/shell/register',
  },
  {
    id: 'i-103',
    title: 'TDS return (24Q)',
    meta: 'Income Tax Act',
    dueDate: '2022-12-15',
    status: 'UPCOMING',
    href: '#/shell/register',
  },
  {
    id: 'i-109',
    title: 'Register of wages (Form B)',
    meta: 'Wage Code',
    dueDate: '2022-12-18',
    status: 'UPCOMING',
    href: '#/shell/register',
  },
  {
    id: 'i-110',
    title: 'Labour welfare fund',
    meta: 'LWF Act',
    dueDate: '2022-12-31',
    status: 'UPCOMING',
    href: '#/shell/register',
  },
];

export function OverviewContent({ approvals }: { approvals: number }) {
  const register = (filter: string) => `#/shell/register?${filter}`;
  return (
    <div className="flex flex-col gap-3.5">
      <div>
        <h1 className="text-page text-ink">Overview</h1>
        <p className="mt-1 text-body text-muted">5 items are overdue, 2 are super critical.</p>
      </div>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Compliance score"
          value={51}
          unit="%"
          visual={<ScoreRing value={51} size="md" label="Compliance score" />}
          context={{ text: '211 of 412 applicable complied', tone: 'neutral' }}
          href={register('status=complied')}
          linkHint="Open the complied instances"
        />
        <KpiCard
          label="Open"
          value={201}
          context={{ text: '18 due in the next 7 days', tone: 'warn' }}
          href={register('status=open')}
          linkHint="Open the open instances"
        />
        <KpiCard
          label="Overdue"
          value={5}
          context={{ text: '2 super critical', tone: 'crit', trend: 'up' }}
          href={register('status=overdue')}
          linkHint="Open the overdue instances"
        />
        <KpiCard
          label="Awaiting approval"
          value={approvals}
          context={{ text: 'Oldest waiting 3 days', tone: 'neutral' }}
          href="#/shell/approvals"
          linkHint="Open the approvals inbox"
        />
      </div>

      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-labelledby="readiness-heading" className="flex min-w-0 flex-col gap-2">
          <h2 id="readiness-heading" className="text-card text-ink">
            Readiness by department
          </h2>
          <DataTable<DepartmentRow>
            label="Readiness by department"
            toolbar={false}
            columns={columns}
            data={departments}
            rowId={(r) => r.id}
            rowLabel={(r) => (typeof r.department === 'string' ? r.department : r.department.title)}
            rowHref={(r) => register(`department=${r.id}`)}
            maxHeight={320}
          />
        </section>
        <DeadlineList items={upcoming} viewAllHref="#/shell/calendar" />
      </div>

      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
          <h2 className="text-card text-ink">Status by Act</h2>
          {acts.map((a) => (
            <ProgressBar
              key={a.name}
              variant="stacked"
              label={a.name}
              showLabel
              segments={[
                { key: 'ok', label: 'Complied', count: a.ok },
                { key: 'warn', label: 'Pending', count: a.warn },
                { key: 'crit', label: 'Overdue', count: a.crit },
                { key: 'neutral', label: 'Not applicable', count: a.na },
              ]}
            />
          ))}
        </section>
        <section className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
          <h2 className="text-card text-ink">My open items</h2>
          <TaskList
            label="My open items"
            items={mine}
            max={5}
            viewAllHref="#/shell/register?owner=me"
          />
        </section>
      </div>
    </div>
  );
}
