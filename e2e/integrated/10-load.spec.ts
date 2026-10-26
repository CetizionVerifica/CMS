import { performance } from 'node:perf_hooks';

import { expect, request, test, type APIRequestContext } from '@playwright/test';

import pg from 'pg';

import { apiAs } from './api.js';
import { checkPage, pageAs, seeded } from './helpers.js';
import { API_URL, E2E_DATABASE, FIRM_A, databaseUrl, storageStateOf } from './stack.js';

// The load check (MODULES.md M14): firm A's client grown to 10,000 instances, then the reads people make all day,
// from 10 browsers at once, each from its own address so no one shares a rate-limit budget. Runs last: it adds load
// copies of the client's units. The copies are test data written straight to the database (no audit rows), never a
// pattern for production. Budgets have headroom for a shared CI runner; "Load results" in docs/security/review.md
// has the numbers measured when they were set.
const TARGET = 10_000;
const USERS = 10;
const ROUNDS = 3;
const FY = 'fy=2022-23';

/**
 * Budgets in milliseconds: the slowest of three reads by one person alone, and the p95 with all 10 reading at once
 * with no pause between reads. One API process serves every request here, on a runner shared with Postgres, the web
 * app and the browsers. Each whole-client read derives 10,000 statuses in the engine, so 10 people at once queue on
 * that one process: the concurrent figures measure its throughput (security review F17).
 */
const ALONE = {
  overview: 1_500,
  'register, first page of 200': 500,
  'register count': 1_500,
  'act-wise report': 1_500,
  portfolio: 1_000,
} as const;
const BUDGET = {
  overview: 10_000,
  'register, first page of 200': 3_000,
  'register count': 10_000,
  'act-wise report': 10_000,
  portfolio: 3_000,
} as const;

/** FY 2022-23 as the register filters it: due dates in the client's April-to-March year (`fyRangeOf`). */
const FY_FROM = '2022-04-01';
const FY_TO = '2023-03-31';

/**
 * Copies every unit of the client, with its assignments and instances, until the client has at least `target`
 * instances due in FY 2022-23, the year every read below asks for. Counting the whole client instead under-grows
 * the year once earlier journeys leave instances in other years (queue run 40385424693: 10,098 in all, 3,798 in the
 * year). As the database owner, in firm A's tenant context.
 */
async function growClient(clientId: string, target: number): Promise<number> {
  const db = new pg.Client({
    connectionString: databaseUrl(process.env.DATABASE_URL!, E2E_DATABASE),
  });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.firm_id', $1, true)`, [FIRM_A]);
    const count = async () =>
      Number(
        (
          await db.query(
            `SELECT count(*) AS n FROM compliance_instance
             WHERE client_id = $1 AND archived_at IS NULL AND due_date BETWEEN $2 AND $3`,
            [clientId, FY_FROM, FY_TO],
          )
        ).rows[0].n,
      );
    const start = await count();
    expect(start, 'the import journey ran first, with instances in FY 2022-23').toBeGreaterThan(0);
    const units = (
      await db.query(`SELECT id FROM unit WHERE client_id = $1 AND archived_at IS NULL`, [clientId])
    ).rows as { id: string }[];
    const copies = Math.ceil(target / start) - 1;
    for (let k = 1; k <= copies; k++) {
      for (const unit of units) {
        const {
          rows: [copy],
        } = await db.query(
          `INSERT INTO unit (client_id, company_id, name, location_id)
           SELECT client_id, company_id, name || ' (load copy ' || $2 || ')', location_id FROM unit WHERE id = $1
           RETURNING id`,
          [unit.id, k],
        );
        // Each assignment and its instances, keyed by the source assignment through a temporary map.
        await db.query(
          `WITH src AS (
             SELECT a.*, canopy_uuid_v7() AS new_id FROM assignment a WHERE a.unit_id = $1 AND a.archived_at IS NULL
           ), made AS (
             INSERT INTO assignment (id, client_id, unit_id, obligation_id, department_id, default_owner_id,
               default_approver_id, applicability, na_reason, active_from, active_to)
             SELECT new_id, client_id, $2, obligation_id, department_id, default_owner_id, default_approver_id,
               applicability, na_reason, active_from, active_to FROM src
             RETURNING id
           )
           INSERT INTO compliance_instance (client_id, unit_id, assignment_id, period_start, period_end, due_date,
             workflow_state, pending_kind, completed_on, na_reason, owner_id, approver_id, submitted_at, approved_at,
             due_date_overridden)
           SELECT i.client_id, $2, src.new_id, i.period_start, i.period_end, i.due_date, i.workflow_state,
             i.pending_kind, i.completed_on, i.na_reason, i.owner_id, i.approver_id, i.submitted_at, i.approved_at,
             i.due_date_overridden
           FROM compliance_instance i JOIN src ON src.id = i.assignment_id
           WHERE i.archived_at IS NULL`,
          [unit.id, copy.id],
        );
      }
    }
    const total = await count();
    await db.query('COMMIT');
    // Fresh planner statistics, as autovacuum would have after an import this size: without them Postgres plans the
    // register for the tables' old sizes and every read is many times slower.
    await db.query('ANALYZE');
    return total;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }
}

const p95 = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
};

test('at 10,000 instances a client’s main reads stay within budget for 10 people at once', async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const { clients } = seeded();
  const seeding = performance.now();
  const total = await growClient(clients.kestrel, TARGET);
  console.log(
    `load: grew the client to ${total} instances in FY 2022-23 in ${Math.round(performance.now() - seeding)} ms`,
  );
  expect(total).toBeGreaterThanOrEqual(TARGET);

  const client = `/api/v1/clients/${clients.kestrel}`;
  const reads: Record<keyof typeof BUDGET, string> = {
    overview: `${client}/overview?${FY}`,
    'register, first page of 200': `${client}/instances?${FY}&limit=200`,
    'register count': `${client}/instances?${FY}&limit=1&count=true`,
    'act-wise report': `${client}/reports/act-wise?${FY}`,
    portfolio: '/api/v1/portfolio',
  };

  // Half consultants, half client admins; each its own address (TEST-NET-1), as people in different offices.
  const users: APIRequestContext[] = [];
  for (let u = 0; u < USERS; u++) {
    users.push(
      await request.newContext({
        baseURL: API_URL,
        storageState: storageStateOf(u % 2 ? 'clientAdmin' : 'consultant'),
        extraHTTPHeaders: { 'x-forwarded-for': `192.0.2.${10 + u}` },
      }),
    );
  }
  const samples = Object.fromEntries(Object.keys(reads).map((k) => [k, [] as number[]])) as Record<
    keyof typeof BUDGET,
    number[]
  >;
  try {
    // One warm-up pass, so the first query plans and pool connections are not counted.
    for (const path of Object.values(reads)) expect((await users[0]!.get(path)).status()).toBe(200);
    // One person alone, three times each.
    const alone = Object.fromEntries(Object.keys(reads).map((k) => [k, 0])) as Record<
      keyof typeof ALONE,
      number
    >;
    for (let round = 0; round < ROUNDS; round++) {
      for (const [name, path] of Object.entries(reads) as [keyof typeof ALONE, string][]) {
        const started = performance.now();
        expect((await users[0]!.get(path)).status(), name).toBe(200);
        alone[name] = Math.max(alone[name], Math.round(performance.now() - started));
      }
    }
    console.log(`load: ${total} instances, one person, slowest ms ${JSON.stringify(alone)}`);
    for (const name of Object.keys(ALONE) as (keyof typeof ALONE)[]) {
      expect.soft(alone[name], `${name} alone`).toBeLessThanOrEqual(ALONE[name]);
    }
    await Promise.all(
      users.map(async (user, u) => {
        for (let round = 0; round < ROUNDS; round++) {
          for (const [name, path] of Object.entries(reads) as [keyof typeof BUDGET, string][]) {
            // A client admin has no portfolio; only consultants read it.
            if (name === 'portfolio' && u % 2) continue;
            const started = performance.now();
            const res = await user.get(path, { timeout: 60_000 });
            samples[name].push(performance.now() - started);
            expect(res.status(), `${name} for user ${u}`).toBe(200);
          }
        }
      }),
    );
  } finally {
    await Promise.all(users.map((u) => u.dispose()));
  }

  const report = Object.fromEntries(
    (Object.keys(BUDGET) as (keyof typeof BUDGET)[]).map((name) => [
      name,
      Math.round(p95(samples[name])),
    ]),
  );
  console.log(`load: ${total} instances, ${USERS} users, p95 ms ${JSON.stringify(report)}`);
  for (const name of Object.keys(BUDGET) as (keyof typeof BUDGET)[]) {
    expect(report[name]!, `p95 of ${name}`).toBeLessThanOrEqual(BUDGET[name]);
  }

  // The register counts the year's 10,000, and its page renders at that size.
  const admin = await apiAs('clientAdmin');
  const counted = await admin.get(`/clients/${clients.kestrel}/instances?${FY}&limit=1&count=true`);
  expect((counted.body as { total?: number }).total).toBeGreaterThanOrEqual(TARGET);
  await admin.dispose();
  const page = await pageAs(browser, 'clientAdmin');
  const started = performance.now();
  await page.goto(`/c/${clients.kestrel}/register?${FY}`);
  await expect(page.getByRole('grid').or(page.getByRole('table')).first()).toBeVisible();
  console.log(`load: register page shown in ${Math.round(performance.now() - started)} ms`);
  await checkPage(page);
  await page.context().close();

  // The whole register exports within a minute.
  const exporter = await apiAs('clientAdmin');
  const created = await exporter.post(`/clients/${clients.kestrel}/exports`, {
    kind: 'REGISTER_XLSX',
    filters: FY,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const id = (created.body as { id: string }).id;
  const exportStarted = performance.now();
  await expect
    .poll(async () => ((await exporter.get(`/exports/${id}`)).body as { status: string }).status, {
      timeout: 60_000,
      intervals: [500],
    })
    .toBe('DONE');
  console.log(
    `load: register export of ${total} rows in ${Math.round(performance.now() - exportStarted)} ms`,
  );
  await exporter.dispose();
});
