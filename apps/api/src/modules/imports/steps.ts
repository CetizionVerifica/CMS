import { createHash } from 'node:crypto';
import {
  type Action,
  type ColumnMapping,
  type EngineCalendar,
  type ImportBatch,
  type ImportBatchStatus,
  type ImportIssue,
  type ImportRow,
  type InferredRule,
  type MappingTemplate,
  type RequestContext,
  type Resource,
  MAX_IMPORT_BYTES,
  SIGNED_URL_TTL_SECONDS,
} from '@canopy/contracts';
import type {
  ImportCreateBody,
  ImportIssueDecisionBody,
  ImportIssueGroup,
  ImportMappingBody,
  ImportUploaded,
  ImportUploadedBody,
  ImportUploadTicket,
  MappingTemplateCreateBody,
  MappingTemplateUpdateBody,
} from '@canopy/contracts';
import { DbError, tenantFromRequest, uuidv7, type TenantContext } from '@canopy/db';
import {
  analyseImport,
  checkDecision,
  fileFormatOf,
  firstNonEmptySheet,
  ImportFileError,
  isReviewed,
  readWorkbook,
  suggestMapping,
  validateMapping,
  type Decisions,
  type DraftIssue,
  type ImportAnalysis,
  type InferRule,
  type SourceSheet,
  type SourceWorkbook,
} from '@canopy/importer';
import { ApiError, requireClient } from '../../auth/index.js';
import { uploadKey, type ImportFiles } from './files.js';
import type { ImportStore, ImportTx, NewIssue, Page } from './store.js';

/**
 * M8 import steps (docs/contracts/endpoints.md §5). The importer package does the work; this module stores
 * batches, enforces the step order and runs parse off-request. Rows, issues and workbooks hold employee names:
 * nothing here logs them, and errors carry codes and column titles only.
 */

/** The caller of a step: the request context and the M5 permission check for it. */
export interface Actor {
  readonly ctx: RequestContext;
  /** Throws FORBIDDEN (or MFA_REQUIRED) unless the actor may do `action` on `resource`. */
  readonly authorize: (action: Action, resource: Resource) => void;
}

export interface ImportStepsOptions {
  readonly store: ImportStore;
  readonly files: ImportFiles;
  /** The engine's `inferRule` (with its `coverage` option). */
  readonly inferRule: InferRule;
  readonly clock?: () => Date;
  /** Runs parse after the response. Default: on a later tick. Tests pass one they can await. */
  readonly runInBackground?: (task: () => Promise<void>) => void;
  /** Called when a background parse fails, with the batch id. Never pass row data to a logger. */
  readonly onBackgroundError?: (error: unknown, batchId: string) => void;
}

/** Only .xlsx can be uploaded (contract `ImportCreateBody`); .xls is accepted by the schema but unreadable. */
const ALLOWED_FILES = ['.xlsx'];

const BEFORE_COMMIT: readonly ImportBatchStatus[] = [
  'UPLOADED',
  'MAPPED',
  'PARSED',
  'REVIEWED',
  'DRY_RUN_READY',
  'FAILED',
];
const REVIEWABLE: readonly ImportBatchStatus[] = ['PARSED', 'REVIEWED', 'DRY_RUN_READY'];

/** inferRule costs milliseconds and review re-runs the analysis, so results are kept across runs. */
const INFER_CACHE_MAX = 50_000;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireStatus(batch: ImportBatch, expected: readonly ImportBatchStatus[]): void {
  if (!expected.includes(batch.status)) {
    throw new ApiError('IMPORT_STATE', { status: batch.status, expected: [...expected] });
  }
}

function validation(path: (string | number)[], message: string): ApiError {
  return new ApiError('VALIDATION', { issues: [{ path, message }] });
}

/** DbError codes are contract codes; anything else is rethrown unchanged. */
export function fromDbError(error: unknown): unknown {
  return error instanceof DbError ? new ApiError(error.code) : error;
}

function fileError(error: unknown): unknown {
  if (!(error instanceof ImportFileError)) return error;
  return error.code === 'FILE_TOO_LARGE'
    ? new ApiError('FILE_TOO_LARGE', { maxBytes: MAX_IMPORT_BYTES })
    : new ApiError('UNSUPPORTED_FILE', { allowed: ALLOWED_FILES });
}

/** Issues stored one per group; the API shows them as groups. */
function toGroups(issues: readonly ImportIssue[]): ImportIssueGroup[] {
  const groups = new Map<string, ImportIssueGroup>();
  for (const issue of issues) {
    const group = groups.get(issue.groupKey);
    if (group) {
      group.issueIds.push(issue.id);
      group.rowNumbers = [...new Set([...group.rowNumbers, ...issue.rowNumbers])].sort(
        (a, b) => a - b,
      );
      continue;
    }
    groups.set(issue.groupKey, {
      groupKey: issue.groupKey,
      type: issue.type,
      severity: issue.severity,
      field: issue.field,
      rawValues: issue.rawValues,
      proposal: issue.proposal,
      decision: issue.decision,
      editedValue: issue.editedValue,
      rowNumbers: [...issue.rowNumbers],
      issueIds: [issue.id],
    });
  }
  return [...groups.values()];
}

function decisionsOf(issues: readonly ImportIssue[]): Decisions {
  const out: Decisions = {};
  for (const issue of issues) {
    if (issue.decision !== 'PENDING') {
      out[issue.groupKey] = { decision: issue.decision, editedValue: issue.editedValue };
    }
  }
  return out;
}

/** What makes two versions of an issue group the same, apart from its decision. */
function shapeOf(issue: Omit<DraftIssue, 'decision' | 'editedValue'>): string {
  return JSON.stringify([
    issue.type,
    issue.severity,
    issue.field,
    issue.rawValues,
    issue.proposal,
    issue.rowNumbers,
  ]);
}

export class ImportSteps {
  private readonly clock: () => Date;
  private readonly runInBackground: (task: () => Promise<void>) => void;
  private readonly parsing = new Set<string>();
  private readonly inferCache = new Map<string, InferredRule>();

  constructor(private readonly options: ImportStepsOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.runInBackground =
      options.runInBackground ??
      ((task) => {
        setImmediate(() => void task());
      });
  }

  // ---------- steps ----------

  /** Step 1: an upload ticket. The batch id is generated here and exists as a batch only after step 2. */
  async start(actor: Actor, clientId: string, body: ImportCreateBody): Promise<ImportUploadTicket> {
    actor.authorize('import.create', { type: 'import_batch', clientId });
    if (fileFormatOf(body.fileName) !== 'xlsx') {
      throw new ApiError('UNSUPPORTED_FILE', { allowed: ALLOWED_FILES });
    }
    const batchId = uuidv7(this.clock().getTime());
    const ticket = await this.options.files.presignPut({
      key: uploadKey(actor.ctx.firmId, batchId),
      sizeBytes: body.sizeBytes,
      meta: { clientId, createdById: actor.ctx.personId, fileName: body.fileName },
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    });
    const expiresAt = new Date(this.clock().getTime() + SIGNED_URL_TTL_SECONDS * 1000);
    return {
      batchId,
      url: ticket.url,
      headers: ticket.headers,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Step 2: the bytes are in storage. Creates the batch under the ticket's id (only a ticket this API issued
   * has an object at that key) and returns the sheets with a suggested mapping.
   */
  async uploaded(actor: Actor, id: string, body: ImportUploadedBody): Promise<ImportUploaded> {
    const upload = await this.options.files.read(uploadKey(actor.ctx.firmId, id), MAX_IMPORT_BYTES);
    if (!upload) throw new ApiError('NOT_FOUND');
    const { clientId, createdById, fileName } = upload.meta;
    requireClient(actor.ctx, clientId);
    actor.authorize('import.write', { type: 'import_batch', clientId });
    const fileSha256 = sha256(upload.bytes);
    if (fileSha256 !== body.sha256) {
      throw validation(['sha256'], 'The uploaded file does not match this checksum');
    }
    const workbook = await readWorkbook(upload.bytes, fileName).catch((e: unknown) => {
      throw fileError(e);
    });
    if (workbook.sheets.length === 0) {
      throw new ApiError('UNSUPPORTED_FILE', { allowed: ALLOWED_FILES });
    }

    return this.transaction(actor, async (tx) => {
      let batch = await tx.getBatch(id);
      if (batch) {
        requireStatus(batch, ['UPLOADED']);
      } else {
        batch = await tx.createBatch({
          id,
          clientId,
          createdById,
          status: 'UPLOADED',
          fileName,
          fileSha256,
          sheetName: null,
          mapping: null,
          mappingTemplateId: null,
          counts: null,
          dryRun: null,
          committedAt: null,
          failureCode: null,
        });
      }
      const first = firstNonEmptySheet(workbook);
      const template = first ? bestTemplate(await tx.templatesFor(clientId), first.headers) : null;
      return {
        batch,
        sheets: workbook.sheets.map((sheet, index) => ({
          name: sheetName(sheet, index),
          headers: sheet.headers,
          rowCount: sheet.rows.length,
        })),
        suggestedMapping: first ? suggestMapping(first.headers, template?.mapping) : null,
        suggestedTemplateId: template?.id ?? null,
      };
    });
  }

  /** Step 3: the sheet and its column mapping; optionally saved as a template. Allowed again until parse. */
  async setMapping(actor: Actor, id: string, body: ImportMappingBody): Promise<ImportBatch> {
    const batch = await this.transaction(actor, (tx) =>
      this.loadBatch(tx, actor, id, 'import.write'),
    );
    requireStatus(batch, ['UPLOADED', 'MAPPED']);
    const sheet = this.findSheet(await this.readUpload(batch), body.sheetName);
    const problems = validateMapping(body.mapping, sheet.headers);
    if (problems.length > 0) {
      throw new ApiError('VALIDATION', {
        issues: problems.map((p) => ({ path: ['mapping'], message: `${p.kind}: ${p.subject}` })),
      });
    }
    return this.transaction(actor, async (tx) => {
      const current = await this.loadBatch(tx, actor, id, 'import.write');
      requireStatus(current, ['UPLOADED', 'MAPPED']);
      let mappingTemplateId: string | null = null;
      if (body.saveAsTemplate) {
        const templateClient = body.saveAsTemplate.scope === 'FIRM' ? null : current.clientId;
        actor.authorize('import.write', { type: 'import_batch', clientId: templateClient });
        const template = await tx.createTemplate({
          clientId: templateClient,
          name: body.saveAsTemplate.name,
          mapping: body.mapping,
        });
        mappingTemplateId = template.id;
      }
      return tx.updateBatch(current.id, current.version, {
        status: 'MAPPED',
        sheetName: body.sheetName,
        mapping: body.mapping,
        mappingTemplateId,
      });
    });
  }

  /** Step 4: parse and clean off-request. The batch stays MAPPED until the background run stores the result. */
  async parse(actor: Actor, id: string): Promise<ImportBatch> {
    const batch = await this.transaction(actor, (tx) =>
      this.loadBatch(tx, actor, id, 'import.write'),
    );
    requireStatus(batch, ['MAPPED']);
    if (!this.parsing.has(batch.id)) {
      this.parsing.add(batch.id);
      const tenant = tenantFromRequest(actor.ctx);
      this.runInBackground(() => this.runParse(tenant, batch));
    }
    return batch;
  }

  async get(actor: Actor, id: string): Promise<ImportBatch> {
    return this.transaction(actor, (tx) => this.loadBatch(tx, actor, id, 'import.read'));
  }

  async issues(
    actor: Actor,
    id: string,
    query: { type?: string[]; severity?: string[]; decision?: string[] },
  ): Promise<{ items: ImportIssueGroup[] }> {
    const issues = await this.transaction(actor, async (tx) => {
      await this.loadBatch(tx, actor, id, 'import.read');
      return tx.issues(id);
    });
    const keep = (value: string, filter?: string[]) => !filter || filter.includes(value);
    return {
      items: toGroups(issues).filter(
        (g) =>
          keep(g.type, query.type) &&
          keep(g.severity, query.severity) &&
          keep(g.decision, query.decision),
      ),
    };
  }

  /**
   * Decides one issue group, then re-runs the analysis with every stored decision: a decision can add or
   * remove other issues (a rejected alias leaves two departments apart, so a duplicate period goes away).
   * The batch is REVIEWED once nothing is PENDING; a stored dry run is dropped.
   */
  async decide(
    actor: Actor,
    id: string,
    groupKey: string,
    body: ImportIssueDecisionBody,
  ): Promise<ImportIssueGroup> {
    return this.transaction(actor, async (tx) => {
      const batch = await this.loadBatch(tx, actor, id, 'import.write');
      requireStatus(batch, REVIEWABLE);
      const stored = await tx.issues(id);
      const group = stored.find((i) => i.groupKey === groupKey);
      if (!group) throw new ApiError('NOT_FOUND');
      const editedValue = body.editedValue ?? null;
      const problem = checkDecision(group, body.decision, editedValue);
      if (problem) throw validation(['decision'], problem);
      await tx.decideGroup(id, groupKey, body.decision, editedValue);

      const decisions = {
        ...decisionsOf(stored),
        [groupKey]: { decision: body.decision, editedValue },
      };
      const rows = await allRows(tx, id);
      const analysis = await this.analyse(tx, batch, sheetFromRows(batch, rows), decisions);
      const issues = await this.reconcile(tx, batch, rows, stored, analysis);
      await tx.updateBatch(batch.id, batch.version, {
        status: isReviewed(analysis.issues) ? 'REVIEWED' : 'PARSED',
        counts: analysis.counts,
        dryRun: null,
      });
      const decided = toGroups(issues).find((g) => g.groupKey === groupKey);
      // A decision never removes its own group (its key does not depend on the decision).
      /* v8 ignore next */
      if (!decided) throw new ApiError('NOT_FOUND');
      return decided;
    });
  }

  async rows(
    actor: Actor,
    id: string,
    query: { limit?: number; cursor?: string; outcome?: string[]; issueType?: string[] },
  ): Promise<Page<ImportRow>> {
    const limit = Math.min(query.limit ?? 50, 200);
    const after = query.cursor === undefined ? undefined : Number(query.cursor);
    if (after !== undefined && !Number.isInteger(after)) {
      throw validation(['cursor'], 'Invalid cursor');
    }
    return this.transaction(actor, async (tx) => {
      await this.loadBatch(tx, actor, id, 'import.read');
      const typeOf = new Map((await tx.issues(id)).map((i) => [i.id, i.type]));
      const matches = (row: ImportRow) =>
        (!query.outcome || query.outcome.includes(row.outcome)) &&
        (!query.issueType ||
          row.issueIds.some((i) => query.issueType?.includes(typeOf.get(i) ?? '')));
      const items: ImportRow[] = [];
      let afterRowNumber = after;
      for (;;) {
        const page = await tx.rows(id, { limit, afterRowNumber });
        for (const row of page.items) {
          if (!matches(row)) continue;
          items.push(row);
          if (items.length === limit) {
            const more = row !== page.items.at(-1) || page.nextCursor !== null;
            return { items, nextCursor: more ? String(row.rowNumber) : null };
          }
        }
        if (page.nextCursor === null) return { items, nextCursor: null };
        afterRowNumber = Number(page.nextCursor);
      }
    });
  }

  async cancel(actor: Actor, id: string): Promise<ImportBatch> {
    return this.transaction(actor, async (tx) => {
      const batch = await this.loadBatch(tx, actor, id, 'import.write');
      requireStatus(batch, BEFORE_COMMIT);
      return tx.updateBatch(batch.id, batch.version, { status: 'CANCELLED' });
    });
  }

  async history(
    actor: Actor,
    clientId: string,
    query: { limit?: number; cursor?: string },
  ): Promise<Page<ImportBatch>> {
    actor.authorize('import.read', { type: 'import_batch', clientId });
    return this.transaction(actor, (tx) => tx.listBatches(clientId, query));
  }

  // ---------- mapping templates ----------

  async templates(
    actor: Actor,
    clientId: string,
    query: { limit?: number; cursor?: string },
  ): Promise<Page<MappingTemplate>> {
    actor.authorize('import.read', { type: 'import_batch', clientId });
    const all = await this.transaction(actor, (tx) => tx.templatesFor(clientId));
    const sorted = all
      .filter((t) => query.cursor === undefined || t.id > query.cursor)
      .sort((a, b) => a.id.localeCompare(b.id));
    const limit = Math.min(query.limit ?? 50, 200);
    const items = sorted.slice(0, limit);
    return { items, nextCursor: sorted.length > limit ? (items.at(-1)?.id ?? null) : null };
  }

  async createTemplate(
    actor: Actor,
    clientId: string,
    body: MappingTemplateCreateBody,
  ): Promise<MappingTemplate> {
    const templateClient = body.scope === 'FIRM' ? null : clientId;
    actor.authorize('import.write', { type: 'import_batch', clientId });
    actor.authorize('import.write', { type: 'import_batch', clientId: templateClient });
    return this.transaction(actor, (tx) =>
      tx.createTemplate({ clientId: templateClient, name: body.name, mapping: body.mapping }),
    );
  }

  async updateTemplate(
    actor: Actor,
    id: string,
    body: MappingTemplateUpdateBody,
  ): Promise<MappingTemplate> {
    return this.transaction(actor, async (tx) => {
      const template = await tx.getTemplate(id);
      if (!template) throw new ApiError('NOT_FOUND');
      if (template.clientId !== null) requireClient(actor.ctx, template.clientId);
      actor.authorize('import.write', { type: 'import_batch', clientId: template.clientId });
      const { version, ...patch } = body;
      return tx.updateTemplate(id, version, patch);
    });
  }

  // ---------- internals ----------

  private transaction<T>(actor: Actor | TenantContext, fn: (tx: ImportTx) => Promise<T>) {
    const tenant = 'ctx' in actor ? tenantFromRequest(actor.ctx) : actor;
    return this.options.store.transaction(tenant, fn).catch((error: unknown) => {
      throw fromDbError(error);
    });
  }

  /** The batch, if the actor may see it and do `action` on it; NOT_FOUND otherwise. */
  private async loadBatch(
    tx: ImportTx,
    actor: Actor,
    id: string,
    action: Action,
  ): Promise<ImportBatch> {
    const batch = await tx.getBatch(id);
    if (!batch) throw new ApiError('NOT_FOUND');
    requireClient(actor.ctx, batch.clientId);
    actor.authorize(action, { type: 'import_batch', clientId: batch.clientId });
    return batch;
  }

  private async readUpload(batch: ImportBatch): Promise<SourceWorkbook> {
    const upload = await this.options.files.read(
      uploadKey(batch.firmId, batch.id),
      MAX_IMPORT_BYTES,
    );
    // Storage lost the file after step 2; the batch cannot go on.
    if (!upload) throw new ApiError('NOT_FOUND');
    return readWorkbook(upload.bytes, batch.fileName).catch((e: unknown) => {
      throw fileError(e);
    });
  }

  private findSheet(workbook: SourceWorkbook, name: string): SourceSheet {
    const sheet = workbook.sheets.find((s, index) => sheetName(s, index) === name);
    if (!sheet) throw validation(['sheetName'], 'The workbook has no sheet with this name');
    return sheet;
  }

  private memoInferRule(): InferRule {
    return (dates, timelineType, cal, options) => {
      const key = JSON.stringify([cal, options?.coverage ?? null, timelineType, dates]);
      let result = this.inferCache.get(key);
      if (!result) {
        result = this.options.inferRule(dates, timelineType, cal, options);
        if (this.inferCache.size >= INFER_CACHE_MAX) this.inferCache.clear();
        this.inferCache.set(key, result);
      }
      return result;
    };
  }

  private async analyse(
    tx: ImportTx,
    batch: ImportBatch,
    sheet: SourceSheet,
    decisions: Decisions,
  ): Promise<ImportAnalysis> {
    const calendar: EngineCalendar = await tx.calendar(batch.clientId);
    return analyseImport({
      sheet,
      mapping: batch.mapping ?? [],
      existing: await tx.existingState(batch.clientId),
      decisions,
      inferRule: this.memoInferRule(),
      calendar,
    });
  }

  /** The background half of step 4. Stores rows and issues only if the batch is unchanged since step 4. */
  private async runParse(tenant: TenantContext, batch: ImportBatch): Promise<void> {
    try {
      const sheet = this.findSheet(await this.readUpload(batch), batch.sheetName ?? '');
      await this.transaction(tenant, async (tx) => {
        const current = await tx.getBatch(batch.id);
        if (!current || current.version !== batch.version || current.status !== 'MAPPED') return;
        const analysis = await this.analyse(tx, current, sheet, {});
        const issues = await tx.addIssues(
          batch.id,
          analysis.issues.map((issue): NewIssue => ({ ...issue, batchId: batch.id })),
        );
        const idOf = new Map(issues.map((i) => [i.groupKey, i.id]));
        await tx.addRows(
          batch.id,
          analysis.rows.map((row) => ({
            batchId: batch.id,
            rowNumber: row.rowNumber,
            raw: row.raw,
            mapped: row.mapped,
            issueIds: row.issueGroupKeys.map((k) => idOf.get(k)).filter((i) => i !== undefined),
            outcome: row.outcome,
          })),
        );
        await tx.updateBatch(current.id, current.version, {
          status: isReviewed(analysis.issues) ? 'REVIEWED' : 'PARSED',
          counts: analysis.counts,
        });
      });
    } catch (error) {
      this.options.onBackgroundError?.(error, batch.id);
      const failureCode =
        error instanceof ApiError ? error.code : error instanceof DbError ? error.code : 'INTERNAL';
      await this.transaction(tenant, async (tx) => {
        const current = await tx.getBatch(batch.id);
        if (current?.status === 'MAPPED') {
          await tx.updateBatch(current.id, current.version, { status: 'FAILED', failureCode });
        }
      }).catch((e: unknown) => this.options.onBackgroundError?.(e, batch.id));
    } finally {
      this.parsing.delete(batch.id);
    }
  }

  /**
   * Makes the stored issues and row links match a fresh analysis. Groups whose rows, values or proposal
   * changed are replaced (their decision carries over through `decisions`); groups no longer raised go.
   */
  private async reconcile(
    tx: ImportTx,
    batch: ImportBatch,
    rows: readonly ImportRow[],
    stored: readonly ImportIssue[],
    analysis: ImportAnalysis,
  ): Promise<ImportIssue[]> {
    const wanted = new Map(analysis.issues.map((i) => [i.groupKey, i]));
    const kept: ImportIssue[] = [];
    const stale = new Set<string>();
    for (const issue of stored) {
      const fresh = wanted.get(issue.groupKey);
      if (fresh && shapeOf(fresh) === shapeOf(issue)) {
        kept.push({ ...issue, decision: fresh.decision, editedValue: fresh.editedValue });
      } else {
        stale.add(issue.groupKey);
      }
    }
    // Rows stop pointing at the stale groups below; issue_ids has no foreign key, so the order is free.
    await tx.removeGroups(batch.id, [...stale]);
    const keptKeys = new Set(kept.map((i) => i.groupKey));
    const added = await tx.addIssues(
      batch.id,
      analysis.issues
        .filter((i) => !keptKeys.has(i.groupKey))
        .map((issue): NewIssue => ({ ...issue, batchId: batch.id })),
    );
    const idOf = new Map([...kept, ...added].map((i) => [i.groupKey, i.id]));
    const byNumber = new Map(analysis.rows.map((r) => [r.rowNumber, r]));
    for (const row of rows) {
      const fresh = byNumber.get(row.rowNumber);
      /* v8 ignore next */
      if (!fresh) continue;
      const issueIds = fresh.issueGroupKeys.map((k) => idOf.get(k)).filter((i) => i !== undefined);
      if (
        row.outcome !== fresh.outcome ||
        JSON.stringify(row.issueIds) !== JSON.stringify(issueIds)
      ) {
        await tx.setRow(row.id, { outcome: fresh.outcome, issueIds });
      }
    }
    return [...kept, ...added];
  }
}

async function allRows(tx: ImportTx, batchId: string): Promise<ImportRow[]> {
  const rows: ImportRow[] = [];
  let afterRowNumber: number | undefined;
  for (;;) {
    const page = await tx.rows(batchId, { limit: 200, afterRowNumber });
    rows.push(...page.items);
    if (page.nextCursor === null) return rows;
    afterRowNumber = Number(page.nextCursor);
  }
}

/** The parsed sheet again, from the stored raw rows (the workbook is read once, at parse). */
function sheetFromRows(batch: ImportBatch, rows: readonly ImportRow[]): SourceSheet {
  return {
    name: batch.sheetName,
    headers: (batch.mapping ?? []).map((m) => m.sourceHeader),
    rows: rows.map((r) => ({ rowNumber: r.rowNumber, cells: r.raw })),
  };
}

/** CSV sheets have no name; the API names them by position. */
function sheetName(sheet: SourceSheet, index: number): string {
  return sheet.name ?? `Sheet${index + 1}`;
}

/** The template naming the most of these headers, newest first on a tie; null when none names any. */
function bestTemplate(
  templates: readonly MappingTemplate[],
  headers: readonly string[],
): MappingTemplate | null {
  const present = new Set(headers);
  let best: { template: MappingTemplate; score: number } | null = null;
  for (const template of templates) {
    const score = template.mapping.filter((m: ColumnMapping[number]) =>
      present.has(m.sourceHeader),
    ).length;
    if (score === 0) continue;
    if (!best || score > best.score || (score === best.score && template.id > best.template.id)) {
      best = { template, score };
    }
  }
  return best?.template ?? null;
}
