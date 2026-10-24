import { expect, type Page } from '@playwright/test';

import { checkPage } from '../shell/helpers.js';

/**
 * checkPage, once the page has its title back. A server action's refresh re-renders the client layout, and for a
 * moment the document has no <title>, which axe reports as a violation.
 */
export async function checkSettled(page: Page): Promise<void> {
  await expect(page).toHaveTitle(/PlanetPulse Compliance$/);
  await checkPage(page);
}
