import { expect, test } from '@playwright/test';

import { apiAs, itemsOf } from './api.js';
import { checkPage, pageAs, seeded } from './helpers.js';

// Dashboards (M10) and the register (M7) both take status from the engine, so every number on the overview must be
// the register's count for the same filter, and the whole register must be counted once (422 instances after the
// import's merges, docs/requirements/excel-analysis.md §5).
const FY = 'fy=2022-23';

interface Overview {
  result: { counts: Record<string, number>; instanceIds: Record<string, string[]> };
}

test('every overview count is the register count for the same status', async () => {
  const { clients } = seeded();
  const consultant = await apiAs('consultant');
  const overview = await consultant.get(`/clients/${clients.kestrel}/overview?${FY}`);
  expect(overview.status).toBe(200);
  const { counts, instanceIds } = (overview.body as Overview).result;
  expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(422);

  for (const status of Object.keys(counts)) {
    // Every page of the register for this status (the API ignores ?count=true: docs/security/review.md F9).
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const query = `${FY}&status=${status}&limit=200${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await consultant.get(`/clients/${clients.kestrel}/instances?${query}`);
      expect(page.status).toBe(200);
      ids.push(...itemsOf(page.body).map((r) => r.id));
      cursor = (page.body as { nextCursor: string | null }).nextCursor;
    } while (cursor);
    expect(ids.sort(), status).toEqual([...instanceIds[status]!].sort());
  }
  await consultant.dispose();
});

test('a consultant reads the overview and follows the overdue number to exactly those rows', async ({
  browser,
}) => {
  const { clients } = seeded();
  const page = await pageAs(browser, 'consultant');
  await page.goto(`/c/${clients.kestrel}/overview?${FY}`);
  await expect(page).toHaveTitle('Overview · Kestrel Metals Group · PlanetPulse Compliance');
  await checkPage(page);
  const overdue = page.getByRole('main').getByRole('link', { name: /^Overdue, \d+, / });
  const shown = Number(
    /^Overdue, (\d+),/.exec((await overdue.getAttribute('aria-label')) ?? '')?.[1],
  );
  expect(shown).toBeGreaterThan(0);
  await overdue.click();
  await expect(page).toHaveURL(new RegExp(`/register\\?status=OVERDUE&${FY}$`));
  await expect(page.getByText(new RegExp(`^${shown} instances? match$`))).toBeVisible();
  await checkPage(page);

  // The portfolio lists the firm's own client only.
  await page.goto('/portfolio');
  await expect(page.getByRole('main')).toContainText('Kestrel Metals Group');
  await expect(page.getByRole('main')).not.toContainText('Osprey Textiles Group');
  await checkPage(page);
});

test('reports add up, and a register export downloads as a workbook from a 5-minute link', async () => {
  const { clients } = seeded();
  const admin = await apiAs('clientAdmin');
  for (const kind of ['act-wise', 'department-wise', 'overdue']) {
    const report = await admin.get(`/clients/${clients.kestrel}/reports/${kind}?${FY}`);
    expect(report.status, kind).toBe(200);
  }

  const created = await admin.post(`/clients/${clients.kestrel}/exports`, {
    kind: 'REGISTER_XLSX',
    filters: FY,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const id = (created.body as { id: string }).id;
  await expect
    .poll(async () => ((await admin.get(`/exports/${id}`)).body as { status: string }).status, {
      timeout: 30_000,
    })
    .toBe('DONE');
  const link = await admin.get(`/exports/${id}/download-url`);
  expect(link.status).toBe(200);
  const url = new URL((link.body as { url: string }).url);
  expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  const file = await admin.http.get(url.toString());
  expect(file.status()).toBe(200);
  // An .xlsx is a zip: it starts with "PK".
  expect((await file.body()).subarray(0, 2).toString()).toBe('PK');

  // Reports are not an owner's (endpoints.md), and another person's export is not found rather than forbidden.
  const owner = await apiAs('owner');
  expect((await owner.get(`/clients/${clients.kestrel}/reports/act-wise?${FY}`)).status).toBe(403);
  expect((await owner.get(`/exports/${id}`)).status).toBe(404);
  expect((await owner.get(`/exports/${id}/download-url`)).status).toBe(404);
  await Promise.all([admin.dispose(), owner.dispose()]);
});
