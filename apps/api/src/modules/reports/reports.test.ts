import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { ENDPOINTS, ExportJob, Role } from '@canopy/contracts';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../server.js';
import { createTestAuth } from '../../auth/testing.js';
import { createWorld, NOW } from '../dashboard/testing/world.js';
import { REGISTER_HEADERS } from './register-xlsx.js';

const w = createWorld();
afterAll(() => w.app.close());

const base = `/api/v1/clients/${w.clientId}`;

async function startExport(
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  extra: Record<string, string> = {},
  clientId = w.clientId,
) {
  return w.app.inject({
    method: 'POST',
    url: `/api/v1/clients/${clientId}/exports`,
    headers: { ...headers, ...extra },
    payload,
  });
}

/** Starts an export, waits for it, and returns the finished job and its file. */
async function exportFile(headers: Record<string, string>, payload: Record<string, unknown>) {
  const res = await startExport(headers, payload);
  expect(res.statusCode).toBe(202);
  const queued = ExportJob.parse(res.json());
  expect(queued.status).toBe('QUEUED');
  await w.runner.idle();
  const job = ExportJob.parse(
    (await w.app.inject({ url: `/api/v1/exports/${queued.id}`, headers })).json(),
  );
  expect(job.status).toBe('DONE');
  const key = await w.store.exportStorageKey(
    { firmId: w.firmId } as Parameters<typeof w.store.exportStorageKey>[0],
    job.id,
  );
  const file = w.files.files.get(key!)!;
  return { job, file };
}

async function sheetRows(bytes: Uint8Array): Promise<unknown[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const rows: unknown[][] = [];
  workbook.worksheets[0]!.eachRow((row) => {
    rows.push((row.values as unknown[]).slice(1));
  });
  return rows;
}

/** Text drawn in a pdf-lib PDF: inflate each content stream and decode its hex strings. */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  const parts: string[] = [];
  let at = 0;
  for (;;) {
    const start = raw.indexOf('stream\n', at);
    if (start < 0) break;
    const end = raw.indexOf('\nendstream', start);
    const body = raw.subarray(start + 7, end);
    at = end + 10;
    let text: string;
    try {
      text = inflateSync(body).toString('latin1');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/<([0-9A-Fa-f]+)> Tj/g)) {
      parts.push(Buffer.from(match[1]!, 'hex').toString('latin1'));
    }
  }
  return parts.join(' ');
}

describe('reports: role matrix', () => {
  const cases = [
    { id: 'actReport', url: `${base}/reports/act-wise` },
    { id: 'departmentReport', url: `${base}/reports/department-wise` },
    { id: 'overdueReport', url: `${base}/reports/overdue` },
  ] as const;
  for (const c of cases) {
    const endpoint = ENDPOINTS[c.id];
    for (const role of Role.options) {
      const allowed = endpoint.roles[role] !== undefined;
      it(`${c.id}: ${role} ${allowed ? 'gets 200' : 'gets 403'}`, async () => {
        const res = await w.app.inject({ url: c.url, headers: w.as(role).headers });
        expect(res.statusCode).toBe(allowed ? 200 : 403);
        if (allowed) endpoint.response.parse(res.json());
      });
    }
  }
});

describe('reports', () => {
  it('act-wise and department-wise reports group the period by Act and department', async () => {
    const headers = w.as('CLIENT_ADMIN').headers;
    const act = (await w.app.inject({ url: `${base}/reports/act-wise`, headers })).json();
    expect(act.by).toBe('act');
    expect(act.rows.map((r: { key: string }) => r.key).sort()).toEqual(
      [w.act.factories, w.act.tax].sort(),
    );
    const dept = (await w.app.inject({ url: `${base}/reports/department-wise`, headers })).json();
    expect(dept.by).toBe('department');
    expect(dept.rows.map((r: { label: string }) => r.label)).toEqual(['Safety', 'Tax']);
  });

  it('overdue report lists overdue items, most overdue first, with the period score', async () => {
    const res = await w.app.inject({
      url: `${base}/reports/overdue`,
      headers: w.as('VIEWER').headers,
    });
    const body = ENDPOINTS.overdueReport.response.parse(res.json());
    expect(body.items.map((i) => [i.id, i.overdueDays])).toEqual([
      [w.rows.overdue!.id, 12],
      [w.rows.sentBack!.id, 11],
    ]);
    expect(body.result.counts.OVERDUE).toBe(2);
  });
});

describe('exports', () => {
  it("exports the register under the 19 sample headers, in the view's filters", async () => {
    const headers = w.as('CLIENT_ADMIN').headers;
    const { job, file } = await exportFile(headers, { kind: 'REGISTER_XLSX' });
    expect(job.fileName).toBe('compliance-register-all-dates.xlsx');
    expect(file.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const rows = await sheetRows(file.bytes);
    expect(rows[0]).toEqual([...REGISTER_HEADERS]);
    // Every Beta Group instance, all dates, by due date.
    expect(rows).toHaveLength(1 + 9);
    const na = rows.find((r) => r[8] === 'Not Applicable')!;
    expect(na[15]).toBe('We do not transport compressed gas');
    expect(na[7]).toEqual(new Date('2026-05-01T00:00:00Z'));
    const submitted = rows.find(
      (r) => r[9] instanceof Date && (r[9] as Date).toISOString().startsWith('2026-11-30'),
    )!;
    expect(submitted[8]).toBe('Pending');
    expect(submitted[7]).toBeUndefined();
    const complied = rows.find((r) => r[15] === 'Challan attached')!;
    expect(complied[8]).toBe('Complied');
    expect(complied[12]).toBe('Beta Group/ Kestrel Aluminium/ Plant');
    expect(complied[13]).toBe('India/ West Bengal/ Riverbend');
    expect(complied[18]).toBe('Low');
  });

  it('applies register filters, including status and me', async () => {
    const headers = w.as('OWNER', {}, w.ownerId).headers;
    const forbidden = await startExport(headers, { kind: 'REGISTER_XLSX' });
    expect(forbidden.statusCode).toBe(403);
    const admin = w.as('CLIENT_ADMIN', {}, w.ownerId).headers;
    const { file } = await exportFile(admin, {
      kind: 'REGISTER_XLSX',
      filters: 'status=OVERDUE&ownerId=me&fy=2026-27',
    });
    const rows = await sheetRows(file.bytes);
    expect(rows.slice(1).map((r) => r[1])).toEqual([w.rows.overdue!.title, w.rows.sentBack!.title]);
    const filtered = await exportFile(admin, {
      kind: 'REGISTER_XLSX',
      filters: `departmentId=${w.dept.tax}&actId=${w.act.tax}&categoryId=${w.rows.complied!.categoryId}&criticality=LOW&workflowState=APPROVED&timelineType=TIME_BASED&domain=HRS&dueFrom=2026-01-01&dueTo=2026-12-31&completedFrom=2026-06-01&completedTo=2026-06-30&hasEvidence=false&q=challan&approverId=${w.approverId}`,
    });
    expect((await sheetRows(filtered.file.bytes)).slice(1).map((r) => r[1])).toEqual([
      w.rows.complied!.title,
    ]);
  });

  it("limits an approver's export to their units", async () => {
    const headers = w.as('APPROVER', { unitIds: [w.unit2] }).headers;
    const { file } = await exportFile(headers, { kind: 'REGISTER_XLSX', fy: '2026-27' });
    const rows = await sheetRows(file.bytes);
    expect(rows.slice(1).every((r) => r[12] === 'Beta Group/ Kestrel Aluminium/ Head Office')).toBe(
      true,
    );
    expect(rows).toHaveLength(1 + 4);
    const outside = await startExport(headers, { kind: 'REGISTER_XLSX', unitId: w.unit1 });
    expect(outside.statusCode).toBe(404);
  });

  it('builds the Act-wise, department-wise and overdue workbooks', async () => {
    const headers = w.as('FIRM_ADMIN').headers;
    const act = await exportFile(headers, { kind: 'ACT_REPORT_XLSX' });
    expect(act.job.fileName).toBe('act-wise-report-fy-2026-27.xlsx');
    const actRows = await sheetRows(act.file.bytes);
    expect(actRows[0]![0]).toBe('PlanetPulse Compliance · Act-wise report');
    expect(actRows.map((r) => r[0])).toContain('Factories Act, 1948');
    expect(actRows.at(-1)![0]).toBe('All');
    expect(actRows.at(-1)![1]).toBe(8);

    const dept = await exportFile(headers, { kind: 'DEPARTMENT_REPORT_XLSX', unitId: w.unit2 });
    expect(dept.job.fileName).toBe('department-wise-report-fy-2026-27.xlsx');
    expect((await sheetRows(dept.file.bytes)).at(-1)![1]).toBe(4);

    const overdue = await exportFile(headers, { kind: 'OVERDUE_REPORT_XLSX', fy: '2025-26' });
    expect(overdue.job.fileName).toBe('overdue-report-fy-2025-26.xlsx');
    const overdueRows = await sheetRows(overdue.file.bytes);
    expect(overdueRows.at(-1)![1]).toBe(w.rows.lastFy!.title);
    expect(overdueRows.at(-1)![9]).toBe(285);

    const range = await exportFile(headers, {
      kind: 'OVERDUE_REPORT_XLSX',
      filters: 'dueFrom=2026-09-01&dueTo=2026-10-31',
    });
    expect(range.job.fileName).toBe('overdue-report-2026-09-01-to-2026-10-31.xlsx');
    const fyFilter = await exportFile(headers, { kind: 'ACT_REPORT_XLSX', filters: 'fy=2025-26' });
    expect(fyFilter.job.fileName).toBe('act-wise-report-fy-2025-26.xlsx');
    const from = await exportFile(headers, {
      kind: 'REGISTER_XLSX',
      filters: 'dueFrom=2027-01-01',
    });
    expect(from.job.fileName).toBe('compliance-register-2027-01-01-to-end.xlsx');
  });

  it('builds a compliance certificate for one unit and period, with no internal product name', async () => {
    const headers = w.as('VIEWER').headers;
    const { job, file } = await exportFile(headers, {
      kind: 'CERTIFICATE_PDF',
      unitId: w.unit1,
      fy: '2026-27',
    });
    expect(job.fileName).toBe('compliance-certificate-plant-fy-2026-27.pdf');
    expect(file.contentType).toBe('application/pdf');
    expect(Buffer.from(file.bytes).subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdfText(file.bytes);
    expect(text).toContain('Compliance certificate');
    expect(text).toContain('PlanetPulse Compliance');
    expect(text).toContain('Beta Group / Kestrel Aluminium / Plant');
    expect(text).toContain('Period: FY 2026-27. Status as at 2026-10-12.');
    expect(text).toContain('Factories Act, 1948');
    expect(text).toContain(w.rows.overdue!.externalRef!);
    expect(text).not.toMatch(/canopy/i);
    // Generated at 06:00 UTC, printed in the client's time zone (Asia/Kolkata, UTC+5:30).
    expect(text).toContain('generated 2026-10-12 11:30 Asia/Kolkata');
    expect(text).not.toContain('2026-10-12T06:00');
    expect(text).toMatch(/compliance items were complied with/);
    expect(text).not.toMatch(/obligations were/);
    // No owner or approver names on the certificate.
    expect(text).not.toContain('Person Owner');

    const byFilter = await exportFile(headers, {
      kind: 'CERTIFICATE_PDF',
      filters: `unitId=${w.unit2}`,
    });
    expect(byFilter.job.fileName).toBe('compliance-certificate-head-office-fy-2026-27.pdf');
    expect(pdfText(byFilter.file.bytes)).toContain('Overdue items');
  });

  it('says so on a certificate for a unit with nothing in the period', async () => {
    const headers = w.as('FIRM_ADMIN').headers;
    const { file } = await exportFile(headers, {
      kind: 'CERTIFICATE_PDF',
      unitId: w.unit1,
      fy: '2030-31',
    });
    const text = pdfText(file.bytes);
    expect(text).toContain('No compliance items in this period.');
    expect(text).toContain('None.');
    expect(text).toContain('No items due');
  });

  it('refuses a certificate without one unit, an unknown unit, and fy with a filter period', async () => {
    const headers = w.as('FIRM_ADMIN').headers;
    const none = await startExport(headers, { kind: 'CERTIFICATE_PDF' });
    expect(none.statusCode).toBe(400);
    expect(none.json().error.details.issues[0].path).toEqual(['unitId']);
    const two = await startExport(headers, {
      kind: 'CERTIFICATE_PDF',
      filters: `unitId=${w.unit1},${w.unit2}`,
    });
    expect(two.statusCode).toBe(400);
    const unknown = await startExport(headers, { kind: 'CERTIFICATE_PDF', unitId: randomUUID() });
    expect(unknown.statusCode).toBe(404);
    const both = await startExport(headers, {
      kind: 'REGISTER_XLSX',
      fy: '2026-27',
      filters: 'dueFrom=2026-01-01',
    });
    expect(both.statusCode).toBe(400);
    const badFilter = await startExport(headers, { kind: 'REGISTER_XLSX', filters: 'status=NOPE' });
    expect(badFilter.statusCode).toBe(400);
  });

  it('lets only firm staff and viewers export as at another date', async () => {
    const admin = w.as('CLIENT_ADMIN').headers;
    const refused = await startExport(admin, { kind: 'REGISTER_XLSX', filters: 'asOf=2026-07-01' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.details).toEqual({ action: 'export.create' });
    const viewer = w.as('VIEWER').headers;
    const { job } = await exportFile(viewer, {
      kind: 'OVERDUE_REPORT_XLSX',
      filters: 'asOf=2026-07-01',
    });
    expect(job.params).toMatchObject({ asOf: '2026-07-01' });
  });

  it('honours Idempotency-Key for the same person and refuses a malformed key', async () => {
    const signed = w.as('CLIENT_ADMIN');
    const key = randomUUID();
    const before = w.store.jobs.size;
    const first = await startExport(
      signed.headers,
      { kind: 'REGISTER_XLSX' },
      { 'idempotency-key': key },
    );
    const again = await startExport(
      signed.headers,
      { kind: 'REGISTER_XLSX' },
      { 'idempotency-key': key },
    );
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());
    expect(w.store.jobs.size).toBe(before + 1);
    const other = w.as('CLIENT_ADMIN');
    const theirs = await startExport(
      other.headers,
      { kind: 'REGISTER_XLSX' },
      { 'idempotency-key': key },
    );
    expect(theirs.json().id).not.toBe(first.json().id);
    // The same key for another client or another request is refused, not answered with the first job.
    const admin = w.as('FIRM_ADMIN');
    const firmKey = randomUUID();
    await startExport(admin.headers, { kind: 'REGISTER_XLSX' }, { 'idempotency-key': firmKey });
    const otherClient = await startExport(
      admin.headers,
      { kind: 'REGISTER_XLSX' },
      { 'idempotency-key': firmKey },
      w.secondClientId,
    );
    expect(otherClient.statusCode).toBe(400);
    expect(otherClient.json().error.code).toBe('VALIDATION');
    const otherBody = await startExport(
      signed.headers,
      { kind: 'ACT_REPORT_XLSX' },
      { 'idempotency-key': key },
    );
    expect(otherBody.statusCode).toBe(400);
    const bad = await startExport(
      signed.headers,
      { kind: 'REGISTER_XLSX' },
      { 'idempotency-key': 'x' },
    );
    expect(bad.statusCode).toBe(400);
    await w.runner.idle();
  });

  it('records an EXPORT audit event for each export', async () => {
    const signed = w.as('FIRM_ADMIN');
    const res = await startExport(signed.headers, { kind: 'ACT_REPORT_XLSX' });
    await w.runner.idle();
    expect(w.store.audit.find((e) => e.entityId === res.json().id)).toMatchObject({
      action: 'EXPORT',
      entityType: 'export',
      actorId: signed.personId,
      clientId: w.clientId,
    });
  });

  it('shows a job and its download link only to the person who asked for it', async () => {
    const mine = w.as('CLIENT_ADMIN');
    const res = await startExport(mine.headers, { kind: 'REGISTER_XLSX' });
    const id = res.json().id as string;
    const notReady = await w.app.inject({
      url: `/api/v1/exports/${id}/download-url`,
      headers: mine.headers,
    });
    expect(notReady.statusCode).toBe(404);
    await w.runner.idle();
    const link = await w.app.inject({
      url: `/api/v1/exports/${id}/download-url`,
      headers: mine.headers,
    });
    expect(link.statusCode).toBe(200);
    const body = ENDPOINTS.exportDownloadUrl.response.parse(link.json());
    expect(body.expiresAt).toBe(new Date(NOW.getTime() + 300_000).toISOString());

    const someoneElse = w.as('CLIENT_ADMIN').headers;
    for (const url of [`/api/v1/exports/${id}`, `/api/v1/exports/${id}/download-url`]) {
      expect((await w.app.inject({ url, headers: someoneElse })).statusCode).toBe(404);
    }
    const unknown = await w.app.inject({
      url: `/api/v1/exports/${randomUUID()}`,
      headers: mine.headers,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('refuses a job once the person loses export access to its client', async () => {
    const personId = randomUUID();
    const admin = w.as('CLIENT_ADMIN', {}, personId);
    const res = await startExport(admin.headers, { kind: 'REGISTER_XLSX' });
    await w.runner.idle();
    const owner = w.as('OWNER', {}, personId);
    const read = await w.app.inject({
      url: `/api/v1/exports/${res.json().id}`,
      headers: owner.headers,
    });
    expect(read.statusCode).toBe(403);
  });

  it('marks a job FAILED when it cannot be built, without logging its contents', async () => {
    const headers = w.as('FIRM_ADMIN').headers;
    w.store.failNextStatusUpdate = true;
    const res = await startExport(headers, { kind: 'REGISTER_XLSX' });
    await w.runner.idle();
    const job = (await w.app.inject({ url: `/api/v1/exports/${res.json().id}`, headers })).json();
    expect(job.status).toBe('FAILED');
    const link = await w.app.inject({ url: `/api/v1/exports/${job.id}/download-url`, headers });
    expect(link.statusCode).toBe(404);
  });

  it('rate limits export requests', async () => {
    const auth = createTestAuth();
    const app = buildServer({
      authStore: auth.store,
      clock: () => NOW,
      reports: { store: w.store },
    });
    const headers = auth.signIn({
      firmId: w.firmId,
      memberships: [{ role: 'FIRM_ADMIN' }],
      principal: { firmClientIds: [w.clientId] },
    }).headers;
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `${base}/exports`,
        headers,
        payload: { kind: 'OVERDUE_REPORT_XLSX' },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 202)).toBe(true);
    expect(codes[10]).toBe(429);
    await app.close();
  });
});
