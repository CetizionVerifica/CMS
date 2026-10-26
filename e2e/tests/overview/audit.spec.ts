import { expect, test } from '@playwright/test';

import { DEMO_METALS, signIn } from '../shell/helpers.js';
import { checkSettled } from './settled.js';

// The audit trail (M13) against the web app's demo API: a change made in Setup shows up, newest first, with who made
// it; the kind filter lives in the URL; client roles that may not read the trail get the no-access page.
const AUDIT = `/c/${DEMO_METALS}/audit`;
const DEPARTMENTS = `/c/${DEMO_METALS}/setup/departments`;

test.describe('audit trail', () => {
  test('a change made in setup is on the trail, and the filter narrows it', async ({ page }) => {
    const name = `Secretarial ${Date.now().toString(36)}`;
    await signIn(page, 'consultant@demo.test', DEPARTMENTS);
    await page.getByLabel('Department name').fill(name);
    await page.getByRole('button', { name: 'Add department' }).click();
    await expect(page.getByRole('status').filter({ hasText: `${name} was added.` })).toBeVisible();

    await page.goto(AUDIT);
    await expect(page).toHaveTitle('Audit trail · Demo Metals · PlanetPulse Compliance');
    const table = page.getByRole('table', { name: 'Audit trail' });
    // Found by its unique name, not as the first row: another journey's change on the demo firm can share the mock's
    // fixed timestamp and sort above it.
    const added = table.getByRole('row').filter({ hasText: `Name: ${name}` });
    await expect(added).toHaveCount(1);
    await expect(added).toContainText('Added a department');
    await expect(added).toContainText(name);
    await checkSettled(page);

    await page.getByRole('button', { name: /Kind of change/ }).click();
    await page.getByRole('checkbox', { name: 'Evidence' }).click();
    await expect(page).toHaveURL(`${AUDIT}?kind=evidence`);
    await expect(table.getByRole('row').filter({ hasText: name })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await checkSettled(page);

    await page.goto(`${AUDIT}?kind=setup`);
    await expect(table.getByRole('row').filter({ hasText: name })).toHaveCount(1);
  });

  test('keyboard only: the filter opens and closes from the keyboard', async ({ page }) => {
    await signIn(page, 'admin@demo.test', AUDIT);
    const filter = page.getByRole('button', { name: /Kind of change/ });
    await filter.focus();
    await page.keyboard.press('Enter');
    const option = page.getByRole('checkbox', { name: 'Setup changes' });
    await expect(option).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(option).toBeHidden();
    await expect(filter).toBeFocused();
  });

  test('owners and approvers cannot open the audit trail', async ({ page }) => {
    for (const email of ['owner@demo.test', 'approver@demo.test']) {
      await page.context().clearCookies();
      await signIn(page, email, AUDIT);
      await expect(page.getByRole('heading', { name: /You don’t have access/ })).toBeVisible();
      await expect(page.getByRole('table', { name: 'Audit trail' })).toHaveCount(0);
      await checkSettled(page);
    }
  });

  test('a viewer reads the trail but not the setup pages', async ({ page }) => {
    await signIn(page, 'viewer@demo.test', AUDIT);
    await expect(page.getByRole('heading', { level: 1, name: 'Audit trail' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Audit trail' })).toBeVisible();
    await checkSettled(page);

    await page.goto(DEPARTMENTS);
    await expect(page.getByRole('heading', { name: /You don’t have access/ })).toBeVisible();
    await checkSettled(page);
  });

  test('the trail reads at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page, 'consultant@demo.test', AUDIT);
    await expect(page.getByRole('heading', { level: 1, name: 'Audit trail' })).toBeVisible();
    await checkSettled(page);
  });
});
