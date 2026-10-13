import { devices, expect, test } from '@playwright/test';

import { checkPage, DEMO_METALS, signIn } from './helpers.js';

test.describe('shell at 375px on a phone', () => {
  test.use({
    viewport: { width: 375, height: 740 },
    userAgent: devices['iPhone 13'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test('the first server render is already the phone layout (no sidebar flash)', async ({
    page,
    request,
  }) => {
    await signIn(page, 'owner@demo.test');
    // Fetch the raw HTML with the browser's cookies minus the saved layout, so only the user agent hints the size.
    const cookies = (await page.context().cookies()).filter((c) => c.name !== 'pp_layout');
    const res = await request.get(`/c/${DEMO_METALS}/overview`, {
      headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
    });
    const html = await res.text();
    expect(html).toContain('data-layout="sheet"');
    expect(html).not.toContain('data-layout="sidebar"');
  });

  test('the menu opens as a sheet and every page fits the screen', async ({ page }) => {
    await signIn(page, 'owner@demo.test');
    await checkPage(page);
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open menu' }).click();
    const sheet = page.getByRole('dialog', { name: 'Menu' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('link', { name: 'Register' }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/register`);
    await checkPage(page);
    await page.getByRole('button', { name: 'Search' }).click();
    // The top bar's search, by name: the register page has a search box of its own.
    await expect(
      page.getByRole('searchbox', { name: 'Search this client’s register' }),
    ).toBeVisible();
  });
});

test.describe('shell at 800px', () => {
  test.use({ viewport: { width: 800, height: 900 } });

  test('the sidebar is an icon rail', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `/c/${DEMO_METALS}/overview`);
    await expect(page.locator('[data-layout="rail"]')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Register' })).toBeVisible();
    await checkPage(page);
  });
});
