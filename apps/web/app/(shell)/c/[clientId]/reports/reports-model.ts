// What the reports page shows, from M10's act-wise, department-wise and overdue reports. Display only: scores,
// counts, statuses and overdue days are the API's (engine output). This file groups statuses into columns and builds
// the links, each to exactly the rows behind a number.
import type {
  Breakdown,
  DerivedStatus,
  ExportKind,
  InstanceRow,
  ScoreResult,
} from '@canopy/contracts';

import type { Period } from '../../../../../lib/period';
import { registerHref } from '../overview/overview-model';

const COMPLIED = ['COMPLIED', 'COMPLIED_LATE'] as const satisfies DerivedStatus[];
const STILL_OPEN = ['UPCOMING', 'DUE_SOON', 'SUBMITTED'] as const satisfies DerivedStatus[];

const sum = (result: ScoreResult, statuses: readonly DerivedStatus[]) =>
  statuses.reduce((n, s) => n + result.counts[s], 0);

export type ReportCount = { value: number; href: string };

export type ReportRow = {
  id: string;
  name: string;
  /** The API's score; null = no items due. */
  score: number | null;
  onTimeRate: number | null;
  complied: ReportCount;
  overdue: ReportCount;
  open: ReportCount;
  notApplicable: ReportCount;
  href: string;
};

/** One row per Act or department, in name order, each count linking to its rows in the list of instances. */
export function reportRows(
  clientId: string,
  breakdown: Breakdown,
  key: 'actId' | 'departmentId',
  period: Period | undefined,
): ReportRow[] {
  const link = (id: string, statuses?: readonly DerivedStatus[]) =>
    registerHref(
      clientId,
      { [key]: id, ...(statuses ? { status: statuses.join(',') } : {}) },
      period,
    );
  return breakdown.rows
    .map(({ key: id, label, result }) => ({
      id,
      name: label,
      score: result.score,
      onTimeRate: result.onTimeRate,
      complied: { value: sum(result, COMPLIED), href: link(id, COMPLIED) },
      overdue: { value: result.counts.OVERDUE, href: link(id, ['OVERDUE']) },
      open: { value: sum(result, STILL_OPEN), href: link(id, STILL_OPEN) },
      notApplicable: { value: result.counts.NOT_APPLICABLE, href: link(id, ['NOT_APPLICABLE']) },
      href: link(id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export type OverdueRow = {
  id: string;
  title: string;
  act: string;
  unit: string;
  department: string;
  owner: string;
  dueDate: string;
  days: number;
  href: string;
};

/** Overdue instances in the API's order (most overdue first), each opening its drawer. */
export function overdueRows(
  rows: readonly InstanceRow[],
  period: Period | undefined,
): OverdueRow[] {
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    act: row.actName,
    unit: row.unitName,
    department: row.departmentName,
    owner: row.ownerName,
    dueDate: row.dueDate,
    days: row.overdueDays ?? 0,
    href: registerHref(row.clientId, {}, period, `register/${encodeURIComponent(row.id)}`),
  }));
}

/** The downloads the page offers, in the order they appear. */
export const DOWNLOADS: { kind: ExportKind; label: string; description: string }[] = [
  {
    kind: 'ACT_REPORT_XLSX',
    label: 'Act-wise report (Excel)',
    description: 'Scores and counts for each Act.',
  },
  {
    kind: 'DEPARTMENT_REPORT_XLSX',
    label: 'Department-wise report (Excel)',
    description: 'Scores and counts for each department.',
  },
  {
    kind: 'OVERDUE_REPORT_XLSX',
    label: 'Overdue report (Excel)',
    description: 'Every overdue instance, most overdue first.',
  },
  {
    kind: 'CERTIFICATE_PDF',
    label: 'Compliance certificate (PDF)',
    description: 'A summary of the financial year’s compliance, for the client’s management.',
  },
];
