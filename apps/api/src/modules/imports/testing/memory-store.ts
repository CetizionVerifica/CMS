import { randomUUID } from 'node:crypto';
import type {
  EngineCalendar,
  ImportBatch,
  ImportIssue,
  ImportRow,
  MappingTemplate,
} from '@canopy/contracts';
import { DbError } from '@canopy/db';
import { EMPTY_STATE, type ExistingState } from '@canopy/importer';
import type { ImportStore, ImportTx } from '../store.js';

/**
 * In-memory `ImportStore` for the service and route tests. It keeps one firm's data and is not
 * transactional; the Postgres test (`imports.db.test.ts`) covers `repositoryStore`.
 */
export class MemoryImportStore implements ImportStore {
  readonly batches = new Map<string, ImportBatch>();
  readonly rows = new Map<string, ImportRow>();
  readonly issues = new Map<string, ImportIssue>();
  readonly templates = new Map<string, MappingTemplate>();
  readonly calendars = new Map<string, EngineCalendar>();
  existing: ExistingState = EMPTY_STATE;

  constructor(private readonly firmId: string) {}

  /** Makes a client known, with the Indian FY by default. */
  addClient(
    clientId: string,
    calendar: EngineCalendar = { fyStartMonth: 4, holidayPolicy: 'NONE' },
  ) {
    this.calendars.set(clientId, calendar);
  }

  async transaction<T>(_ctx: unknown, fn: (tx: ImportTx) => Promise<T>): Promise<T> {
    return fn(this.tx());
  }

  private stamp() {
    return new Date().toISOString();
  }

  private tx(): ImportTx {
    const versioned = <T extends { version: number; updatedAt: string }>(
      map: Map<string, T>,
      id: string,
      version: number,
      patch: Partial<T>,
    ): T => {
      const current = map.get(id);
      if (!current) throw new DbError('NOT_FOUND', 'not found');
      if (current.version !== version) throw new DbError('STALE_VERSION', 'stale');
      const next = { ...current, ...patch, version: version + 1, updatedAt: this.stamp() };
      map.set(id, next);
      return next;
    };
    const base = () => ({
      firmId: this.firmId,
      createdAt: this.stamp(),
      updatedAt: this.stamp(),
      archivedAt: null,
    });

    return {
      getBatch: async (id) => this.batches.get(id) ?? null,
      createBatch: async (input) => {
        if (this.batches.has(input.id)) throw new DbError('DUPLICATE', 'duplicate');
        const batch: ImportBatch = { ...base(), version: 1, ...input };
        this.batches.set(batch.id, batch);
        return batch;
      },
      updateBatch: async (id, version, patch) =>
        versioned<ImportBatch>(this.batches, id, version, patch),
      listBatches: async (clientId, page) => {
        const all = [...this.batches.values()]
          .filter((b) => b.clientId === clientId && (!page.cursor || b.id < page.cursor))
          .sort((a, b) => b.id.localeCompare(a.id));
        const limit = page.limit ?? 50;
        const items = all.slice(0, limit);
        return { items, nextCursor: all.length > limit ? (items.at(-1)?.id ?? null) : null };
      },

      addRows: async (batchId, rows) =>
        rows.map((r) => {
          const row: ImportRow = { ...r, batchId, id: randomUUID(), targetInstanceId: null };
          this.rows.set(row.id, row);
          return row;
        }),
      rows: async (batchId, page) => {
        const all = [...this.rows.values()]
          .filter(
            (r) =>
              r.batchId === batchId &&
              (page.afterRowNumber === undefined || r.rowNumber > page.afterRowNumber),
          )
          .sort((a, b) => a.rowNumber - b.rowNumber);
        const items = all.slice(0, page.limit);
        return {
          items,
          nextCursor: all.length > page.limit ? String(items.at(-1)?.rowNumber) : null,
        };
      },
      setRow: async (id, patch) => {
        const row = this.rows.get(id);
        if (!row) throw new DbError('NOT_FOUND', 'not found');
        this.rows.set(id, { ...row, ...patch });
      },

      addIssues: async (batchId, issues) =>
        issues.map((i) => {
          const issue: ImportIssue = { ...i, batchId, id: randomUUID() };
          this.issues.set(issue.id, issue);
          return issue;
        }),
      issues: async (batchId) =>
        [...this.issues.values()]
          .filter((i) => i.batchId === batchId)
          .sort((a, b) => a.groupKey.localeCompare(b.groupKey)),
      decideGroup: async (batchId, groupKey, decision, editedValue) => {
        for (const issue of this.issues.values()) {
          if (issue.batchId === batchId && issue.groupKey === groupKey) {
            this.issues.set(issue.id, { ...issue, decision, editedValue });
          }
        }
      },
      removeGroups: async (batchId, groupKeys) => {
        for (const issue of [...this.issues.values()]) {
          if (issue.batchId === batchId && groupKeys.includes(issue.groupKey)) {
            this.issues.delete(issue.id);
          }
        }
      },

      templatesFor: async (clientId) =>
        [...this.templates.values()].filter((t) => t.clientId === clientId || t.clientId === null),
      getTemplate: async (id) => this.templates.get(id) ?? null,
      createTemplate: async (input) => {
        const template: MappingTemplate = { ...base(), version: 1, id: randomUUID(), ...input };
        this.templates.set(template.id, template);
        return template;
      },
      updateTemplate: async (id, version, patch) =>
        versioned<MappingTemplate>(this.templates, id, version, patch),

      calendar: async (clientId) => {
        const calendar = this.calendars.get(clientId);
        if (!calendar) throw new DbError('NOT_FOUND', 'not found');
        return calendar;
      },
      existingState: async () => this.existing,
    };
  }
}
