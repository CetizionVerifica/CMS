// Register columns. The default set mirrors the client's Excel register (apps/web/CLAUDE.md "Register"): ID, Title,
// Act, Department, Owner, Approver, Due date, Status, Criticality. Everything here is formatting; status, overdue days
// and dates come from the API (engine output).
import type { InstanceRow } from '@canopy/contracts';
import type { PersonValue, StatusValue, TitleValue } from '@canopy/ui';
import type { ColumnDef } from '@tanstack/react-table';

/** Column ids that are also API sort fields; the grid sorts on the server (`manualSorting`). */
const SORTABLE = new Set([
  'title',
  'actName',
  'departmentName',
  'ownerName',
  'dueDate',
  'completedOn',
  'status',
  'criticality',
]);

/**
 * The pill to show. The engine's derived status has no "sent back" (it counts as open work), but the status language
 * names it (packages/ui/CLAUDE.md), so a SENT_BACK workflow state shows that pill. Display only.
 */
export function statusValue(row: InstanceRow): StatusValue {
  if (row.workflowState === 'SENT_BACK') return { status: 'SENT_BACK', dueDate: row.dueDate };
  return {
    status: row.status,
    dueDate: row.dueDate,
    ...(row.overdueDays !== null ? { days: row.overdueDays } : {}),
  };
}

const person = (name: string): PersonValue => ({ name });

type Column = ColumnDef<InstanceRow, never>;

function col(
  id: string,
  header: string,
  type: NonNullable<Column['meta']>['type'],
  accessor: (row: InstanceRow) => unknown,
  extra: Partial<Column> = {},
): Column {
  return {
    id,
    header,
    accessorFn: accessor as never,
    enableSorting: SORTABLE.has(id),
    meta: { type, label: header },
    ...extra,
  } as Column;
}

/** Visible by default, in Excel order. */
export const DEFAULT_COLUMN_IDS = [
  'externalRef',
  'title',
  'actName',
  'departmentName',
  'ownerName',
  'approverName',
  'dueDate',
  'status',
  'criticality',
] as const;

export const registerColumns: Column[] = [
  col('externalRef', 'ID', 'id', (r) => r.externalRef ?? '', { size: 130 }),
  col('title', 'Title', 'title', (r): TitleValue => ({ title: r.title, sub: r.categoryName }), {
    size: 320,
    meta: { type: 'title', label: 'Title', locked: true },
  }),
  col('actName', 'Act', 'text', (r) => r.actName, { size: 220 }),
  col('departmentName', 'Department', 'text', (r) => r.departmentName, { size: 150 }),
  col('ownerName', 'Owner', 'person', (r) => person(r.ownerName), { size: 170 }),
  col('approverName', 'Approver', 'person', (r) => person(r.approverName), { size: 170 }),
  col('dueDate', 'Due date', 'date', (r) => r.dueDate, { size: 120 }),
  col('status', 'Status', 'status', statusValue, { size: 160 }),
  col('criticality', 'Criticality', 'criticality', (r) => r.criticality, { size: 130 }),
  // Off by default; the column chooser adds them.
  col('unitName', 'Unit', 'text', (r) => r.unitName, { size: 150 }),
  col('locationLabel', 'Location', 'text', (r) => r.locationLabel, { size: 200 }),
  col('categoryName', 'Category', 'text', (r) => r.categoryName, { size: 150 }),
  col('completedOn', 'Completed on', 'date', (r) => r.completedOn, { size: 130 }),
  col('evidenceCount', 'Evidence', 'number', (r) => r.evidenceCount, { size: 100 }),
  col('commentCount', 'Comments', 'number', (r) => r.commentCount, { size: 110 }),
];

/** Column visibility for Default: the Excel columns on, the rest off. */
export const DEFAULT_VISIBILITY: Record<string, boolean> = Object.fromEntries(
  registerColumns.map((c) => [c.id!, (DEFAULT_COLUMN_IDS as readonly string[]).includes(c.id!)]),
);

/** "TAX-CL-033, Tax collection at source": the row's accessible name for its selection checkbox. */
export function rowLabel(row: InstanceRow): string {
  return row.externalRef ? `${row.externalRef}, ${row.title}` : row.title;
}
