import { expect, test } from '@playwright/test';

import { galleryRoutes, shellVariants } from '../demo/routes';
import { expectNoA11yViolations, expectNoPageOverflow } from './a11y';

test('the index lists every gallery page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Canopy components' })).toBeVisible();
  for (const r of galleryRoutes)
    await expect(page.getByRole('link', { name: r.title })).toBeVisible();
  await expectNoA11yViolations(page);
});

for (const r of galleryRoutes) {
  test(`${r.title} page is axe-clean and fits the viewport`, async ({ page }) => {
    await page.goto(`/#${r.path}`);
    await expect(page.getByRole('heading', { level: 1, name: r.title })).toBeVisible();
    // Shell frames are clipped by their scroll box here; each variant is checked on its own below.
    await expectNoA11yViolations(page, { exclude: 'iframe' });
    await expectNoPageOverflow(page);
  });
}

for (const v of shellVariants) {
  test(`shell variant "${v.label}" is axe-clean at ${v.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: v.width, height: 800 });
    await page.goto(`/#/shell?${v.query}`);
    await expect(page.getByRole('main')).toBeVisible();
    await expectNoA11yViolations(page);
    await expectNoPageOverflow(page);
  });
}
