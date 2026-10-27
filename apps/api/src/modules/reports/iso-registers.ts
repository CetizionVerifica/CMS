import {
  INCIDENT_SOURCES,
  type FirmSettings,
  type IsoAction,
  type IsoRiskRule,
  type LocalDate,
  type Nonconformity,
  type NonconformityStatus,
  type RiskItem,
} from '@canopy/contracts';
import { localDateIn, nonconformityStatus, reviewDue } from '@canopy/engine';
import ExcelJS from 'exceljs';
import type { IsoNames, IsoNcBook, IsoRiskBook } from '../dashboard/ports.js';
import { codeWords, controlHierarchyWords, STANDARD_WORDS, yesNo } from './iso-words.js';

/**
 * The NC log and the risk register as Excel workbooks (docs/iso/model.md §9). The store has applied the list filters
 * and the requester's unit scope (plan §3.3); this file applies the filters the list computes (`incident`, `overdue`,
 * `q`), orders the rows as the lists do, and prints them. Timing and review status are the engine's. No injured
 * person's details: the incident columns are its type, day, place, outcome, lost days and whether it is reportable
 * (model §3.11), never the person category.
 */

export interface IsoHeading {
  title: string;
  clientName: string;
  asOf: LocalDate;
  /** The filters the export was started with, in words; empty for none. */
  filters: readonly string[];
  /** True when the requester's unit scope limits the records (an approver or owner with units). */
  scoped: boolean;
}

function addHeading(sheet: ExcelJS.Worksheet, heading: IsoHeading): void {
  sheet.addRow([`PlanetPulse Compliance · ${heading.title}`]).font = { bold: true, size: 14 };
  sheet.addRow([heading.clientName]);
  sheet.addRow([`Status as at ${heading.asOf}`]);
  sheet.addRow([
    heading.filters.length === 0 ? 'Filters: none' : `Filters: ${heading.filters.join('; ')}`,
  ]);
  if (heading.scoped) sheet.addRow(['Only the records of your units and those naming you']);
}

function newWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PlanetPulse Compliance';
  return workbook;
}

async function toBytes(workbook: ExcelJS.Workbook): Promise<Uint8Array> {
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

/** Case-insensitive substring of any value, as the ISO lists match `q`. */
function matches(q: string | undefined, ...values: (string | null)[]): boolean {
  if (q === undefined) return true;
  const needle = q.toLowerCase();
  return values.some((v) => v?.toLowerCase().includes(needle));
}

const nameOf = (names: ReadonlyMap<string, string>, id: string | null): string =>
  id === null ? '' : (names.get(id) ?? '');

function actionsBySubject(actions: readonly IsoAction[]): Map<string, IsoAction[]> {
  const out = new Map<string, IsoAction[]>();
  for (const action of actions) {
    const list = out.get(action.subject.id) ?? [];
    list.push(action);
    out.set(action.subject.id, list);
  }
  return out;
}

// ---------- the NC log ----------

/** What the NC log filters after the read; the rest of `NcQuery` the store applies. */
export interface NcLogQuery {
  incident?: boolean;
  overdue?: boolean;
  q?: string;
}

export interface NcLogRow {
  nc: Nonconformity;
  status: NonconformityStatus;
  openActions: number;
}

const isIncident = (nc: Nonconformity) =>
  (INCIDENT_SOURCES as readonly string[]).includes(nc.source);

/** The log's rows: newest first (`reportedOn`, then number), as the list orders them. */
export function ncLogRows(
  book: IsoNcBook,
  query: NcLogQuery,
  asOf: LocalDate,
  settings: Pick<FirmSettings, 'dueSoonDays'>,
): NcLogRow[] {
  const actions = actionsBySubject(book.actions);
  return book.items
    .map((nc) => {
      const own = actions.get(nc.id) ?? [];
      return {
        nc,
        status: nonconformityStatus(nc, own, asOf, settings),
        openActions: own.filter((a) => a.state === 'OPEN').length,
      };
    })
    .filter(
      ({ nc, status }) =>
        (query.incident === undefined || isIncident(nc) === query.incident) &&
        (query.overdue === undefined || (status.timing === 'OVERDUE') === query.overdue) &&
        matches(query.q, String(nc.number), nc.description, nc.rootCause),
    )
    .sort(
      (a, b) =>
        b.nc.reportedOn.localeCompare(a.nc.reportedOn) ||
        b.nc.number - a.nc.number ||
        a.nc.id.localeCompare(b.nc.id),
    );
}

export const NC_LOG_HEADERS = [
  'Number',
  'Management system',
  'Standards',
  'Clauses',
  'Source',
  'Severity',
  'Unit',
  'Description',
  'Reported on',
  'Reported by',
  'Owner',
  'Approver',
  'Due on',
  'State',
  'Timing',
  'Days overdue',
  'Open actions',
  'Containment',
  'Correction',
  'Disposition',
  'Disposition authorised by',
  'Root cause method',
  'Root cause',
  'Effectiveness due on',
  'Effective',
  'Closed on',
  'Cancel reason',
  'Incident type',
  'Occurred on',
  'Location',
  'Outcome',
  'Lost days',
  'Reportable',
] as const;

/** A record with no unit of its own takes its system's units (plan §3.3). */
const WHOLE_SYSTEM = 'The whole system';

function ncCells(row: NcLogRow, names: IsoNames, timeZone: string): (string | number | null)[] {
  const { nc, status } = row;
  const incident = nc.incident;
  return [
    nc.number,
    nameOf(names.systems, nc.managementSystemId),
    nc.standards.map((code) => STANDARD_WORDS[code]).join(', '),
    nc.clauseIds.map((id) => nameOf(names.clauses, id)).join(', '),
    codeWords(nc.source),
    codeWords(nc.severity),
    nc.unitId === null ? WHOLE_SYSTEM : nameOf(names.units, nc.unitId),
    nc.description,
    nc.reportedOn,
    nameOf(names.people, nc.reportedById),
    nameOf(names.people, nc.ownerId),
    nameOf(names.people, nc.approverId),
    nc.dueOn,
    codeWords(nc.state),
    codeWords(status.timing),
    status.overdueDays,
    row.openActions,
    nc.containment,
    nc.correction,
    nc.disposition === null ? null : codeWords(nc.disposition),
    nameOf(names.people, nc.dispositionAuthorisedById),
    nc.rootCauseMethod === null ? null : codeWords(nc.rootCauseMethod),
    nc.rootCause,
    nc.effectivenessDueOn,
    yesNo(nc.effective),
    nc.closedOn,
    nc.cancelReason,
    incident === null ? null : codeWords(incident.type),
    incident === null ? null : localDateIn(incident.occurredAt, timeZone),
    incident?.location ?? null,
    incident === null ? null : codeWords(incident.outcome),
    incident?.lostDays ?? null,
    incident === null ? null : yesNo(incident.reportable),
  ];
}

export async function ncLogWorkbook(
  heading: IsoHeading,
  rows: readonly NcLogRow[],
  names: IsoNames,
  timeZone: string,
): Promise<Uint8Array> {
  const workbook = newWorkbook();
  const sheet = workbook.addWorksheet('NC log');
  addHeading(sheet, heading);
  sheet.addRow([]);
  sheet.addRow([...NC_LOG_HEADERS]).font = { bold: true };
  for (const row of rows) sheet.addRow(ncCells(row, names, timeZone));
  sheet.getColumn(NC_LOG_HEADERS.indexOf('Description') + 1).width = 50;
  return toBytes(workbook);
}

// ---------- the risk register ----------

/** The documented significance criteria (14001 6.1.2): the account's rule (FirmSettings.isoRisk) in words. */
export function significanceCriteria(rule: IsoRiskRule): string {
  const legal = rule.legalLinkMakesSignificant
    ? ', or when it is linked to a statutory obligation'
    : '';
  return (
    'Significance criteria: an item is significant when its rating (likelihood × severity, each on a 1 to 5 scale, ' +
    `with the existing controls) is ${rule.significantAt} or more${legal}. ` +
    'A recorded override, with its reason, decides instead. The residual rating is shown and does not decide it.'
  );
}

/** Highest rating first, then in the order added, as the list orders them; `q` as the list matches it. */
export function riskRegisterRows(book: IsoRiskBook, q: string | undefined): RiskItem[] {
  return book.items
    .filter((r) => matches(q, r.activity, r.description, r.impact))
    .sort(
      (a, b) =>
        b.rating - a.rating || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
}

export const RISK_REGISTER_HEADERS = [
  'Management system',
  'Kind',
  'Unit',
  'Activity',
  'Description',
  'Impact or harm',
  'Life-cycle stages',
  'Control or influence',
  'Routine',
  'Persons exposed',
  'Condition',
  'Assessed with',
  'Likelihood',
  'Severity',
  'Rating',
  'Residual likelihood',
  'Residual severity',
  'Residual rating',
  'Significant',
  'Significance override',
  'Override reason',
  'Statutory obligations',
  'Climate related',
  'Owner',
  'Review due on',
  'Review timing',
  'Last reviewed on',
  'Controls in place',
  'Open treatment actions',
  'Archived on',
] as const;

function overrideWords(value: boolean | null): string {
  if (value === null) return '';
  return value ? 'Set significant' : 'Set not significant';
}

export async function riskRegisterWorkbook(
  heading: IsoHeading,
  rule: IsoRiskRule,
  items: readonly RiskItem[],
  book: IsoRiskBook,
  settings: Pick<FirmSettings, 'dueSoonDays'>,
  timeZone: string,
): Promise<Uint8Array> {
  const workbook = newWorkbook();
  const sheet = workbook.addWorksheet('Risk register');
  addHeading(sheet, heading);
  sheet.addRow([significanceCriteria(rule)]);
  sheet.addRow([]);
  sheet.addRow([...RISK_REGISTER_HEADERS]).font = { bold: true };
  const { names } = book;
  const actions = actionsBySubject(book.actions);
  for (const r of items) {
    const controls = book.controls
      .filter((c) => c.riskItemId === r.id)
      .map((c) =>
        c.hierarchy === null ? c.text : `${c.text} (${controlHierarchyWords(c.hierarchy)})`,
      );
    sheet.addRow([
      nameOf(names.systems, r.managementSystemId),
      codeWords(r.kind),
      r.unitId === null ? WHOLE_SYSTEM : nameOf(names.units, r.unitId),
      r.activity,
      r.description,
      r.impact,
      r.lifeCycleStages.map(codeWords).join(', '),
      r.controlType === null ? null : codeWords(r.controlType),
      yesNo(r.routine),
      r.personsExposed.map(codeWords).join(', '),
      r.condition === null ? null : codeWords(r.condition),
      r.assessedWith,
      r.likelihood,
      r.severity,
      r.rating,
      r.residualLikelihood,
      r.residualSeverity,
      r.residualRating,
      yesNo(r.significant),
      overrideWords(r.significantOverride),
      r.significanceReason,
      r.obligationIds.map((id) => nameOf(names.obligations, id)).join('; '),
      yesNo(r.climateRelated),
      nameOf(names.people, r.ownerId),
      r.reviewDueOn,
      r.archivedAt === null
        ? codeWords(reviewDue(r.reviewDueOn, heading.asOf, settings).timing)
        : '',
      r.lastReviewedOn,
      controls.join('; '),
      (actions.get(r.id) ?? []).filter((a) => a.state === 'OPEN').length,
      r.archivedAt === null ? null : localDateIn(r.archivedAt, timeZone),
    ]);
  }
  sheet.getColumn(RISK_REGISTER_HEADERS.indexOf('Description') + 1).width = 50;
  return toBytes(workbook);
}

// ---------- the filters, in words ----------

const FILTER_LABELS: Readonly<Record<string, string>> = {
  managementSystemId: 'System',
  unitId: 'Unit',
  state: 'State',
  source: 'Source',
  severity: 'Severity',
  standard: 'Standard',
  kind: 'Kind',
  ownerId: 'Owner',
  approverId: 'Approver',
  incident: 'Incidents',
  overdue: 'Overdue',
  significant: 'Significant',
  climateRelated: 'Climate related',
  includeArchived: 'Archived items included',
  q: 'Search',
};

/** The export's list filters as its heading prints them: names for ids, words for codes, "you" for `me`. */
export function filterWords(query: Readonly<Record<string, unknown>>, names: IsoNames): string[] {
  const valueWords = (key: string, value: unknown): string => {
    if (typeof value === 'boolean') return yesNo(value);
    const text = String(value);
    if (key === 'managementSystemId') return nameOf(names.systems, text) || text;
    if (key === 'unitId') return nameOf(names.units, text) || text;
    if (key === 'ownerId' || key === 'approverId') {
      return text === 'me' ? 'you' : nameOf(names.people, text) || text;
    }
    if (key === 'standard') return STANDARD_WORDS[text as keyof typeof STANDARD_WORDS] ?? text;
    if (key === 'q') return `"${text}"`;
    return codeWords(text);
  };
  return Object.entries(query)
    .filter(([key, value]) => value !== undefined && key in FILTER_LABELS)
    .map(([key, value]) => {
      const values = Array.isArray(value) ? value : [value];
      return `${FILTER_LABELS[key]}: ${values.map((v) => valueWords(key, v)).join(', ')}`;
    });
}
