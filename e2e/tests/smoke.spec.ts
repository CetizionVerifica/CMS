import { expect, test } from '@playwright/test';

// Proves the e2e harness runs end to end. Replace with real journeys in M14.
test('web app serves the home page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible();
});

test('api answers health', async ({ request }) => {
  const res = await request.get('http://localhost:4000/health');
  expect(res.ok()).toBe(true);
});
