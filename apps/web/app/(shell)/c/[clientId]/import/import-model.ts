// The import wizard (apps/web/CLAUDE.md "Import": upload → map → review → dry run → commit, resumable). Progress lives
// on the server in the import batch, so the step shown is read from the batch's status, never kept in the browser.
// Display only: the cleaning proposals, severities and dry-run counts are the API's (M8).
import {
  CanopyField,
  type ColumnMapping,
  type DryRunReport,
  type ImportBatch,
  type ImportBatchStatus,
  type ImportIssueGroup,
  type ImportIssueType,
} from '@canopy/contracts';

export type WizardStep = 'upload' | 'map' | 'review' | 'commit';

export const STEPS: readonly { key: WizardStep; label: string }[] = [
  { key: 'upload', label: 'Upload' },
  { key: 'map', label: 'Map columns' },
  { key: 'review', label: 'Review cleaning' },
  { key: 'commit', label: 'Dry run and commit' },
];

/** What the page shows for a batch. `working` = the API is busy (parse or commit runs in the background). */
export type BatchView =
  | { kind: 'map' }
  | { kind: 'working'; step: WizardStep; message: string }
  | { kind: 'review' }
  | { kind: 'commit' }
  | { kind: 'done' }
  | { kind: 'closed'; message: string };

/** An import, or a step of one, that would add more companies or units than the account's plan allows. */
export const PLAN_LIMIT =
  'This import would go over your plan’s company or unit limit. Nothing was changed. Ask your account admin.';

/**
 * The wizard screen for a batch. `parseStarted` says the user already asked to read the rows: the API answers 202 and
 * keeps the batch MAPPED until the background parse finishes, so the page waits rather than showing the mapping again.
 * `wantReview` reopens the review from the dry run (decisions can still change there).
 */
export function batchView(
  batch: Pick<ImportBatch, 'status' | 'failureCode'>,
  options: { parseStarted?: boolean; wantReview?: boolean } = {},
): BatchView {
  const status: ImportBatchStatus = batch.status;
  switch (status) {
    case 'UPLOADED':
      return { kind: 'map' };
    case 'MAPPED':
      return options.parseStarted
        ? { kind: 'working', step: 'map', message: 'Reading the rows and checking them…' }
        : { kind: 'map' };
    case 'PARSED':
    case 'REVIEWED':
      return { kind: 'review' };
    case 'DRY_RUN_READY':
      return options.wantReview ? { kind: 'review' } : { kind: 'commit' };
    case 'COMMITTING':
      return { kind: 'working', step: 'commit', message: 'Writing the rows to the register…' };
    case 'COMMITTED':
      return { kind: 'done' };
    case 'CANCELLED':
      return { kind: 'closed', message: 'This import was cancelled. Nothing was changed.' };
    case 'FAILED':
      return {
        kind: 'closed',
        message:
          batch.failureCode === 'PLAN_LIMIT_REACHED'
            ? PLAN_LIMIT
            : batch.failureCode
              ? `This import stopped with an error (${batch.failureCode}). Nothing was changed. Start a new import.`
              : 'This import stopped with an error. Nothing was changed. Start a new import.',
      };
  }
}

/** The step the progress list marks as current. */
export function currentStep(view: BatchView | null): WizardStep {
  if (view === null) return 'upload';
  switch (view.kind) {
    case 'map':
      return 'map';
    case 'working':
      return view.step;
    case 'review':
      return 'review';
    default:
      return 'commit';
  }
}

/** Batches that can be picked up again from the history list. */
export function isOpen(status: ImportBatchStatus): boolean {
  return !['COMMITTED', 'CANCELLED', 'FAILED'].includes(status);
}

export const STATUS_LABEL: Record<ImportBatchStatus, string> = {
  UPLOADED: 'Uploaded',
  MAPPED: 'Columns mapped',
  PARSED: 'Needs review',
  REVIEWED: 'Reviewed',
  DRY_RUN_READY: 'Ready to commit',
  COMMITTING: 'Committing',
  COMMITTED: 'Committed',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed',
};

/** Register field names as the register's Excel users know them. */
export const FIELD_LABEL: Record<CanopyField, string> = {
  externalRef: 'Compliance ID',
  title: 'Title',
  timelineType: 'Timeline type',
  description: 'Description',
  category: 'Category',
  applicabilityText: 'Applicability',
  act: 'Act',
  completedOn: 'Activity date',
  status: 'Status',
  dueDate: 'Due date',
  forms: 'Forms',
  logSheets: 'Log sheets',
  organizationPath: 'Organisation',
  locationPath: 'Location',
  owner: 'Owner',
  ownerComment: 'Owner comments',
  approver: 'Approver',
  department: 'Department',
  criticality: 'Criticality',
};

/** The "ignore this column" choice: a Select option can't carry null, and Radix Select refuses an empty value. */
export const IGNORE = 'ignore';

export const FIELD_OPTIONS: { value: string; label: string }[] = [
  { value: IGNORE, label: 'Ignore this column' },
  ...CanopyField.options.map((field) => ({ value: field, label: FIELD_LABEL[field] })),
];

/** Fields mapped from more than one column: the API would take only one of them. */
export function duplicateFields(mapping: ColumnMapping): CanopyField[] {
  const seen = new Map<CanopyField, number>();
  for (const { field } of mapping) if (field) seen.set(field, (seen.get(field) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([field]) => field);
}

/** The mapping from the form's values (one per source header, in order). */
export function mappingFromValues(
  headers: readonly string[],
  values: readonly string[],
): ColumnMapping {
  return headers.map((sourceHeader, i) => {
    const value = values[i] ?? IGNORE;
    const parsed = CanopyField.safeParse(value);
    return { sourceHeader, field: parsed.success ? parsed.data : null };
  });
}

/** What each kind of cleaning issue means, in the words the review screen uses. */
export const ISSUE_TITLE: Record<ImportIssueType, string> = {
  PERSON_CASE_MERGE: 'Names that differ only in capitals',
  PERSON_NEAR_MATCH: 'Names that look like the same person',
  ENUM_NORMALISED: 'Values written in a different case',
  UNKNOWN_ENUM: 'Values the register does not know',
  ALIAS_DEPARTMENT: 'Department names that look the same',
  ALIAS_CATEGORY: 'Category names that look the same',
  ALIAS_ACT: 'Act names that look the same',
  NULL_PLACEHOLDER: 'Placeholders for an empty cell',
  COMPLIED_WITHOUT_DATE: 'Complied rows without an activity date',
  DUPLICATE_PERIOD: 'Two rows for the same period',
  CONFLICTING_OBLIGATION_VALUE: 'Rows that disagree about an obligation',
  RULE_LOW_CONFIDENCE: 'Recurrence that needs a check',
  FILE_NOT_ATTACHED: 'Files named but not attached',
  UNPARSED_EXTERNAL_REF: 'Compliance IDs in an unusual format',
  INVALID_DATE: 'Dates that cannot be read',
  MISSING_REQUIRED: 'Required values that are missing',
};

export type IssueBucket = 'blocking' | 'decide' | 'decided' | 'info';

/** ERROR blocks the commit; a WARNING needs a decision; INFO is shown only (contracts IssueSeverity). */
export function issueBucket(group: Pick<ImportIssueGroup, 'severity' | 'decision'>): IssueBucket {
  if (group.severity === 'ERROR') return 'blocking';
  if (group.severity === 'INFO') return 'info';
  return group.decision === 'PENDING' ? 'decide' : 'decided';
}

export type IssueGroups = Record<IssueBucket, ImportIssueGroup[]>;

export function groupIssues(groups: readonly ImportIssueGroup[]): IssueGroups {
  const out: IssueGroups = { blocking: [], decide: [], decided: [], info: [] };
  for (const group of groups) out[issueBucket(group)].push(group);
  return out;
}

/** Groups still waiting on a WARNING decision, or an ERROR: either stops the commit. */
export function blockingCount(groups: IssueGroups): number {
  return groups.blocking.length + groups.decide.length;
}

/** Undecided groups the API proposed a value for, which "Accept every proposal" decides at once. */
export function acceptableKeys(groups: IssueGroups): string[] {
  return groups.decide.filter((g) => g.proposal !== null).map((g) => g.groupKey);
}

/** "Rows 3, 5 and 9" or "Rows 3, 5, 9 and 120 more". */
export function rowsText(rowNumbers: readonly number[], shown = 3): string {
  if (rowNumbers.length === 1) return `Row ${rowNumbers[0]}`;
  const head = rowNumbers.slice(0, shown);
  const rest = rowNumbers.length - head.length;
  if (rest === 0) return `Rows ${head.slice(0, -1).join(', ')} and ${head.at(-1)}`;
  return `Rows ${head.join(', ')} and ${rest} more`;
}

/** How a decided group reads: "Uses “Human Resources”", "Kept as written" or "Changed to “…”". */
export function decisionText(
  group: Pick<ImportIssueGroup, 'decision' | 'proposal' | 'editedValue'>,
) {
  switch (group.decision) {
    case 'ACCEPTED':
      return group.proposal === null ? 'Accepted' : `Uses “${group.proposal}”`;
    case 'EDITED':
      return `Changed to “${group.editedValue ?? ''}”`;
    case 'REJECTED':
      return 'Kept as written';
    case 'PENDING':
      return 'Not decided';
  }
}

export type DryRunLine = { label: string; count: number };

/** The dry-run report as lines for the summary, leaving out the zeros. */
export function dryRunLines(report: DryRunReport): {
  create: DryRunLine[];
  update: DryRunLine[];
  unchanged: number;
  skipped: number;
  blocking: number;
} {
  const create: [keyof DryRunReport['create'], string][] = [
    ['instances', 'Instances'],
    ['obligations', 'Obligations'],
    ['assignments', 'Assignments'],
    ['acts', 'Acts'],
    ['categories', 'Categories'],
    ['departments', 'Departments'],
    ['people', 'People'],
    ['companies', 'Companies'],
    ['units', 'Units'],
    ['locations', 'Locations'],
  ];
  const update: [keyof DryRunReport['update'], string][] = [
    ['instances', 'Instances'],
    ['obligations', 'Obligations'],
    ['assignments', 'Assignments'],
  ];
  return {
    create: create
      .map(([key, label]) => ({ label, count: report.create[key] }))
      .filter((l) => l.count > 0),
    update: update
      .map(([key, label]) => ({ label, count: report.update[key] }))
      .filter((l) => l.count > 0),
    unchanged: report.unchanged.instances,
    skipped: report.skippedRows,
    blocking: report.blockingErrors,
  };
}

/** The wizard's URL for a batch; `review` reopens the review from the dry run. */
export function batchHref(clientId: string, batchId: string, extra?: 'review' | 'parsing'): string {
  const query = new URLSearchParams({ batch: batchId });
  if (extra === 'review') query.set('step', 'review');
  if (extra === 'parsing') query.set('parsing', '1');
  return `/c/${clientId}/import?${query.toString()}`;
}

export type HistoryItem = {
  id: string;
  fileName: string;
  /** UTC timestamp; the table shows it in the client's time zone. */
  startedAt: string;
  status: string;
  rows: number | null;
  open: boolean;
  href: string;
};

/** The client's past and open imports, newest first as the API lists them. */
export function historyItems(
  clientId: string,
  batches: readonly Pick<ImportBatch, 'id' | 'fileName' | 'createdAt' | 'status' | 'counts'>[],
): HistoryItem[] {
  return batches.map((b) => ({
    id: b.id,
    fileName: b.fileName,
    startedAt: b.createdAt,
    status: STATUS_LABEL[b.status],
    rows: b.counts?.rows ?? null,
    open: isOpen(b.status),
    href: batchHref(clientId, b.id),
  }));
}
