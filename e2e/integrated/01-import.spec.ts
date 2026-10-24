import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { apiAs } from './api.js';
import { checkPage, pageAs, seeded } from './helpers.js';

// A consultant imports the anonymised sample register into Kestrel Metals Group through the real importer, so every
// later journey works on its register: 424 rows, which become 422 instances of 119 obligations. Golden counts: docs/requirements/excel-analysis.md §5.
const SAMPLE = fileURLToPath(
  new URL('../../packages/importer/fixtures/sample-register-anonymised.xlsx', import.meta.url),
);

test('a consultant imports the sample register: upload, map, review, dry run, commit', async ({
  browser,
}) => {
  const page = await pageAs(browser, 'consultant');
  const IMPORT = `/c/${seeded().clients.kestrel}/import`;
  await page.goto(IMPORT);
  await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible();
  await checkPage(page);

  await page.locator('input[type="file"]').setInputFiles(SAMPLE);
  await expect(page).toHaveURL(new RegExp(`${IMPORT}\\?batch=[0-9a-f-]{36}$`));
  await expect(page.getByRole('heading', { level: 2, name: 'Map the columns' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/19 of 19 columns are mapped/)).toBeVisible();
  await checkPage(page);
  await page.getByRole('button', { name: 'Read the rows' }).click();

  await expect(page.getByRole('heading', { level: 2, name: 'Review the cleaning' })).toBeVisible({
    timeout: 30_000,
  });
  await checkPage(page);
  const decide = page.getByRole('region', { name: 'Needs a decision' });
  const acceptAll = page.getByRole('button', { name: /^Accept every proposal \(\d+\)$/ });
  await acceptAll.click();
  await expect(acceptAll).toHaveCount(0);
  // Groups without a proposal keep the workbook's values, one decision at a time.
  const keep = decide.getByRole('button', { name: 'Keep as written' });
  for (let left = await keep.count(); left > 0; left -= 1) {
    await keep.first().click();
    await expect(keep).toHaveCount(left - 1);
  }
  await expect(decide).toHaveCount(0);

  await page.getByRole('button', { name: 'Run the dry run' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Dry run' })).toBeVisible({
    timeout: 30_000,
  });
  await checkPage(page);
  const batchId = new URL(page.url()).searchParams.get('batch')!;
  const api = await apiAs('consultant');
  const batch = (await api.get(`/imports/${batchId}`)).body as {
    dryRun: { create: { obligations: number; instances: number }; blockingErrors: number };
  };
  expect(batch.dryRun).toMatchObject({
    create: { obligations: 119, instances: 422 },
    blockingErrors: 0,
  });
  await page.getByRole('button', { name: 'Commit the import' }).click();
  const dialog = page.getByRole('alertdialog', {
    name: /Commit this import to Kestrel Metals Group\?/,
  });
  await dialog.getByRole('button', { name: 'Commit the import' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Import committed' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('status')).toContainText('424 rows');
  await checkPage(page);

  // The firm's library now holds the register's 119 obligations (03 checks the 422 instances).
  let obligations = 0;
  for (let cursor = ''; ;) {
    const res = await api.get(`/library/obligations?limit=100${cursor}`);
    expect(res.status).toBe(200);
    const body = res.body as { items: unknown[]; nextCursor: string | null };
    obligations += body.items.length;
    if (!body.nextCursor) break;
    cursor = `&cursor=${encodeURIComponent(body.nextCursor)}`;
  }
  expect(obligations).toBe(119);
  await api.dispose();
});
