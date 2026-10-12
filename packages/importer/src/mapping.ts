import type { CanopyField, ColumnMapping } from '@canopy/contracts';
import { looseKey } from './text.js';

/** Column mapping: which source header feeds which Canopy field. */

/**
 * Known headers per field, matched after `looseKey` (case and punctuation ignored). The first entry of each
 * list is the sample register's own header, so those 19 headers map one to one.
 */
export const KNOWN_HEADERS: Record<CanopyField, readonly string[]> = {
  externalRef: ['EY Compliance ID', 'Compliance ID', 'Compliance Ref', 'Reference', 'Ref', 'ID'],
  title: ['Compliance Title', 'Title', 'Obligation', 'Compliance'],
  timelineType: ['Type (TimeLine)', 'Timeline Type', 'Timeline', 'Type'],
  description: ['Compliance Description', 'Description', 'Details'],
  category: [
    'Compliance Categorization',
    'Compliance Categorisation',
    'Categorization',
    'Category',
  ],
  applicabilityText: ['Applicability', 'Applicable To'],
  act: ['Act', 'Act Name', 'Law', 'Legislation'],
  completedOn: ['Activity Date', 'Completed On', 'Completion Date', 'Date of Compliance'],
  status: ['Compliance Status', 'Status'],
  dueDate: ['Due Date', 'Due On', 'Deadline'],
  forms: ['Form Description', 'Forms', 'Form'],
  logSheets: ['Log Sheet Description', 'Log Sheets', 'Log Sheet'],
  organizationPath: ['Organization', 'Organisation', 'Entity'],
  locationPath: ['Location', 'Site Location'],
  owner: ['Owner', 'Owner Name', 'Responsible'],
  ownerComment: ['Owner Comments', 'Owner Comment', 'Comments', 'Remarks'],
  approver: ['Approvers', 'Approver', 'Approver Name', 'Reviewer'],
  department: ['Department', 'Dept', 'Function'],
  criticality: ['Criticality', 'Risk', 'Risk Rating'],
};

/** Fields an import cannot do without. */
export const REQUIRED_FIELDS: readonly CanopyField[] = [
  'title',
  'timelineType',
  'description',
  'category',
  'act',
  'status',
  'dueDate',
  'organizationPath',
  'locationPath',
  'owner',
  'approver',
  'department',
  'criticality',
];

const FIELD_ORDER = Object.keys(KNOWN_HEADERS) as CanopyField[];

/**
 * Proposes a mapping for the given headers. A saved template wins for the headers it names; the rest are
 * matched against KNOWN_HEADERS. Each field is used at most once; unmatched headers map to null (ignored).
 */
export function suggestMapping(
  headers: readonly string[],
  template?: ColumnMapping,
): ColumnMapping {
  const used = new Set<CanopyField>();
  const fromTemplate = new Map<string, CanopyField | null>();
  for (const entry of template ?? []) {
    fromTemplate.set(looseKey(entry.sourceHeader), entry.field);
  }
  const result = headers.map((sourceHeader) => {
    const key = looseKey(sourceHeader);
    if (fromTemplate.has(key)) {
      const field = fromTemplate.get(key) ?? null;
      if (field !== null && used.has(field)) return { sourceHeader, field: null };
      if (field !== null) used.add(field);
      return { sourceHeader, field, decided: true };
    }
    return { sourceHeader, field: null as CanopyField | null, decided: false };
  });
  // Match pass: earlier entries in a field's list are stronger, so try rank 0 for every header first.
  const maxRank = Math.max(...FIELD_ORDER.map((field) => KNOWN_HEADERS[field].length));
  for (let rank = 0; rank < maxRank; rank++) {
    for (const entry of result) {
      if (entry.decided || entry.field !== null) continue;
      const key = looseKey(entry.sourceHeader);
      const field = FIELD_ORDER.find(
        (f) => !used.has(f) && looseKey(KNOWN_HEADERS[f][rank] ?? '\u0000') === key,
      );
      if (field) {
        entry.field = field;
        used.add(field);
      }
    }
  }
  return result.map(({ sourceHeader, field }) => ({ sourceHeader, field }));
}

export interface MappingProblem {
  kind: 'UNKNOWN_HEADER' | 'DUPLICATE_FIELD' | 'MISSING_REQUIRED_FIELD';
  /** The header or field the problem is about. */
  subject: string;
}

/** Checks a mapping against the sheet's headers before parsing. An empty list means it can be used. */
export function validateMapping(
  mapping: ColumnMapping,
  headers: readonly string[],
): MappingProblem[] {
  const problems: MappingProblem[] = [];
  const headerSet = new Set(headers);
  const seen = new Set<CanopyField>();
  for (const { sourceHeader, field } of mapping) {
    if (!headerSet.has(sourceHeader))
      problems.push({ kind: 'UNKNOWN_HEADER', subject: sourceHeader });
    if (field === null) continue;
    if (seen.has(field)) problems.push({ kind: 'DUPLICATE_FIELD', subject: field });
    seen.add(field);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!seen.has(field)) problems.push({ kind: 'MISSING_REQUIRED_FIELD', subject: field });
  }
  return problems;
}
