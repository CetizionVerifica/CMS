import { z } from 'zod';
import {
  CanopyField,
  IMPORT_ISSUE_SEVERITY,
  ImportBatchStatus,
  ImportIssueType,
  ImportRowOutcome,
  IssueDecision,
  IssueSeverity,
} from '../enums.js';
import { baseShape, Id, Instant, Name, Sha256, Text, versionedShape } from '../primitives.js';

/** Excel import (docs/contracts/domain-model.md §6). Import rows hold personal data and are never logged. */

/** Source header to field; `field: null` means the column is ignored. */
export const ColumnMapping = z.array(
  z.strictObject({ sourceHeader: Text, field: CanopyField.nullable() }),
);
export type ColumnMapping = z.infer<typeof ColumnMapping>;

const count = z.int().min(0);

export const DryRunReport = z.strictObject({
  create: z.strictObject({
    acts: count,
    categories: count,
    departments: count,
    people: count,
    obligations: count,
    assignments: count,
    instances: count,
    companies: count,
    units: count,
    locations: count,
  }),
  update: z.strictObject({ obligations: count, assignments: count, instances: count }),
  unchanged: z.strictObject({ instances: count }),
  skippedRows: count,
  blockingErrors: count,
});
export type DryRunReport = z.infer<typeof DryRunReport>;

export const ImportBatch = z.strictObject({
  ...baseShape,
  ...versionedShape,
  clientId: Id,
  createdById: Id,
  status: ImportBatchStatus,
  fileName: Text.max(255),
  fileSha256: Sha256,
  sheetName: Text.max(255).nullable(),
  mapping: ColumnMapping.nullable(),
  mappingTemplateId: Id.nullable(),
  counts: z.strictObject({ rows: count, errors: count, warnings: count, infos: count }).nullable(),
  dryRun: DryRunReport.nullable(),
  committedAt: Instant.nullable(),
  failureCode: Text.max(100).nullable(),
});
export type ImportBatch = z.infer<typeof ImportBatch>;

export const MappingTemplate = z.strictObject({
  ...baseShape,
  ...versionedShape,
  /** Null = firm-wide template. */
  clientId: Id.nullable(),
  name: Name,
  mapping: ColumnMapping,
});
export type MappingTemplate = z.infer<typeof MappingTemplate>;

/** First data row; the header is row 1. */
const DataRowNumber = z.int().min(2);

/** One per source row. Holds personal data: never logged. */
export const ImportRow = z.strictObject({
  id: Id,
  batchId: Id,
  rowNumber: DataRowNumber,
  /** The source cells exactly as read, keyed by header. Kept beside the cleaned values. */
  raw: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  mapped: z.partialRecord(CanopyField, z.string().nullable()).nullable(),
  issueIds: z.array(Id),
  outcome: ImportRowOutcome,
  targetInstanceId: Id.nullable(),
});
export type ImportRow = z.infer<typeof ImportRow>;

/** Issues with the same type and proposal share a groupKey and are decided once. */
export const ImportIssue = z
  .strictObject({
    id: Id,
    batchId: Id,
    groupKey: Text,
    type: ImportIssueType,
    severity: IssueSeverity,
    rowNumbers: z.array(DataRowNumber).min(1),
    field: CanopyField.nullable(),
    /** e.g. ["HR", "Human Resources"]. */
    rawValues: z.array(z.string()),
    /** e.g. "Human Resources". Null when the user must decide. */
    proposal: z.string().nullable(),
    decision: IssueDecision,
    editedValue: z.string().nullable(),
  })
  .superRefine((issue, ctx) => {
    if (issue.severity !== IMPORT_ISSUE_SEVERITY[issue.type]) {
      ctx.addIssue({
        code: 'custom',
        path: ['severity'],
        message: `${issue.type} has severity ${IMPORT_ISSUE_SEVERITY[issue.type]}`,
      });
    }
    if ((issue.decision === 'EDITED') !== (issue.editedValue !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['editedValue'],
        message: 'editedValue is set exactly when EDITED',
      });
    }
  });
export type ImportIssue = z.infer<typeof ImportIssue>;
