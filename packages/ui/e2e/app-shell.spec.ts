import { expect, test } from '@playwright/test';

import { expectNoA11yViolations } from './a11y';

test.describe('desktop', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1100, 'sidebar layout only');

  test('tab order: skip link, sidebar, top bar, main; skip link moves focus to main', async ({
    page,
  }) => {
    await page.goto('/#/shell/register');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link').first(),
    ).toBeFocused();
    const register = page.getByRole('link', { name: 'Register' });
    await expect(register).toHaveAttribute('aria-current', 'page');

    await skip.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
  });

  test('"/" focuses search and following a nav link focuses the new page title', async ({
    page,
  }) => {
    await page.goto('/#/shell/overview');
    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox', { name: 'Search obligations' })).toBeFocused();
    await page.getByRole('link', { name: /^Approvals/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeFocused();
    await expect(page).toHaveTitle('Approvals · Hindalco Belur · Canopy');
  });

  test('sidebar text is on-forest-muted, the selected item on-forest', async ({ page }) => {
    await page.goto('/#/shell/register');
    const color = (name: string) =>
      page.getByRole('link', { name, exact: true }).evaluate((el) => getComputedStyle(el).color);
    expect(await color('Register')).toBe('rgb(255, 255, 255)');
    expect(await color('Calendar')).toBe('rgb(207, 227, 214)');
  });
});

test.describe('mobile', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 640, 'sheet layout only');

  test('the menu opens as a bottom sheet, Esc closes it and returns focus', async ({ page }) => {
    await page.goto('/#/shell/overview');
    await expect(page.getByRole('navigation')).toHaveCount(0);
    const open = page.getByRole('button', { name: 'Open menu' });
    await open.focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Menu' });
    await expect(sheet).toBeVisible();
    await expectNoA11yViolations(page);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(open).toBeFocused();
  });

  test('search collapses into a button that expands a full-width field', async ({ page }) => {
    await page.goto('/#/shell/overview');
    await page.getByRole('button', { name: 'Search' }).click();
    const field = page.getByRole('searchbox', { name: 'Search obligations' });
    await expect(field).toBeVisible();
    const box = await field.boundingBox();
    expect(box!.width).toBeGreaterThan(300);
  });
});
