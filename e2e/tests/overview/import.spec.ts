import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// The import wizard (M13) against the web app's demo API, which answers imports from M0's mock: every upload reads
// as the sample register (fixtures.md §3), with its cleaning issues, and the commit marks the batch committed.
const SAMPLE = fileURLToPath(
  new URL('../../../packages/importer/fixtures/sample-register-anonymised.xlsx', import.meta.url),
);
const IMPORT = `/c/${DEMO_METALS}/import`;

async function uploadSample(page: Page) {
  await page.locator('input[type="file"]').setInputFiles(SAMPLE);
  await expect(page).toHaveURL(new RegExp(`${IMPORT}\\?batch=[0-9a-f-]{36}$`));
  await expect(page.getByRole('heading', { level: 2, name: 'Map the columns' })).toBeVisible();
}

test.describe('import wizard', () => {
  test('a consultant imports the sample register: upload, map, review, dry run, commit', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', IMPORT);
    await expect(page).toHaveTitle('Import · Demo Metals · PlanetPulse Compliance');
    await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'Import steps' }).getByRole('listitem').first(),
    ).toHaveAttribute('aria-current', 'step');
    await checkPage(page);

    // Map: the suggestion maps every sample column.
    await uploadSample(page);
    const mapping = page.getByRole('table', { name: 'Column mapping' });
    await expect(mapping.getByRole('row')).toHaveCount(20);
    await expect(page.getByText(/19 of 19 columns are mapped/)).toBeVisible();
    await expect(
      mapping.getByRole('combobox', { name: 'Register field for “Due Date”' }),
    ).toHaveText('Due date');
    await checkPage(page);
    await page.getByRole('button', { name: 'Read the rows' }).click();

    // Review: proposals are shown next to the workbook's values, then decided.
    await expect(
      page.getByRole('heading', { level: 2, name: 'Review the cleaning' }),
    ).toBeVisible();
    const decide = page.getByRole('region', { name: 'Needs a decision' });
    const hr = decide
      .getByRole('listitem')
      .filter({ hasText: 'Department names that look the same' });
    await expect(hr).toContainText('“HR”, “Human Resources”');
    await expect(hr).toContainText('Proposed: “Human Resources”');
    await checkPage(page);
    await expect(page.getByRole('button', { name: 'Run the dry run' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await page.getByRole('button', { name: /^Accept every proposal \(\d+\)$/ }).click();
    // The Factories Act group has no proposal: the consultant keeps the workbook's names.
    const factories = decide.getByRole('listitem').filter({ hasText: 'Factories Act' });
    await expect(factories).toHaveCount(1);
    await factories.getByRole('button', { name: 'Keep as written' }).click();
    await expect(decide).toHaveCount(0);
    const decided = page.getByRole('region', { name: 'Decided' });
    await expect(
      decided.getByRole('listitem').filter({ hasText: 'Department names that look the same' }),
    ).toContainText('Uses “Human Resources”');
    await expect(decided.getByRole('listitem').filter({ hasText: 'Factories Act' })).toContainText(
      'Kept as written',
    );
    await checkPage(page);

    // Dry run, then commit.
    await page.getByRole('button', { name: 'Run the dry run' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Dry run' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'To add' })).toContainText('Instances');
    await checkPage(page);
    await page.getByRole('button', { name: 'Commit the import' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Commit this import to Demo Metals?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Commit the import' }).click();

    await expect(page.getByRole('heading', { level: 2, name: 'Import committed' })).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: /rows from sample-register-anonymised\.xlsx/ }),
    ).toBeVisible();
    await checkPage(page);

    // The history lists it as committed.
    await page.getByRole('link', { name: 'Start another import' }).click();
    await expect(page).toHaveURL(IMPORT);
    const history = page.getByRole('table', { name: 'Imports' });
    await expect(history.getByRole('row').nth(1)).toContainText('Committed');
  });

  test('an import is resumed where it stopped, and can be cancelled', async ({ page }) => {
    await signIn(page, 'admin@demo.test', IMPORT);
    await uploadSample(page);
    const url = new URL(page.url());
    const href = `${url.pathname}${url.search}`;

    // Leave and come back: the batch's status brings back the mapping.
    await page.goto(`/c/${DEMO_METALS}/overview`);
    await page.goto(IMPORT);
    const history = page.getByRole('table', { name: 'Imports' });
    // The suggested mapping is saved at upload, so the batch is already "Columns mapped".
    const row = history.getByRole('row').filter({ has: page.locator(`a[href="${href}"]`) });
    await expect(row).toContainText('Columns mapped · continue');
    await row.getByRole('link').click();
    await expect(page).toHaveURL(href);
    await expect(page.getByRole('heading', { level: 2, name: 'Map the columns' })).toBeVisible();

    await page.getByRole('button', { name: 'Cancel import' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Cancel this import?' });
    await dialog.getByRole('button', { name: 'Cancel import' }).click();
    await expect(page.getByText('This import was cancelled. Nothing was changed.')).toBeVisible();
    await checkPage(page);
  });

  test('keyboard only: the workbook can be chosen from the drop zone', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', IMPORT);
    await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    const chooser = page.waitForEvent('filechooser');
    await expect(page.locator(':focus')).toHaveAccessibleName(/choose|browse|register workbook/i);
    await page.keyboard.press('Enter');
    await (await chooser).setFiles(SAMPLE);
    await expect(page.getByRole('heading', { level: 2, name: 'Map the columns' })).toBeVisible();
  });

  test('a client owner cannot import', async ({ page }) => {
    await signIn(page, 'owner@demo.test', IMPORT);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await checkPage(page);
  });
});

test.describe('import wizard at 375px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the upload and mapping steps fit the screen', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', IMPORT);
    await checkPage(page);
    await uploadSample(page);
    await checkPage(page);
  });
});
