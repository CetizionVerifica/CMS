import { InstanceRow, REGISTER_SORT_FIELDS } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { makeRow } from '../_test/rows';
import {
  DEFAULT_COLUMN_IDS,
  DEFAULT_VISIBILITY,
  registerColumns,
  rowLabel,
  statusValue,
} from './columns';

type Accessor = (row: InstanceRow, index: number) => unknown;
const value = (id: string, row: InstanceRow) =>
  (registerColumns.find((c) => c.id === id) as { accessorFn: Accessor }).accessorFn(row, 0);

describe('register columns', () => {
  it('test rows satisfy the contract', () => {
    expect(InstanceRow.safeParse(makeRow(3)).success).toBe(true);
  });

  it('shows the Excel columns by default, in Excel order', () => {
    expect(DEFAULT_COLUMN_IDS).toEqual([
      'externalRef',
      'title',
      'actName',
      'departmentName',
      'ownerName',
      'approverName',
      'dueDate',
      'status',
      'criticality',
    ]);
    expect(registerColumns.slice(0, 9).map((c) => c.id)).toEqual([...DEFAULT_COLUMN_IDS]);
    expect(registerColumns.map((c) => c.header)).toContain('Due date');
    expect(
      Object.entries(DEFAULT_VISIBILITY)
        .filter(([, on]) => on)
        .map(([id]) => id),
    ).toEqual([...DEFAULT_COLUMN_IDS]);
  });

  it('allows sorting only on fields the API sorts by', () => {
    const sortable = registerColumns.filter((c) => c.enableSorting).map((c) => c.id);
    for (const id of sortable) expect(REGISTER_SORT_FIELDS).toContain(id);
    expect(sortable).toContain('dueDate');
    expect(sortable).not.toContain('externalRef');
  });

  it('locks the title column', () => {
    expect(registerColumns.find((c) => c.id === 'title')?.meta?.locked).toBe(true);
  });

  it('reads each value from the row', () => {
    const row = makeRow(7, {
      completedOn: '2023-03-02' as InstanceRow['completedOn'],
      evidenceCount: 2,
    });
    expect(value('externalRef', row)).toBe('TAX-CL-0007');
    expect(value('externalRef', { ...row, externalRef: null })).toBe('');
    expect(value('title', row)).toEqual({ title: 'Obligation 7', sub: 'Tax' });
    expect(value('ownerName', row)).toEqual({ name: 'Owner 01' });
    expect(value('approverName', row)).toEqual({ name: 'Approver 01' });
    expect(value('dueDate', row)).toBe(row.dueDate);
    expect(value('criticality', row)).toBe(row.criticality);
    expect(value('actName', row)).toBe('Act 2');
    expect(value('departmentName', row)).toBe(row.departmentName);
    expect(value('unitName', row)).toBe('Plant 01');
    expect(value('locationLabel', row)).toBe(row.locationLabel);
    expect(value('categoryName', row)).toBe('Tax');
    expect(value('completedOn', row)).toBe('2023-03-02');
    expect(value('evidenceCount', row)).toBe(2);
    expect(value('commentCount', row)).toBe(0);
  });
});

describe('statusValue', () => {
  it('passes the engine status and overdue days through', () => {
    expect(statusValue(makeRow(1, { status: 'OVERDUE', overdueDays: 4 }))).toEqual({
      status: 'OVERDUE',
      days: 4,
      dueDate: makeRow(1).dueDate,
    });
    expect(statusValue(makeRow(1, { status: 'COMPLIED' }))).toEqual({
      status: 'COMPLIED',
      dueDate: makeRow(1).dueDate,
    });
  });

  it('names a sent-back instance as sent back', () => {
    expect(statusValue(makeRow(1, { workflowState: 'SENT_BACK', status: 'DUE_SOON' })).status).toBe(
      'SENT_BACK',
    );
  });
});

describe('rowLabel', () => {
  it('reads ID then title, or the title alone', () => {
    expect(rowLabel(makeRow(2))).toBe('TAX-CL-0002, Obligation 2');
    expect(rowLabel(makeRow(2, { externalRef: null }))).toBe('Obligation 2');
  });
});
