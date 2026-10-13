import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  DryRunReport,
  ImportBatch,
  ImportIssueGroup,
  ImportRow,
  ImportUploaded,
  ImportUploadTicket,
  MappingTemplate,
  type Role,
} from '@canopy/contracts';
import { inferRule } from '@canopy/engine';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import { MemoryImportFiles, uploadKey } from './files.js';
import { MemoryImportStore } from './testing/memory-store.js';

const SAMPLE = new URL(
  '../../../../../packages/importer/fixtures/sample-register-anonymised.xlsx',
  import.meta.url,
);
const Page = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });

let bytes: Uint8Array;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

interface Harness {
  app: FastifyInstance;
  store: MemoryImportStore;
  files: MemoryImportFiles;
  firmId: string;
  clientId: string;
  /** Waits for the background parse runs started so far. */
  settle: () => Promise<void>;
  headers: (role?: Role, options?: { clientId?: string }) => Record<string, string>;
  errors: unknown[];
}

function harness(): Harness {
  const firmId = randomUUID();
  const clientId = randomUUID();
  const auth = createTestAuth();
  const store = new MemoryImportStore(firmId);
  store.addClient(clientId);
  const files = new MemoryImportFiles();
  const running: Promise<void>[] = [];
  const errors: unknown[] = [];
  const app = buildServer({
    authStore: auth.store,
    imports: {
      store,
      files,
      inferRule,
      runInBackground: (task) => running.push(task()),
      onBackgroundError: (error) => errors.push(error),
    },
  });
  const headers = (role: Role = 'FIRM_ADMIN', options: { clientId?: string } = {}) => {
    const client = options.clientId ?? clientId;
    const membership =
      role === 'FIRM_ADMIN'
        ? { role }
        : role === 'CONSULTANT'
          ? { role, consultantClientIds: [client] }
          : { role, clientId: client };
    return auth.signIn({
      firmId,
      memberships: [membership],
      principal: { firmClientIds: [clientId] },
    }).headers;
  };
  return {
    app,
    store,
    files,
    firmId,
    clientId,
    settle: async () => {
      await Promise.all(running.splice(0));
    },
    headers,
    errors,
  };
}

beforeEach(async () => {
  bytes ??= new Uint8Array(await readFile(SAMPLE));
});

// Each step reads the whole sample workbook, which is slow under coverage on a busy runner.
describe('import API', { timeout: 30_000 }, () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.app.close());

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    url: string,
    payload?: unknown,
    headers = h.headers(),
  ) => h.app.inject({ method, url: `/api/v1${url}`, payload: payload as object, headers });

  async function upload(name = 'register.xlsx', content = bytes): Promise<string> {
    const res = await call('POST', `/clients/${h.clientId}/imports`, {
      fileName: name,
      sizeBytes: content.byteLength,
    });
    expect(res.statusCode).toBe(201);
    const ticket = ImportUploadTicket.parse(res.json());
    h.files.put(uploadKey(h.firmId, ticket.batchId), content);
    return ticket.batchId;
  }

  async function uploaded(id: string) {
    const res = await call('POST', `/imports/${id}/uploaded`, { sha256: sha(bytes) });
    expect(res.statusCode).toBe(200);
    return ImportUploaded.parse(res.json());
  }

  async function mapped(id: string) {
    const preview = await uploaded(id);
    const res = await call('PUT', `/imports/${id}/mapping`, {
      sheetName: preview.sheets[0]?.name,
      mapping: preview.suggestedMapping,
    });
    expect(res.statusCode).toBe(200);
    return ImportBatch.parse(res.json());
  }

  async function parsed(id: string) {
    await mapped(id);
    const res = await call('POST', `/imports/${id}/parse`);
    expect(res.statusCode).toBe(202);
    await h.settle();
    return ImportBatch.parse((await call('GET', `/imports/${id}`)).json());
  }

  async function groups(id: string, query = '') {
    const res = await call('GET', `/imports/${id}/issues${query}`);
    expect(res.statusCode).toBe(200);
    return z.strictObject({ items: z.array(ImportIssueGroup) }).parse(res.json()).items;
  }

  /** Decides every pending group as the recommended profile would; ERROR rows are skipped. */
  async function reviewed(id: string) {
    await parsed(id);
    return decideAll(id);
  }

  async function decideAll(id: string) {
    for (let round = 0; round < 5; round++) {
      const pending = await groups(id, '?decision=PENDING');
      if (pending.length === 0) break;
      for (const group of pending) {
        const body =
          group.severity === 'ERROR' || group.proposal === null
            ? { decision: 'REJECTED' }
            : { decision: 'ACCEPTED' };
        await call('PATCH', `/imports/${id}/issues/${group.groupKey}`, body);
      }
    }
    const batch = ImportBatch.parse((await call('GET', `/imports/${id}`)).json());
    expect(batch.status).toBe('REVIEWED');
    return batch;
  }

  async function dryRun(id: string) {
    const res = await call('POST', `/imports/${id}/dry-run`);
    expect(res.statusCode).toBe(200);
    return DryRunReport.parse(res.json());
  }

  async function committed(id: string) {
    const res = await call('POST', `/imports/${id}/commit`);
    expect(res.statusCode).toBe(202);
    expect(ImportBatch.parse(res.json()).status).toBe('COMMITTING');
    await h.settle();
    return ImportBatch.parse((await call('GET', `/imports/${id}`)).json());
  }

  it('walks the sample register from upload to REVIEWED', async () => {
    const id = await upload();
    expect(await call('GET', `/imports/${id}`)).toHaveProperty('statusCode', 404);

    const preview = await uploaded(id);
    expect(preview.batch).toMatchObject({ id, status: 'UPLOADED', fileSha256: sha(bytes) });
    expect(preview.sheets[0]?.rowCount).toBe(424);
    expect(preview.suggestedMapping?.filter((m) => m.field !== null)).toHaveLength(19);

    const batch = await parsed(id);
    expect(batch.status).toBe('PARSED');
    expect(batch.counts).toMatchObject({ rows: 424 });
    expect(h.store.rows.size).toBe(424);

    // Decide every pending warning as the recommended profile would; ERROR rows are skipped.
    for (const group of await groups(id, '?decision=PENDING')) {
      const body =
        group.severity === 'ERROR' || group.proposal === null
          ? { decision: 'REJECTED' }
          : { decision: 'ACCEPTED' };
      const res = await call('PATCH', `/imports/${id}/issues/${group.groupKey}`, body);
      expect(res.statusCode).toBe(200);
      expect(ImportIssueGroup.parse(res.json()).decision).toBe(body.decision);
    }
    expect(await groups(id, '?decision=PENDING')).toHaveLength(0);
    const reviewed = ImportBatch.parse((await call('GET', `/imports/${id}`)).json());
    expect(reviewed.status).toBe('REVIEWED');
    expect(h.errors).toEqual([]);
  });

  it('drops issues a decision makes moot and links rows to the issues that remain', async () => {
    const id = await upload();
    await parsed(id);
    const before = await groups(id);
    for (const group of before.filter((g) => g.severity === 'WARNING')) {
      if (group.type === 'RULE_LOW_CONFIDENCE') continue;
      await call('PATCH', `/imports/${id}/issues/${group.groupKey}`, { decision: 'REJECTED' });
    }
    const after = await groups(id);
    const keys = new Set(after.map((g) => g.groupKey));
    expect(before.filter((g) => !keys.has(g.groupKey)).map((g) => g.type)).toContain(
      'DUPLICATE_PERIOD',
    );
    const issueIds = new Set(after.flatMap((g) => g.issueIds));
    for (const row of h.store.rows.values()) {
      for (const issueId of row.issueIds) expect(issueIds).toContain(issueId);
    }
  });

  it('pages rows and filters them by outcome and issue type', async () => {
    const id = await upload();
    await parsed(id);
    const first = Page(ImportRow).parse(
      (await call('GET', `/imports/${id}/rows?limit=100`)).json(),
    );
    expect(first.items).toHaveLength(100);
    const second = Page(ImportRow).parse(
      (await call('GET', `/imports/${id}/rows?limit=200&cursor=${first.nextCursor}`)).json(),
    );
    expect(second.items[0]?.rowNumber).toBe((first.items.at(-1)?.rowNumber ?? 0) + 1);
    const third = Page(ImportRow).parse(
      (await call('GET', `/imports/${id}/rows?limit=200&cursor=${second.nextCursor}`)).json(),
    );
    expect(first.items.length + second.items.length + third.items.length).toBe(424);
    expect(third.nextCursor).toBeNull();

    const pending = Page(ImportRow).parse(
      (await call('GET', `/imports/${id}/rows?outcome=PENDING&limit=1`)).json(),
    );
    expect(pending.items.map((r) => r.outcome)).toEqual(['PENDING']);
    expect(pending.nextCursor).not.toBeNull();
    const errors = Page(ImportRow).parse(
      (await call('GET', `/imports/${id}/rows?outcome=ERROR`)).json(),
    );
    expect(errors).toEqual({ items: [], nextCursor: null });
    const dupes = Page(ImportRow).parse(
      (await call('GET', `/imports/${id}/rows?issueType=DUPLICATE_PERIOD&limit=200`)).json(),
    );
    expect(dupes.items.length).toBeGreaterThan(0);
    expect(dupes.nextCursor).toBeNull();
    expect((await call('GET', `/imports/${id}/rows?cursor=x`)).statusCode).toBe(400);
  });

  it('refuses steps out of order with IMPORT_STATE', async () => {
    const id = await upload();
    await uploaded(id);
    const early = await call('POST', `/imports/${id}/parse`);
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatchObject({
      code: 'IMPORT_STATE',
      details: { status: 'UPLOADED', expected: ['MAPPED'] },
    });
    const decide = await call('PATCH', `/imports/${id}/issues/x`, { decision: 'ACCEPTED' });
    expect(decide.json().error.code).toBe('IMPORT_STATE');
  });

  it('checks the upload: checksum, file type, size and presence', async () => {
    const id = await upload();
    const wrong = await call('POST', `/imports/${id}/uploaded`, { sha256: '0'.repeat(64) });
    expect(wrong.json().error.code).toBe('VALIDATION');
    const missing = await call('POST', `/imports/${randomUUID()}/uploaded`, {
      sha256: sha(bytes),
    });
    expect(missing.statusCode).toBe(404);
    const xls = await call('POST', `/clients/${h.clientId}/imports`, {
      fileName: 'old.xls',
      sizeBytes: 10,
    });
    expect(xls.statusCode).toBe(415);

    const junk = new TextEncoder().encode('not a workbook');
    const junkId = await upload('junk.xlsx', junk);
    const res = await call('POST', `/imports/${junkId}/uploaded`, { sha256: sha(junk) });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.details).toEqual({ allowed: ['.xlsx'] });
  });

  it('accepts a repeated uploaded call and validates the mapping', async () => {
    const id = await upload();
    await uploaded(id);
    expect((await uploaded(id)).batch.status).toBe('UPLOADED');
    const badSheet = await call('PUT', `/imports/${id}/mapping`, {
      sheetName: 'Nope',
      mapping: [],
    });
    expect(badSheet.json().error.code).toBe('VALIDATION');
    const preview = await uploaded(id);
    const missing = await call('PUT', `/imports/${id}/mapping`, {
      sheetName: preview.sheets[0]?.name,
      mapping: [{ sourceHeader: 'Unknown column', field: null }],
    });
    expect(missing.statusCode).toBe(400);
    expect(JSON.stringify(missing.json())).toContain('MISSING_REQUIRED_FIELD');
    await mapped(id);
    const again = await call('POST', `/imports/${id}/uploaded`, { sha256: sha(bytes) });
    expect(again.json().error.code).toBe('IMPORT_STATE');
  });

  it('saves a mapping as a template and suggests it for the next upload', async () => {
    const id = await upload();
    const preview = await uploaded(id);
    const res = await call('PUT', `/imports/${id}/mapping`, {
      sheetName: preview.sheets[0]?.name,
      mapping: preview.suggestedMapping,
      saveAsTemplate: { name: 'EY grid', scope: 'CLIENT' },
    });
    const batch = ImportBatch.parse(res.json());
    expect(batch.mappingTemplateId).not.toBeNull();

    const next = await uploaded(await upload());
    expect(next.suggestedTemplateId).toBe(batch.mappingTemplateId);

    const list = Page(MappingTemplate).parse(
      (await call('GET', `/clients/${h.clientId}/mapping-templates?limit=1`)).json(),
    );
    expect(list.items).toHaveLength(1);
    expect(list.nextCursor).toBeNull();
  });

  it('creates, pages and updates mapping templates', async () => {
    const mapping = [{ sourceHeader: 'Act', field: 'act' }];
    for (const [name, scope] of [
      ['Client one', 'CLIENT'],
      ['Firm wide', 'FIRM'],
    ] as const) {
      const res = await call('POST', `/clients/${h.clientId}/mapping-templates`, {
        name,
        mapping,
        scope,
      });
      expect(res.statusCode).toBe(201);
    }
    const first = Page(MappingTemplate).parse(
      (await call('GET', `/clients/${h.clientId}/mapping-templates?limit=1`)).json(),
    );
    expect(first.nextCursor).not.toBeNull();
    const rest = Page(MappingTemplate).parse(
      (
        await call(
          'GET',
          `/clients/${h.clientId}/mapping-templates?limit=1&cursor=${first.nextCursor}`,
        )
      ).json(),
    );
    expect(rest.items).toHaveLength(1);
    const firmWide = [...h.store.templates.values()].find((t) => t.clientId === null);
    const patched = await call('PATCH', `/mapping-templates/${firmWide?.id}`, {
      version: 1,
      name: 'Renamed',
    });
    expect(MappingTemplate.parse(patched.json())).toMatchObject({ name: 'Renamed', version: 2 });
    const stale = await call('PATCH', `/mapping-templates/${firmWide?.id}`, {
      version: 1,
      name: 'Again',
    });
    expect(stale.json().error.code).toBe('STALE_VERSION');
    expect(
      (await call('PATCH', `/mapping-templates/${randomUUID()}`, { version: 1, name: 'x' }))
        .statusCode,
    ).toBe(404);
  });

  it('validates decisions against the issue type', async () => {
    const id = await upload();
    await parsed(id);
    const info = (await groups(id, '?severity=INFO'))[0];
    const res = await call('PATCH', `/imports/${id}/issues/${info?.groupKey}`, {
      decision: 'REJECTED',
    });
    expect(res.statusCode).toBe(400);
    const unknown = await call('PATCH', `/imports/${id}/issues/nope`, { decision: 'ACCEPTED' });
    expect(unknown.statusCode).toBe(404);
    const typed = await groups(id, '?type=DUPLICATE_PERIOD');
    expect(typed.every((g) => g.type === 'DUPLICATE_PERIOD')).toBe(true);
  });

  it('cancels before commit and lists history newest first', async () => {
    const older = await upload();
    await uploaded(older);
    const newer = await upload();
    await uploaded(newer);
    const cancelled = await call('POST', `/imports/${older}/cancel`);
    expect(ImportBatch.parse(cancelled.json()).status).toBe('CANCELLED');
    expect((await call('POST', `/imports/${older}/cancel`)).json().error.code).toBe('IMPORT_STATE');
    const history = Page(ImportBatch).parse(
      (await call('GET', `/clients/${h.clientId}/imports`)).json(),
    );
    expect(history.items.map((b) => b.id)).toEqual([newer, older]);
  });

  it('marks the batch FAILED when the parse cannot read the upload', async () => {
    const id = await upload();
    await mapped(id);
    h.files.objects.delete(uploadKey(h.firmId, id));
    await call('POST', `/imports/${id}/parse`);
    await h.settle();
    const batch = ImportBatch.parse((await call('GET', `/imports/${id}`)).json());
    expect(batch).toMatchObject({ status: 'FAILED', failureCode: 'NOT_FOUND' });
    expect(h.errors).toHaveLength(1);
  });

  it('starts one parse per batch and ignores a parse whose batch changed meanwhile', async () => {
    const id = await upload();
    await mapped(id);
    await call('POST', `/imports/${id}/parse`);
    await call('POST', `/imports/${id}/parse`);
    await call('POST', `/imports/${id}/cancel`);
    await h.settle();
    const batch = ImportBatch.parse((await call('GET', `/imports/${id}`)).json());
    expect(batch.status).toBe('CANCELLED');
    expect(h.store.rows.size).toBe(0);
  });

  it('dry-runs, commits once and re-imports the same register unchanged', async () => {
    const id = await upload();
    await reviewed(id);
    const report = await dryRun(id);
    expect(report.create.instances).toBe(422);
    expect(report.blockingErrors).toBe(0);
    const ready = ImportBatch.parse((await call('GET', `/imports/${id}`)).json());
    expect(ready).toMatchObject({ status: 'DRY_RUN_READY', dryRun: report });
    // A dry run can be repeated until commit.
    expect(await dryRun(id)).toEqual(report);

    const batch = await committed(id);
    expect(batch.status).toBe('COMMITTED');
    expect(batch.committedAt).not.toBeNull();
    expect(h.store.commits).toHaveLength(1);
    const commit = h.store.commits[0]!;
    expect(commit.plan.instances).toHaveLength(422);
    expect(commit.instanceChanges.size).toBe(0);
    const rows = [...h.store.rows.values()].filter((r) => r.batchId === id);
    const linked = rows.filter((r) => r.targetInstanceId !== null);
    expect(new Set(linked.map((r) => r.targetInstanceId)).size).toBe(422);
    expect(rows.filter((r) => r.outcome === 'CREATE').length).toBeGreaterThanOrEqual(422);

    // Committing again is a no-op that returns the batch.
    const again = await call('POST', `/imports/${id}/commit`);
    expect(again.statusCode).toBe(202);
    expect(ImportBatch.parse(again.json()).status).toBe('COMMITTED');
    await h.settle();
    expect(h.store.commits).toHaveLength(1);
    expect((await call('POST', `/imports/${id}/cancel`)).json().error.code).toBe('IMPORT_STATE');

    // The same register again: nothing to create or update.
    const second = await upload();
    await reviewed(second);
    const repeat = await dryRun(second);
    expect(repeat.create.instances).toBe(0);
    expect(repeat.update).toEqual({ obligations: 0, assignments: 0, instances: 0 });
    expect(repeat.unchanged.instances).toBe(422);
    await committed(second);
    expect(h.store.commits[1]?.instanceChanges.size).toBe(0);
    expect(h.errors).toEqual([]);
  });

  it('refuses dry run and commit out of order', async () => {
    const id = await upload();
    await parsed(id);
    expect((await call('POST', `/imports/${id}/dry-run`)).json().error).toMatchObject({
      code: 'IMPORT_STATE',
      details: { status: 'PARSED', expected: ['REVIEWED', 'DRY_RUN_READY'] },
    });
    await decideAll(id);
    expect((await call('POST', `/imports/${id}/commit`)).json().error).toMatchObject({
      code: 'IMPORT_STATE',
      details: { status: 'REVIEWED', expected: ['DRY_RUN_READY'] },
    });
    // A decision after the dry run drops it: the batch is REVIEWED again.
    await dryRun(id);
    const group = (await groups(id, '?type=RULE_LOW_CONFIDENCE'))[0]!;
    await call('PATCH', `/imports/${id}/issues/${group.groupKey}`, { decision: 'ACCEPTED' });
    const batch = ImportBatch.parse((await call('GET', `/imports/${id}`)).json());
    expect(batch).toMatchObject({ status: 'REVIEWED', dryRun: null });
  });

  it('blocks a commit while rows have errors', async () => {
    const id = await upload();
    await reviewed(id);
    await dryRun(id);
    const issue = [...h.store.issues.values()].find((i) => i.batchId === id)!;
    const row = [...h.store.rows.values()].find((r) => r.batchId === id)!;
    h.store.rows.set(row.id, { ...row, outcome: 'ERROR', issueIds: [issue.id] });
    const res = await call('POST', `/imports/${id}/commit`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'IMPORT_BLOCKED',
      details: { blockingIssueIds: [issue.id] },
    });
    expect(h.store.commits).toHaveLength(0);
  });

  it('marks the batch FAILED when the commit fails, having written nothing', async () => {
    const id = await upload();
    await reviewed(id);
    await dryRun(id);
    h.store.failNextCommit = new Error('database went away');
    const batch = await committed(id);
    expect(batch).toMatchObject({ status: 'FAILED', failureCode: 'INTERNAL' });
    expect(h.store.commits).toHaveLength(0);
    expect(h.errors).toHaveLength(1);
  });

  it('starts one commit per batch', async () => {
    const id = await upload();
    await reviewed(id);
    await dryRun(id);
    await call('POST', `/imports/${id}/commit`);
    await call('POST', `/imports/${id}/commit`);
    await h.settle();
    expect(h.store.commits).toHaveLength(1);
    expect(h.store.batches.get(id)?.status).toBe('COMMITTED');
  });

  describe('roles', () => {
    it('lets a consultant import for their clients only', async () => {
      const consultant = h.headers('CONSULTANT');
      const res = await call(
        'POST',
        `/clients/${h.clientId}/imports`,
        { fileName: 'a.xlsx', sizeBytes: 1 },
        consultant,
      );
      expect(res.statusCode).toBe(201);
      const id = await upload();
      await uploaded(id);
      const other = h.headers('CONSULTANT', { clientId: randomUUID() });
      expect((await call('GET', `/imports/${id}`, undefined, other)).statusCode).toBe(404);
      expect((await call('GET', `/imports/${id}`, undefined, consultant)).statusCode).toBe(200);
    });

    it('lets a consultant commit but keeps firm-wide templates to firm admins', async () => {
      const consultant = h.headers('CONSULTANT');
      const id = await upload();
      await reviewed(id);
      expect((await call('POST', `/imports/${id}/dry-run`, undefined, consultant)).statusCode).toBe(
        200,
      );
      expect((await call('POST', `/imports/${id}/commit`, undefined, consultant)).statusCode).toBe(
        202,
      );
      await h.settle();
      const mapping = [{ sourceHeader: 'Act', field: 'act' }];
      const firm = await call(
        'POST',
        `/clients/${h.clientId}/mapping-templates`,
        { name: 'Firm wide', mapping, scope: 'FIRM' },
        consultant,
      );
      expect(firm.statusCode).toBe(403);
      const own = await call(
        'POST',
        `/clients/${h.clientId}/mapping-templates`,
        { name: 'Client one', mapping, scope: 'CLIENT' },
        consultant,
      );
      expect(own.statusCode).toBe(201);
      const created = await call('POST', `/clients/${h.clientId}/mapping-templates`, {
        name: 'Firm wide',
        mapping,
        scope: 'FIRM',
      });
      const rename = await call(
        'PATCH',
        `/mapping-templates/${MappingTemplate.parse(created.json()).id}`,
        { version: 1, name: 'Mine now' },
        consultant,
      );
      expect(rename.statusCode).toBe(403);

      const next = await upload();
      const preview = await uploaded(next);
      const save = await call(
        'PUT',
        `/imports/${next}/mapping`,
        {
          sheetName: preview.sheets[0]?.name,
          mapping: preview.suggestedMapping,
          saveAsTemplate: { name: 'Firm grid', scope: 'FIRM' },
        },
        consultant,
      );
      expect(save.statusCode).toBe(403);
    });

    it.each(['CLIENT_ADMIN', 'APPROVER', 'OWNER', 'VIEWER'] as const)(
      'forbids %s',
      async (role) => {
        const id = await upload();
        await uploaded(id);
        const headers = h.headers(role);
        expect((await call('GET', `/imports/${id}`, undefined, headers)).statusCode).toBe(403);
        const start = await call(
          'POST',
          `/clients/${h.clientId}/imports`,
          { fileName: 'a.xlsx', sizeBytes: 1 },
          headers,
        );
        expect(start.statusCode).toBe(403);
        for (const step of ['dry-run', 'commit']) {
          expect(
            (await call('POST', `/imports/${id}/${step}`, undefined, headers)).statusCode,
          ).toBe(403);
        }
        expect(
          (await call('GET', `/clients/${h.clientId}/mapping-templates`, undefined, headers))
            .statusCode,
        ).toBe(403);
      },
    );
  });
});
