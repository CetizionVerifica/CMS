import { expect, test } from '@playwright/test';

import { checkPage, signIn } from '../shell/helpers.js';

// Library (M13) against the web app's demo API: Acts and obligations come from M0's mock server through M11's
// delegation. Filters and search live in the URL, so the checks read the URL and the rows rather than exact counts.

test.describe('library', () => {
  test('a consultant lands on Acts, searches, and opens an Act’s obligations', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', '/library');
    await expect(page).toHaveURL('/library/acts');
    await expect(page).toHaveTitle('Acts · PlanetPulse Compliance');
    await expect(page.getByRole('heading', { level: 1, name: 'Acts' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Library' });
    await expect(nav.getByRole('link', { name: 'Acts' })).toHaveAttribute('aria-current', 'page');
    await checkPage(page);

    const acts = page.getByRole('table', { name: 'Acts' });
    await expect(acts.getByRole('row').nth(1)).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search Acts' }).fill('Factories');
    await expect(page).toHaveURL(/\/library\/acts\?q=Factories$/);
    await expect(acts.getByRole('row')).toHaveCount(2);

    await acts.getByRole('link', { name: 'Factories Act, 1948' }).click();
    await expect(page).toHaveURL(/\/library\/obligations\?actId=[0-9a-f-]{36}$/);
    await expect(page).toHaveTitle('Obligations · PlanetPulse Compliance');
    await expect(nav.getByRole('link', { name: 'Obligations' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const obligations = page.getByRole('table', { name: 'Obligations' });
    await expect(obligations.getByRole('row').nth(1)).toBeVisible();
    for (const row of await obligations
      .getByRole('row')
      .all()
      .then((rows) => rows.slice(1))) {
      await expect(row).toContainText('Factories Act, 1948');
    }
    await checkPage(page);
  });

  test('obligation search is kept in the URL and the back button undoes it', async ({ page }) => {
    await signIn(page, 'admin@demo.test', '/library/obligations');
    await expect(page.getByRole('heading', { level: 1, name: 'Obligations' })).toBeVisible();
    await checkPage(page);
    const obligations = page.getByRole('table', { name: 'Obligations' });
    const before = await obligations.getByRole('row').count();

    await page.getByRole('searchbox', { name: 'Search obligations' }).fill('zzzz-no-match');
    await expect(page).toHaveURL(/\/library\/obligations\?q=zzzz-no-match$/);
    await expect(page.getByText('0 obligations', { exact: true })).toBeVisible();
    await checkPage(page);

    await page.goBack();
    await expect(page).toHaveURL('/library/obligations');
    await expect(obligations.getByRole('row')).toHaveCount(before);
  });

  test('keyboard only: the library tabs and the first Act are reachable', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', '/library/acts');
    await expect(page.getByRole('heading', { level: 1, name: 'Acts' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    const nav = page.getByRole('navigation', { name: 'Library' });
    await expect(nav.getByRole('link', { name: 'Acts' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(nav.getByRole('link', { name: 'Obligations' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/library/obligations');
  });
});

test.describe('library at 375px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('both pages fit the screen', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', '/library/acts');
    await expect(page.getByRole('table', { name: 'Acts' })).toBeVisible();
    await checkPage(page);
    await page.goto('/library/obligations');
    await expect(page.getByRole('table', { name: 'Obligations' })).toBeVisible();
    await checkPage(page);
  });
});
