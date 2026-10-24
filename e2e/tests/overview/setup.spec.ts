import { expect, test } from '@playwright/test';

import { expectNoA11yViolations } from '../../support/a11y.js';
import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// Setup screens (M13) against the web app's demo API. The mock keeps its data for the whole run, so each test
// names what it adds uniquely.
const DEPARTMENTS = `/c/${DEMO_METALS}/setup/departments`;
const REMINDERS = `/c/${DEMO_METALS}/setup/reminders`;
const unique = () => Date.now().toString(36);

test.describe('setup', () => {
  test('a consultant adds, renames and merges departments', async ({ page }) => {
    const tag = unique();
    const quality = `Quality ${tag}`;
    const qc = `QC ${tag}`;
    await signIn(page, 'consultant@demo.test', DEPARTMENTS);
    await expect(page).toHaveTitle('Departments · Demo Metals · PlanetPulse Compliance');
    await expect(page.getByRole('heading', { level: 1, name: 'Departments' })).toBeVisible();
    await checkPage(page);

    for (const name of [quality, qc]) {
      await page.getByLabel('Department name').fill(name);
      await page.getByRole('button', { name: 'Add department' }).click();
      await expect(
        page.getByRole('status').filter({ hasText: `${name} was added.` }),
      ).toBeVisible();
    }
    const table = page.getByRole('table', { name: 'Departments' });
    await expect(table.getByRole('rowheader', { name: quality })).toBeVisible();

    // A second department with the same name is refused in words.
    await page.getByLabel('Department name').fill(quality.toLowerCase());
    await page.getByRole('button', { name: 'Add department' }).click();
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'This client already has a department with that name.' }),
    ).toBeVisible();

    // Rename, with other spellings.
    await page.getByRole('button', { name: `Edit ${quality}` }).click();
    let drawer = page.getByRole('dialog', { name: quality });
    await drawer.getByLabel('Department name').fill(`Quality assurance ${tag}`);
    await drawer.getByLabel('Other spellings').fill(`QA ${tag}`);
    await expectNoA11yViolations(page);
    await drawer.getByRole('button', { name: 'Save changes' }).click();
    await expect(drawer).toBeHidden();
    const renamed = table.getByRole('row').filter({ hasText: `Quality assurance ${tag}` });
    await expect(renamed).toContainText(`QA ${tag}`);

    // Merge the QC department into it.
    await page.getByRole('button', { name: `Edit Quality assurance ${tag}` }).click();
    drawer = page.getByRole('dialog', { name: `Quality assurance ${tag}` });
    await drawer.getByRole('checkbox', { name: qc }).click();
    await drawer.getByRole('button', { name: 'Merge department' }).click();
    const confirm = page.getByRole('alertdialog', {
      name: `Merge ${qc} into Quality assurance ${tag}?`,
    });
    await expectNoA11yViolations(page);
    await confirm.getByRole('button', { name: 'Merge' }).click();
    await expect(drawer).toBeHidden();
    await expect(table.getByRole('rowheader', { name: qc, exact: true })).toHaveCount(0);
    await expect(renamed).toContainText(qc);
    await checkPage(page);
  });

  test('a consultant changes the reminders and sees them read back', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', REMINDERS);
    await expect(page).toHaveTitle('Reminders · Demo Metals · PlanetPulse Compliance');
    await expect(page.getByRole('heading', { level: 1, name: 'Reminders' })).toBeVisible();
    await checkPage(page);

    await page.getByLabel('Remind owners this many days before the due date').fill('10, 3, 0');
    const summary = page.getByRole('region', { name: 'With these settings' });
    await expect(summary).toContainText(
      'Owners are reminded 10 days and 3 days before the due date, and on the due date.',
    );
    await page.getByRole('combobox', { name: "Consultants' weekly digest" }).click();
    await page.getByRole('option', { name: 'Friday' }).click();
    await expect(summary).toContainText('every Friday');
    await page.getByRole('button', { name: 'Save reminders' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Reminder settings saved.' }),
    ).toBeVisible();

    // The saved values come back from the server.
    await page.reload();
    await expect(page.getByLabel('Remind owners this many days before the due date')).toHaveValue(
      '10, 3, 0',
    );
    await expect(page.getByRole('combobox', { name: "Consultants' weekly digest" })).toHaveText(
      'Friday',
    );

    // A value it cannot save is marked and holds the save.
    await page.getByLabel('Remind owners this many days before the due date').fill('120');
    await expect(
      page.getByLabel('Remind owners this many days before the due date'),
    ).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('button', { name: /Save reminders/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await checkPage(page);
  });

  test('keyboard only: a department is added and opened for editing', async ({ page }) => {
    const name = `Legal ${unique()}`;
    await signIn(page, 'consultant@demo.test', DEPARTMENTS);
    await expect(page.getByRole('heading', { level: 1, name: 'Departments' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Department name')).toBeFocused();
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: `${name} was added.` })).toBeVisible();
    const edit = page.getByRole('button', { name: `Edit ${name}` });
    await edit.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name });
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(edit).toBeFocused();
  });

  test('a client owner cannot open setup', async ({ page }) => {
    await signIn(page, 'owner@demo.test', DEPARTMENTS);
    await expect(page.getByLabel('Department name')).toHaveCount(0);
    await checkPage(page);
  });
});

test.describe('setup at 375px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('departments and reminders fit the screen', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', DEPARTMENTS);
    await expect(page.getByRole('heading', { level: 1, name: 'Departments' })).toBeVisible();
    await checkPage(page);
    await page.goto(REMINDERS);
    await expect(page.getByRole('heading', { level: 1, name: 'Reminders' })).toBeVisible();
    await checkPage(page);
  });
});
