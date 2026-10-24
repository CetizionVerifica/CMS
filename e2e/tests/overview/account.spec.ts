import { expect, test } from '@playwright/test';

import { signIn } from '../shell/helpers.js';
import { checkSettled } from './settled.js';

// The Account page (M13) against the web app's demo API: the account admin reads the plan beside its usage, lets
// PlanetPulse support in and ends that access from the keyboard; other roles get the no-access page. Workers share one
// demo API, so this is the only journey that changes support access.
test.describe('account', () => {
  test('an account admin lets support in and ends the access', async ({ page }) => {
    await signIn(page, 'admin@demo.test', '/account');
    await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Plan limits and usage' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Download your data' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Download the archive of / }).first(),
    ).toBeVisible();
    await checkSettled(page);

    const end = page.getByRole('button', { name: 'End access now' });
    if (await end.count()) {
      // A grant left live by an earlier run: end it first, so the journey starts from no access.
      await end.click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'End access' }).click();
      await expect(end).toHaveCount(0);
    }

    await page.getByRole('radio', { name: /Read only/ }).check();
    await page.getByRole('button', { name: 'Let support in' }).click();
    await expect(page.getByText(/Read only access until/)).toBeVisible();
    await expect(
      page.getByRole('table', { name: 'Support access history' }).getByRole('row', {
        name: /Read only Active/,
      }),
    ).toBeVisible();
    await checkSettled(page);

    await end.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog', { name: 'End PlanetPulse support access now?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'End access' }).click();
    await expect(dialog).toBeHidden();
    await expect(end).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Let support in' })).toBeVisible();
    await checkSettled(page);

    // Admin access is confirmed first; cancelling gives nothing.
    await page.getByRole('radio', { name: /Admin/ }).check();
    await page.getByRole('button', { name: 'Let support in' }).click();
    const admin = page.getByRole('alertdialog', { name: 'Give PlanetPulse support admin access?' });
    await expect(admin).toContainText('Admin access for 7 days');
    await admin.getByRole('button', { name: 'Cancel' }).click();
    await expect(admin).toBeHidden();
    await expect(end).toHaveCount(0);
  });

  test('the page reads at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page, 'admin@demo.test', '/account');
    await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
    await checkSettled(page);
  });

  test('a consultant cannot open the account page', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', '/account');
    await expect(page.getByRole('heading', { name: /You don’t have access/ })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Plan limits and usage' })).toHaveCount(0);
    await checkSettled(page);
  });
});
