import { readFileSync } from 'node:fs';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { checkPage } from '../tests/shell/helpers.js';
import {
  ACCOUNTS,
  PASSWORD,
  RUN_DIR,
  addressOf,
  storageStateOf,
  totpSecretFileOf,
  type AccountKey,
} from './stack.js';
import { nextUnusedCode } from './totp.js';

export { checkPage };

/** The ids prepare.ts generated (clients and seeded people). */
export function seeded(): {
  clients: { kestrel: string; osprey: string };
  people: Record<AccountKey, string>;
} {
  return JSON.parse(readFileSync(new URL('seed.json', RUN_DIR), 'utf8'));
}

export const isFirmRole = (key: AccountKey) =>
  ACCOUNTS[key].role === 'FIRM_ADMIN' || ACCOUNTS[key].role === 'CONSULTANT';

/**
 * Signs in through the login page (and the code step for firm roles), as a person would. `check` runs on each sign-in
 * page before it is filled in.
 */
export async function signIn(
  page: Page,
  key: AccountKey,
  path = '/',
  check?: (page: Page) => Promise<void>,
): Promise<void> {
  await page.goto(path);
  await expect(page).toHaveURL(/\/login/);
  await check?.(page);
  await page.getByLabel('Work email').fill(ACCOUNTS[key].email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (isFirmRole(key)) {
    await expect(page).toHaveURL(/\/login\/verify/);
    await check?.(page);
    const secret = readFileSync(totpSecretFileOf(key), 'utf8');
    await page.getByLabel('6-digit code').fill(await nextUnusedCode(key, secret));
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await expect(page).not.toHaveURL(/\/login/);
}

/** A number for the running journey, so each journey browses from its own address (stack.ts `addressOf`). */
export function visit(): number {
  let hash = 0;
  for (const char of test.info().testId) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  return hash;
}

/** A page signed in as `key`, from the browser state the setup project saved. */
export async function pageAs(browser: Browser, key: AccountKey): Promise<Page> {
  const context = await browser.newContext({
    storageState: storageStateOf(key),
    extraHTTPHeaders: { 'x-forwarded-for': addressOf(key, visit()) },
  });
  return context.newPage();
}
