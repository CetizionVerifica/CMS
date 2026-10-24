import { describe, expect, it } from 'vitest';

import { breakdown, CLIENT, id, instance, result } from '../overview/test-data';
import { DOWNLOADS, overdueRows, reportRows } from './reports-model';

const FY = { fy: '2024-25' };

describe('reportRows', () => {
  it('groups the counts into columns, in name order, each linking to exactly its rows', () => {
    const rows = reportRows(
      CLIENT,
      breakdown('act', [
        {
          key: id(2),
          label: 'Factories Act',
          result: result(
            { COMPLIED: 3, COMPLIED_LATE: 1, OVERDUE: 2, UPCOMING: 1, SUBMITTED: 1 },
            61.5,
            50,
          ),
        },
        { key: id(1), label: 'Contract Labour Act', result: result({ NOT_APPLICABLE: 2 }) },
      ]),
      'actId',
      FY,
    );
    expect(rows.map((r) => r.name)).toEqual(['Contract Labour Act', 'Factories Act']);
    const factories = rows[1]!;
    expect(factories).toMatchObject({
      score: 61.5,
      onTimeRate: 50,
      complied: { value: 4 },
      overdue: { value: 2 },
      open: { value: 2 },
      notApplicable: { value: 0 },
    });
    const base = `/c/${CLIENT}/register?actId=${id(2)}`;
    expect(factories.overdue.href).toBe(`${base}&status=OVERDUE&fy=2024-25`);
    expect(factories.complied.href).toBe(`${base}&status=COMPLIED%2CCOMPLIED_LATE&fy=2024-25`);
    expect(factories.open.href).toBe(`${base}&status=UPCOMING%2CDUE_SOON%2CSUBMITTED&fy=2024-25`);
    expect(factories.href).toBe(`${base}&fy=2024-25`);
    expect(rows[0]!.score).toBeNull();
  });

  it('filters departments by department', () => {
    const [row] = reportRows(
      CLIENT,
      breakdown('department', [{ key: id(3), label: 'EHS', result: result({ OVERDUE: 1 }) }]),
      'departmentId',
      undefined,
    );
    expect(row!.overdue.href).toBe(`/c/${CLIENT}/register?departmentId=${id(3)}&status=OVERDUE`);
  });
});

describe('overdueRows', () => {
  it('keeps the API order and opens each instance', () => {
    const rows = overdueRows(
      [
        instance(1, { status: 'OVERDUE', overdueDays: 40, title: 'Annual return' }),
        instance(2, { status: 'OVERDUE', overdueDays: 3 }),
      ],
      FY,
    );
    expect(rows.map((r) => r.days)).toEqual([40, 3]);
    expect(rows[0]).toMatchObject({ title: 'Annual return' });
    expect(rows[0]!.href).toBe(
      `/c/${CLIENT}/register/${encodeURIComponent(rows[0]!.id)}?fy=2024-25`,
    );
  });
});

describe('DOWNLOADS', () => {
  it('offers each report and the certificate once', () => {
    expect(DOWNLOADS.map((d) => d.kind)).toEqual([
      'ACT_REPORT_XLSX',
      'DEPARTMENT_REPORT_XLSX',
      'OVERDUE_REPORT_XLSX',
      'CERTIFICATE_PDF',
    ]);
  });
});
