import { createColumnHelper, sortingFns, type SortingFn } from '@tanstack/react-table';
import { CheckCheck, Download, MoreHorizontal, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  Button,
  ConfirmDialog,
  CriticalityTag,
  DataTable,
  Drawer,
  DrawerSection,
  FilterBar,
  EmptyState,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  RadioGroup,
  StatusPill,
  formatDate,
  toast,
  Toaster,
  type Criticality,
  type TableContext,
  type DerivedStatus,
  type FilterDef,
  type FilterValue,
  type SavedView,
} from '../../src';
import { Page, Section } from '../Page';
import { useRoute } from '../router';

type Instance = {
  id: string;
  title: string;
  act: string;
  department: string;
  owner: { name: string } | null;
  approver: { name: string } | null;
  due: string;
  status: DerivedStatus;
  days?: number;
  criticality: Criticality;
};

const acts = [
  'Income Tax Act, 1961',
  'Factories Act, 1948',
  'Employees’ Provident Funds Act, 1952',
  'Water (Prevention and Control of Pollution) Act, 1974',
  'Information Technology Act, 2000',
];
const titles = [
  'Tax collection at source return',
  'Annual return in Form 1',
  'Monthly PF challan',
  'Consent to operate renewal',
  'Half-yearly compliance report',
  'Fire safety audit',
];
const departments = ['Finance', 'EHS', 'HR', 'Legal', 'IT'];
const people = ['Priya Rane', 'Arjun Mehta', 'Kavita Iyer', 'Rohan Das', 'Meera Pillai'];
const statuses: DerivedStatus[] = [
  'OVERDUE',
  'DUE_SOON',
  'UPCOMING',
  'SUBMITTED',
  'SENT_BACK',
  'COMPLIED',
  'COMPLIED_LATE',
  'NOT_APPLICABLE',
];
const levels: Criticality[] = ['SUPER_CRITICAL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/** Deterministic demo rows (no randomness, so screenshots and tests are stable). */
function makeInstances(n: number): Instance[] {
  return Array.from({ length: n }, (_, i) => {
    const prefix = ['TAX', 'FAC', 'PF', 'ENV', 'IT'][i % 5]!;
    const month = String((i % 12) + 1).padStart(2, '0');
    const day = String((i % 28) + 1).padStart(2, '0');
    return {
      id: `${prefix}-CL-${String(i + 1).padStart(5, '0')}`,
      title: titles[i % titles.length]!,
      act: acts[i % acts.length]!,
      department: departments[i % departments.length]!,
      owner: i % 7 === 0 ? null : { name: people[i % people.length]! },
      approver: { name: people[(i + 2) % people.length]! },
      due: `2027-${month}-${day}`,
      status: statuses[i % statuses.length]!,
      days: (i % 30) + 1,
      criticality: levels[i % levels.length]!,
    };
  });
}

/**
 * The sort TanStack picks for date strings, counting its comparisons on `window` so the e2e suite can check that sorting
 * 10,000 rows stays n log n whatever the runner's load.
 */
const countedSort: SortingFn<Instance> = (a, b, id) => {
  const w = window as Window & { dueDateComparisons?: number };
  w.dueDateComparisons = (w.dueDateComparisons ?? 0) + 1;
  return sortingFns.alphanumeric(a, b, id);
};

const col = createColumnHelper<Instance>();
const columns = [
  col.accessor('id', { header: 'ID', size: 130, meta: { type: 'id' } }),
  col.accessor((r) => ({ title: r.title, sub: r.act }), {
    id: 'title',
    header: 'Title',
    size: 300,
    meta: { type: 'title', locked: true },
    sortingFn: (a, b) => a.original.title.localeCompare(b.original.title),
  }),
  col.accessor('department', { header: 'Department', size: 130, meta: { type: 'text' } }),
  col.accessor('owner', {
    header: 'Owner',
    size: 170,
    meta: { type: 'person' },
    enableSorting: false,
  }),
  col.accessor('approver', {
    header: 'Approver',
    size: 170,
    meta: { type: 'person' },
    enableSorting: false,
  }),
  col.accessor('due', {
    header: 'Due date',
    size: 130,
    meta: { type: 'date' },
    sortingFn: countedSort,
  }),
  col.accessor((r) => ({ status: r.status, days: r.days }), {
    id: 'status',
    header: 'Status',
    size: 170,
    meta: { type: 'status' },
    enableSorting: false,
  }),
  col.accessor('criticality', {
    header: 'Criticality',
    size: 140,
    meta: { type: 'criticality' },
    sortingFn: (a, b) =>
      levels.indexOf(a.original.criticality) - levels.indexOf(b.original.criticality),
  }),
  col.display({
    id: 'actions',
    header: 'Actions',
    size: 64,
    meta: { type: 'actions' },
    cell: ({ row, table }) => (
      <Menu>
        <MenuTrigger asChild>
          <IconButton
            label={`Actions for ${row.original.id}`}
            icon={MoreHorizontal}
            variant="ghost"
            size="sm"
            tabIndex={(table.options.meta as TableContext<Instance>).rowTabIndex(row)}
            hideTooltip
          />
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem
            onSelect={() => toast({ tone: 'info', message: `Reassign ${row.original.id}` })}
          >
            Reassign
          </MenuItem>
        </MenuContent>
      </Menu>
    ),
  }),
];

const count = (key: keyof Instance, value: string, rows: Instance[]) =>
  rows.filter((r) => r[key] === value).length;

const demoRows = makeInstances(10_000);
const filterDefs: FilterDef[] = [
  {
    key: 'status',
    label: 'Status',
    kind: 'multi',
    display: 'status',
    options: statuses.map((s) => ({ value: s, label: s, count: count('status', s, demoRows) })),
  },
  {
    key: 'criticality',
    label: 'Criticality',
    kind: 'multi',
    display: 'criticality',
    options: levels.map((l) => ({ value: l, label: l, count: count('criticality', l, demoRows) })),
  },
  {
    key: 'department',
    label: 'Department',
    kind: 'multi',
    order: 'alpha',
    options: departments.map((d) => ({
      value: d,
      label: d,
      count: count('department', d, demoRows),
    })),
  },
  {
    key: 'due',
    label: 'Due date',
    kind: 'dateRange',
    presets: [
      { value: 'overdue', label: 'Overdue', range: { to: '2027-03-09' } },
      { value: 'week', label: 'This week', range: { from: '2027-03-08', to: '2027-03-14' } },
      { value: 'next30', label: 'Next 30 days', range: { from: '2027-03-10', to: '2027-04-08' } },
    ],
  },
];

type Mode = 'data' | 'loading' | 'refetching' | 'error' | 'empty';

/** What a saved view stores in this demo: the filter bar and search. The app also stores sort, columns and density. */
type ViewState = { filters: Record<string, FilterValue>; query: string };
const DEFAULT_STATE: ViewState = { filters: {}, query: '' };
const sameState = (a: ViewState, b: ViewState) => JSON.stringify(a) === JSON.stringify(b);

function useSavedViews(state: ViewState, apply: (s: ViewState) => void) {
  const [views, setViews] = useState<(SavedView & ViewState)[]>([
    {
      id: 'v1',
      name: 'Overdue super critical',
      filters: { status: ['OVERDUE'], criticality: ['SUPER_CRITICAL'] },
      query: '',
    },
  ]);
  const [current, setCurrent] = useState<string | undefined>();
  const [defaultId, setDefaultId] = useState<string | undefined>();
  const saved = views.find((v) => v.id === current) ?? DEFAULT_STATE;
  const pick = (v: ViewState): ViewState => ({ filters: v.filters, query: v.query });
  return {
    list: views.map(({ id, name }) => ({ id, name })),
    current,
    defaultId,
    edited: !sameState(state, pick(saved)),
    onSelect: (id: string | undefined) => {
      setCurrent(id);
      apply(pick(views.find((v) => v.id === id) ?? DEFAULT_STATE));
    },
    onSave: (name: string) => {
      const id = `v${Date.now()}`;
      setViews((vs) => [...vs, { id, name, ...state }]);
      setCurrent(id);
      toast({ tone: 'success', message: `Saved view "${name}".` });
    },
    onUpdate: (id: string) =>
      setViews((vs) => vs.map((v) => (v.id === id ? { ...v, ...state } : v))),
    onDiscard: () => apply(pick(saved)),
    onRename: (id: string, name: string) =>
      setViews((vs) => vs.map((v) => (v.id === id ? { ...v, name } : v))),
    onDelete: (id: string) => {
      setViews((vs) => vs.filter((v) => v.id !== id));
      if (defaultId === id) setDefaultId(undefined);
      setCurrent(undefined);
      apply(DEFAULT_STATE);
    },
    onSetDefault: (id: string | undefined) => {
      setDefaultId(id);
      toast({ tone: 'info', message: 'The register now opens on this view.' });
    },
  };
}

export function DataTablePage() {
  const data = useMemo(() => makeInstances(10_000), []);
  const [filterValue, setFilterValue] = useState<Record<string, FilterValue>>({});
  const [query, setQuery] = useState('');
  // The API filters in the app; the demo filters in memory to show the bar and table together.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pick = (key: string) => filterValue[key] as string[] | undefined;
    return data.filter(
      (r) =>
        (!pick('status') || pick('status')!.includes(r.status)) &&
        (!pick('criticality') || pick('criticality')!.includes(r.criticality)) &&
        (!pick('department') || pick('department')!.includes(r.department)) &&
        (!q || `${r.id} ${r.title} ${r.act}`.toLowerCase().includes(q)),
    );
  }, [data, filterValue, query]);
  const [mode, setMode] = useState<Mode>('data');
  const views = useSavedViews({ filters: filterValue, query }, (v) => {
    setFilterValue(v.filters);
    setQuery(v.query);
  });
  const { params } = useRoute();
  const openId = params.get('open');
  const openIndex = openId ? data.findIndex((r) => r.id === openId) : -1;
  const open = openIndex >= 0 ? data[openIndex]! : null;
  const show = (i: number) => {
    window.location.hash = `/data-table?open=${data[i]!.id}`;
  };
  const [sendBack, setSendBack] = useState(false);
  return (
    <Page
      title="DataTable"
      intro="10,000 instances, virtualised. Tab into the table, then use the arrow keys, Space to select and Enter to open."
    >
      <Section title="State">
        <RadioGroup
          label="Table state"
          orientation="horizontal"
          value={mode}
          onValueChange={(v) => setMode(v as Mode)}
          options={[
            { value: 'data', label: 'Data' },
            { value: 'loading', label: 'Loading' },
            { value: 'refetching', label: 'Refetching' },
            { value: 'error', label: 'Error' },
            { value: 'empty', label: 'No results' },
          ]}
        />
      </Section>
      <FilterBar
        filters={filterDefs}
        value={filterValue}
        onChange={setFilterValue}
        search={{ value: query, onChange: setQuery }}
        resultText={`${filtered.length.toLocaleString('en-IN')} instances match`}
        resultCount={filtered.length}
        disabled={mode === 'error'}
      />
      <DataTable<Instance>
        label="Register"
        columns={columns}
        data={mode === 'empty' || mode === 'error' ? [] : filtered}
        rowId={(r) => r.id}
        rowLabel={(r) => `${r.id}, ${r.title}`}
        rowHref={(r) => `#/data-table?open=${r.id}`}
        totalCount={mode === 'empty' ? 0 : filtered.length}
        countNoun={{ one: 'instance', other: 'instances' }}
        loading={mode === 'loading'}
        refetching={mode === 'refetching'}
        error={
          mode === 'error'
            ? {
                message: 'Check your connection and try again.',
                retry: () => setMode('data'),
                errorId: '7f3a9c21',
              }
            : undefined
        }
        empty={
          <EmptyState
            variant="no-results"
            title="No instances match these filters"
            body="Try removing a filter or widening the period."
            action={{
              label: 'Clear filters',
              onClick: () => {
                setMode('data');
                setFilterValue({});
                setQuery('');
              },
            }}
          />
        }
        selection={{
          bulkActions: [
            {
              label: 'Assign',
              icon: UserPlus,
              onClick: () => toast({ tone: 'info', message: 'Assign' }),
            },
            {
              label: 'Approve',
              icon: CheckCheck,
              onClick: (ids) =>
                toast({
                  tone: 'success',
                  message: `Approved ${ids === 'all' ? 'all matching' : ids.length} instances.`,
                }),
            },
          ],
        }}
        views={views}
        onExport={() => toast({ tone: 'info', message: 'Export started' })}
        maxHeight={520}
      />
      <p className="text-meta text-muted">
        <Download aria-hidden size={12} className="mr-1 inline" />
        Export and bulk actions only show toasts in this demo.
      </p>
      <Drawer
        open={!!open}
        onOpenChange={(o) => {
          if (!o) window.location.hash = '/data-table';
        }}
        title={open?.title ?? ''}
        eyebrow={open?.id}
        meta={
          open ? (
            <>
              <StatusPill status={open.status} days={open.days} />
              <CriticalityTag level={open.criticality} />
              <span>Due {formatDate(open.due)}</span>
            </>
          ) : null
        }
        itemNoun="instance"
        onPrev={openIndex > 0 ? () => show(openIndex - 1) : undefined}
        onNext={
          openIndex >= 0 && openIndex < data.length - 1 ? () => show(openIndex + 1) : undefined
        }
        backLabel="Back to register"
        footer={
          <>
            <Button onClick={() => setSendBack(true)}>Send back</Button>
            <Button
              variant="primary"
              onClick={() => toast({ tone: 'success', message: 'Approved.' })}
            >
              Approve
            </Button>
          </>
        }
      >
        {open ? (
          <>
            <DrawerSection title="Description">
              <p className="whitespace-pre-line text-body text-ink">
                {`File the ${open.title.toLowerCase()} under the ${open.act}.\n1. Collect the challans.\n2. Upload the acknowledgement.`}
              </p>
            </DrawerSection>
            <DrawerSection title="Details">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                {[
                  ['Act', open.act],
                  ['Department', open.department],
                  ['Owner', open.owner?.name ?? 'Unassigned'],
                  ['Approver', open.approver?.name ?? 'Unassigned'],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-meta text-muted">{k}</dt>
                    <dd className="text-body text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
            </DrawerSection>
          </>
        ) : null}
      </Drawer>
      <ConfirmDialog
        open={sendBack}
        onOpenChange={setSendBack}
        title={`Send back to ${open?.owner?.name ?? 'the owner'}?`}
        body="They'll be notified and the instance returns to their list."
        confirmLabel="Send back"
        reason={{
          label: 'Reason (required)',
          required: true,
          minLength: 5,
          helper: 'The owner sees this.',
        }}
        onConfirm={() => {
          toast({ tone: 'success', message: 'Sent back.' });
        }}
      />
      <Toaster />
    </Page>
  );
}
