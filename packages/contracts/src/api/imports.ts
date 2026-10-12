import { z } from 'zod';
import {
  CanopyField,
  ImportIssueType,
  ImportRowOutcome,
  IssueDecision,
  IssueSeverity,
} from '../enums.js';
import { Id, Instant, Name, Sha256, Text } from '../primitives.js';
import { ColumnMapping, ImportBatch } from '../schemas/import.js';
import { checkHasChanges, csv, MAX_IMPORT_BYTES, pageQueryShape, versionField } from './common.js';

/**
 * M8 · Import (docs/contracts/endpoints.md §5). Steps run in order, else `409 IMPORT_STATE`.
 * Every import endpoint is FIRM_ADMIN and CONSULTANT (own clients) only.
 */

const Workbook = Text.max(255).refine((name) => /\.xlsx?$/i.test(name), {
  message: 'Expected an .xlsx or .xls workbook',
});

/** Step 1: ask for an upload URL. The batch exists only once `/uploaded` confirms the bytes. */
export const ImportCreateBody = z.strictObject({
  fileName: Workbook,
  sizeBytes: z.int().min(1).max(MAX_IMPORT_BYTES),
});
export type ImportCreateBody = z.infer<typeof ImportCreateBody>;

/** `batchId` is the id the later steps use; `GET /imports/{id}` is 404 until `/uploaded`. */
export const ImportUploadTicket = z.strictObject({
  batchId: Id,
  url: z.url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: Instant,
});
export type ImportUploadTicket = z.infer<typeof ImportUploadTicket>;

/** Step 2: confirm the PUT. The server checks the stored bytes against `sha256`. */
export const ImportUploadedBody = z.strictObject({ sha256: Sha256 });
export type ImportUploadedBody = z.infer<typeof ImportUploadedBody>;

export const SheetPreview = z.strictObject({
  name: Text.max(255),
  /** Header row as read; blank headers are "" so positions line up. */
  headers: z.array(z.string()),
  rowCount: z.int().min(0),
});
export type SheetPreview = z.infer<typeof SheetPreview>;

export const ImportUploaded = z.strictObject({
  batch: ImportBatch,
  sheets: z.array(SheetPreview).min(1),
  /** Best guess for the first sheet: a matching template or header-name matching. */
  suggestedMapping: ColumnMapping.nullable(),
  suggestedTemplateId: Id.nullable(),
});
export type ImportUploaded = z.infer<typeof ImportUploaded>;

/** Step 3: choose the sheet and map its columns; optionally keep the mapping as a template. */
export const ImportMappingBody = z.strictObject({
  sheetName: Text.max(255),
  mapping: ColumnMapping,
  saveAsTemplate: z.strictObject({ name: Name, scope: z.enum(['CLIENT', 'FIRM']) }).optional(),
});
export type ImportMappingBody = z.infer<typeof ImportMappingBody>;

/** Issues sharing a groupKey (same type and proposal) are decided together. */
export const ImportIssueGroup = z.strictObject({
  groupKey: Text,
  type: ImportIssueType,
  severity: IssueSeverity,
  field: CanopyField.nullable(),
  rawValues: z.array(z.string()),
  proposal: z.string().nullable(),
  decision: IssueDecision,
  editedValue: z.string().nullable(),
  rowNumbers: z.array(z.int().min(2)).min(1),
  issueIds: z.array(Id).min(1),
});
export type ImportIssueGroup = z.infer<typeof ImportIssueGroup>;

export const ImportIssueQuery = z.strictObject({
  type: csv(ImportIssueType).optional(),
  severity: csv(IssueSeverity).optional(),
  decision: csv(IssueDecision).optional(),
});

export const ImportIssueGroupParams = z.strictObject({ id: Id, groupKey: Text.max(500) });

/** A decision; `editedValue` exactly when EDITED. Decisions cannot go back to PENDING. */
export const ImportIssueDecisionBody = z
  .strictObject({
    decision: IssueDecision.exclude(['PENDING']),
    editedValue: z.string().optional(),
  })
  .refine((body) => (body.decision === 'EDITED') === (body.editedValue !== undefined), {
    path: ['editedValue'],
    message: 'editedValue is sent exactly when the decision is EDITED',
  });
export type ImportIssueDecisionBody = z.infer<typeof ImportIssueDecisionBody>;

export const ImportRowQuery = z.strictObject({
  ...pageQueryShape,
  outcome: csv(ImportRowOutcome).optional(),
  issueType: csv(ImportIssueType).optional(),
});

export const ImportListQuery = z.strictObject({ ...pageQueryShape });

export const MappingTemplateListQuery = z.strictObject({ ...pageQueryShape });

/** `scope: FIRM` makes a firm-wide template (clientId null). */
export const MappingTemplateCreateBody = z.strictObject({
  name: Name,
  mapping: ColumnMapping,
  scope: z.enum(['CLIENT', 'FIRM']),
});
export type MappingTemplateCreateBody = z.infer<typeof MappingTemplateCreateBody>;

export const MappingTemplateUpdateBody = z
  .strictObject({ ...versionField, name: Name.optional(), mapping: ColumnMapping.optional() })
  .superRefine(checkHasChanges);
export type MappingTemplateUpdateBody = z.infer<typeof MappingTemplateUpdateBody>;
