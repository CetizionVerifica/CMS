import {
  IMPORT_ISSUE_SEVERITY,
  type CanopyField,
  type ImportIssueType,
  type IssueDecision,
} from '@canopy/contracts';
import { readDate } from './dates.js';
import { splitLocation, splitOrganization } from './paths.js';
import { CRITICALITY, enumKey, STATUS, TIMELINE, type EnumTable } from './reference.js';
import type { Decision, Decisions, DraftIssue } from './types.js';

/** Rules for review decisions (domain-model.md §6). The API validates every PATCH with `checkDecision`. */

const EDITABLE: ReadonlySet<ImportIssueType> = new Set([
  'ALIAS_ACT',
  'ALIAS_CATEGORY',
  'ALIAS_DEPARTMENT',
  'PERSON_NEAR_MATCH',
  'COMPLIED_WITHOUT_DATE',
  'UNKNOWN_ENUM',
  'INVALID_DATE',
  'MISSING_REQUIRED',
]);

const DATE_FIELDS: ReadonlySet<CanopyField> = new Set(['dueDate', 'completedOn']);

export const ENUM_TABLES: Partial<Record<CanopyField, EnumTable<string>>> = {
  criticality: CRITICALITY,
  timelineType: TIMELINE,
  status: STATUS,
};

type IssueShape = Pick<DraftIssue, 'type' | 'field' | 'proposal' | 'rawValues'>;

/** Null when `decision` may be stored for the issue, else the reason it may not. */
export function checkDecision(
  issue: IssueShape,
  decision: IssueDecision,
  editedValue: string | null,
): string | null {
  const severity = IMPORT_ISSUE_SEVERITY[issue.type];
  if (severity === 'INFO') {
    return decision === 'ACCEPTED' && editedValue === null
      ? null
      : 'Information issues are shown only and stay accepted';
  }
  if ((decision === 'EDITED') !== (editedValue !== null)) {
    return 'editedValue is set exactly when the decision is EDITED';
  }
  switch (decision) {
    case 'PENDING':
      return null;
    case 'ACCEPTED':
      return issue.proposal === null
        ? 'This issue has no proposal to accept; edit it instead'
        : null;
    case 'REJECTED':
      return issue.type === 'RULE_LOW_CONFIDENCE'
        ? 'The inferred rule is imported for review; confirm or change it after the import'
        : null;
    case 'EDITED':
      return checkEdit(issue, editedValue ?? '');
  }
}

function checkEdit(issue: IssueShape, value: string): string | null {
  if (!EDITABLE.has(issue.type)) return `${issue.type} cannot be edited`;
  if (value.trim() === '') return 'editedValue cannot be blank';
  if (issue.type === 'PERSON_NEAR_MATCH' && !issue.rawValues.includes(value)) {
    return 'Choose one of the two names to merge into';
  }
  const isDateField = issue.field !== null && DATE_FIELDS.has(issue.field);
  if (
    (issue.type === 'COMPLIED_WITHOUT_DATE' || issue.type === 'INVALID_DATE' || isDateField) &&
    readDate(value).kind !== 'date'
  ) {
    return 'Expected a date';
  }
  // An edit to a field with a fixed form must parse, or the row would still be unusable after review.
  const table = issue.field === null ? undefined : ENUM_TABLES[issue.field];
  if (table && !(enumKey(value) in table.byKey)) {
    return `Expected one of: ${table.canonical.join(', ')}`;
  }
  if (issue.field === 'organizationPath' && splitOrganization(value) === null) {
    return 'Expected a path ending in "Company/ Unit"';
  }
  if (issue.field === 'locationPath' && splitLocation(value) === null) {
    return 'Expected "Country/ State/ City" with a known country';
  }
  return null;
}

/** The decision in force for an issue: INFO is always accepted; an invalid stored decision counts as PENDING. */
export function decisionFor(
  issue: IssueShape & { groupKey: string },
  decisions: Decisions,
): Decision {
  if (IMPORT_ISSUE_SEVERITY[issue.type] === 'INFO')
    return { decision: 'ACCEPTED', editedValue: null };
  const stored = decisions[issue.groupKey];
  if (!stored || checkDecision(issue, stored.decision, stored.editedValue) !== null) {
    return { decision: 'PENDING', editedValue: null };
  }
  return stored;
}

/**
 * The "recommended" profile (docs/contracts/fixtures.md §3): every WARNING with a proposal accepted, every
 * WARNING without one rejected (kept apart). ERROR issues stay PENDING: they always need a person.
 */
export function recommendedDecisions(issues: readonly DraftIssue[]): Decisions {
  const out: Decisions = {};
  for (const issue of issues) {
    if (issue.severity !== 'WARNING') continue;
    out[issue.groupKey] = {
      decision: issue.proposal === null ? 'REJECTED' : 'ACCEPTED',
      editedValue: null,
    };
  }
  return out;
}

/** True when nothing is left for a person to decide (the batch can move to REVIEWED). */
export function isReviewed(issues: readonly DraftIssue[]): boolean {
  return issues.every((issue) => issue.decision !== 'PENDING');
}
