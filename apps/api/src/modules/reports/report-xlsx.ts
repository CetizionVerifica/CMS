import type { Breakdown, DerivedStatus, InstanceRow, ScoreResult } from '@canopy/contracts';
import ExcelJS from 'exceljs';
import { CRITICALITY_LABELS } from '../dashboard/service.js';

/** Act-wise, department-wise and overdue reports as Excel workbooks. Numbers are the engine's, unchanged. */

/** Status columns in reading order, with the words the UI uses (packages/ui/spec/status-language.md). */
export const STATUS_COLUMNS: readonly [DerivedStatus, string][] = [
  ['COMPLIED', 'Complied'],
  ['COMPLIED_LATE', 'Complied late'],
  ['SUBMITTED', 'Awaiting approval'],
  ['OVERDUE', 'Overdue'],
  ['DUE_SOON', 'Due soon'],
  ['UPCOMING', 'Upcoming'],
  ['NOT_APPLICABLE', 'Not applicable'],
];

export interface ReportHeading {
  title: string;
  clientName: string;
  periodLabel: string;
  asOf: string;
}

function addHeading(sheet: ExcelJS.Worksheet, heading: ReportHeading): void {
  sheet.addRow([`PlanetPulse Compliance · ${heading.title}`]).font = { bold: true, size: 14 };
  sheet.addRow([heading.clientName]);
  sheet.addRow([`Period: ${heading.periodLabel} · Status as at ${heading.asOf}`]);
  sheet.addRow([]);
}

/** A score as a percentage cell, or "No items due" when the engine returns null. */
function percentCell(value: number | null): number | string {
  return value === null ? 'No items due' : value;
}

function scoreCells(result: ScoreResult): (number | string)[] {
  const total = STATUS_COLUMNS.reduce((sum, [status]) => sum + result.counts[status], 0);
  return [
    total,
    ...STATUS_COLUMNS.map(([status]) => result.counts[status]),
    percentCell(result.score),
    percentCell(result.onTimeRate),
  ];
}

async function toBytes(workbook: ExcelJS.Workbook): Promise<Uint8Array> {
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

function newWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PlanetPulse Compliance';
  return workbook;
}

/** One row per group (Act or department) and a total row for the whole period. */
export async function breakdownWorkbook(
  heading: ReportHeading,
  groupHeader: string,
  breakdown: Breakdown,
  total: ScoreResult,
): Promise<Uint8Array> {
  const workbook = newWorkbook();
  const sheet = workbook.addWorksheet('Report');
  addHeading(sheet, heading);
  sheet.addRow([
    groupHeader,
    'Instances',
    ...STATUS_COLUMNS.map(([, label]) => label),
    'Score %',
    'On-time %',
  ]).font = { bold: true };
  for (const row of breakdown.rows) sheet.addRow([row.label, ...scoreCells(row.result)]);
  sheet.addRow(['All', ...scoreCells(total)]).font = { bold: true };
  sheet.getColumn(1).width = 50;
  return toBytes(workbook);
}

export const OVERDUE_HEADERS = [
  'Compliance ID',
  'Compliance Title',
  'Act',
  'Department',
  'Unit',
  'Owner',
  'Approver',
  'Criticality',
  'Due Date',
  'Days overdue',
] as const;

/** Overdue instances, most overdue first, with the period's score above them. */
export async function overdueWorkbook(
  heading: ReportHeading,
  result: ScoreResult,
  items: readonly InstanceRow[],
): Promise<Uint8Array> {
  const workbook = newWorkbook();
  const sheet = workbook.addWorksheet('Overdue');
  addHeading(sheet, heading);
  sheet.addRow(['Score %', percentCell(result.score), 'Overdue', result.counts.OVERDUE]);
  sheet.addRow([]);
  sheet.addRow([...OVERDUE_HEADERS]).font = { bold: true };
  for (const r of items) {
    sheet.addRow([
      r.externalRef,
      r.title,
      r.actName,
      r.departmentName,
      r.unitName,
      r.ownerName,
      r.approverName,
      CRITICALITY_LABELS[r.criticality],
      r.dueDate,
      r.overdueDays,
    ]);
  }
  sheet.getColumn(2).width = 50;
  return toBytes(workbook);
}
