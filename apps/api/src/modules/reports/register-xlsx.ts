import type {
  Criticality,
  InstanceRow,
  LocalDate,
  TimelineType,
  WorkflowState,
} from '@canopy/contracts';
import ExcelJS from 'exceljs';
import type { ExportDetail } from '../dashboard/ports.js';

/**
 * The register as an Excel workbook that re-imports with no changes (MODULES.md M10, endpoints.md §6):
 * the 19 sample-register headers in the sample's order, with the values the importer reads back to the same
 * obligations, assignments and instances (packages/importer KNOWN_HEADERS, reference tables, status rules).
 */

export const REGISTER_HEADERS = [
  'EY Compliance ID',
  'Compliance Title',
  'Type (TimeLine)',
  'Compliance Description',
  'Compliance Categorization',
  'Applicability',
  'Act',
  'Activity Date',
  'Compliance Status',
  'Due Date',
  'Form Description',
  'Log Sheet Description',
  'Organization',
  'Location',
  'Owner',
  'Owner Comments',
  'Approvers',
  'Department',
  'Criticality',
] as const;

/** The register's own spellings, which the importer reads without a normalisation issue. */
const CRITICALITY_WORDS: Readonly<Record<Criticality, string>> = {
  SUPER_CRITICAL: 'Super Critical',
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

const TIMELINE_LABELS: Readonly<Record<TimelineType, string>> = {
  TIME_BASED: 'Time Based',
  ONGOING: 'On Going',
};

/**
 * Register status words the importer knows. Work in progress (SUBMITTED, SENT_BACK) is "Pending": the
 * register has no word for it, and a pending row carries no Activity Date.
 */
export function registerStatus(state: WorkflowState): 'Complied' | 'Pending' | 'Not Applicable' {
  if (state === 'APPROVED') return 'Complied';
  if (state === 'NOT_APPLICABLE') return 'Not Applicable';
  return 'Pending';
}

/** A calendar date as an Excel date cell (UTC midnight, which the importer reads back as the same date). */
function excelDate(date: LocalDate | null): Date | null {
  return date === null ? null : new Date(`${date}T00:00:00Z`);
}

/** "India / West Bengal / Belur" (register row label) → "India/ West Bengal/ Belur" (sample spelling). */
function locationPath(label: string): string {
  return label
    .split('/')
    .map((part) => part.trim())
    .join('/ ');
}

/** Activity Date and Due Date, 1-based. */
const DATE_COLUMNS = [8, 10];

export interface RegisterSheetRow {
  row: InstanceRow;
  detail: ExportDetail;
}

export function registerCells(
  clientName: string,
  { row, detail }: RegisterSheetRow,
): (string | Date | null)[] {
  const status = registerStatus(row.workflowState);
  return [
    row.externalRef,
    row.title,
    TIMELINE_LABELS[row.timelineType],
    detail.description,
    row.categoryName,
    detail.applicabilityText,
    row.actName,
    excelDate(status === 'Pending' ? null : row.completedOn),
    status,
    excelDate(row.dueDate),
    row.formLabels.join('\n') || null,
    row.logSheetLabels.join('\n') || null,
    `${clientName}/ ${row.companyName}/ ${row.unitName}`,
    locationPath(row.locationLabel),
    row.ownerName,
    status === 'Not Applicable' ? detail.naReason : detail.firstComment,
    row.approverName,
    row.departmentName,
    CRITICALITY_WORDS[row.criticality],
  ];
}

export async function registerWorkbook(
  clientName: string,
  rows: readonly RegisterSheetRow[],
): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PlanetPulse Compliance';
  const sheet = workbook.addWorksheet('Register', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.addRow([...REGISTER_HEADERS]).font = { bold: true };
  for (const r of rows) {
    const added = sheet.addRow(registerCells(clientName, r));
    for (const column of DATE_COLUMNS) added.getCell(column).numFmt = 'yyyy-mm-dd';
  }
  sheet.columns.forEach((column, index) => {
    column.width = index === 3 ? 60 : 22;
  });
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
