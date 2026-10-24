import { readFileSync } from 'node:fs';

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expectNoA11yViolations } from '../support/a11y.js';
import { apiAs } from './api.js';
import { checkPage, pageAs } from './helpers.js';
import { CONSOLE_URL, FIRM_A, FIRM_B, OPERATOR, OPERATOR_TOTP_FILE, WEB_URL } from './stack.js';
import { nextUnusedCode } from './totp.js';

// Company accounts and the operator console (M15, ADR M15-0001): the platform operator signs in with a code, creates
// an account, pauses and reopens one, and reads the operator audit; a customer's account admin lets support in, and
// the operator opens the support session the grant allows. The console is the built app against the real API.

const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 800 };
const SECOND_LEDGER = 'Second Ledger Consulting';

/** Every console page at both widths: axe clean, the client-facing name only, no sideways scroll. */
async function checkBothWidths(page: Page): Promise<void> {
  await page.setViewportSize(PHONE);
  await checkPage(page);
  await page.setViewportSize(DESKTOP);
  await checkPage(page);
}

let console_: BrowserContext;
let operator: Page;

/** Signs the operator in through the console's own sign-in page, as they would with their authenticator app. */
async function operatorSignIn(browser: Browser): Promise<void> {
  console_ = await browser.newContext({ baseURL: CONSOLE_URL, viewport: DESKTOP });
  operator = await console_.newPage();
  // Support sessions open in a new tab; keep the link instead, to open it on the http web app (stack.ts APP_URL).
  await operator.addInitScript(
    `window.open = (url) => { window.__opened = String(url); return null; };`,
  );
  await operator.goto('/accounts');
  await expect(operator).toHaveURL(/\/login/);
  await checkBothWidths(operator);
  await operator.getByLabel('Email').fill(OPERATOR.email);
  await operator.getByLabel('Password').fill(OPERATOR.password);
  const secret = readFileSync(OPERATOR_TOTP_FILE, 'utf8');
  await operator.getByLabel('Authenticator code').fill(await nextUnusedCode('operator', secret));
  await operator.getByRole('button', { name: 'Sign in' }).click();
  await expect(operator).toHaveURL(/\/accounts$/);
}

test.describe.serial('company accounts and the operator console', () => {
  test.beforeAll(async ({ browser }) => operatorSignIn(browser));
  test.afterAll(async () => console_?.close());

  test('the operator sees every account, and no client data', async () => {
    const accounts = operator.getByRole('table', { name: 'Accounts' });
    await expect(accounts.getByRole('link', { name: 'Demo Advisory' })).toBeVisible();
    await expect(accounts.getByRole('link', { name: SECOND_LEDGER })).toBeVisible();
    // Accounts, not their clients: the client names never reach the console.
    await expect(operator.getByText('Kestrel Metals Group')).toHaveCount(0);
    await checkBothWidths(operator);
  });

  test('the operator creates an account, which waits for its owner', async () => {
    await operator.getByRole('link', { name: 'New account' }).first().click();
    await expect(operator.getByRole('heading', { name: 'New account', level: 1 })).toBeVisible();
    await checkBothWidths(operator);
    await operator.getByLabel('Display name').fill('Highmoor Fabrics');
    await operator.getByLabel("Owner's name").fill('Isha Highmoor');
    await operator.getByLabel("Owner's email").fill('owner@highmoor-fabrics.test');
    await operator.getByRole('button', { name: 'Create account' }).click();
    await expect(
      operator.getByRole('heading', { name: 'Highmoor Fabrics', level: 1 }),
    ).toBeVisible();
    await expect(operator.getByText('Waiting for owner').first()).toBeVisible();
    await expect(operator.getByRole('button', { name: 'Resend owner invite' })).toBeVisible();
    await checkBothWidths(operator);
  });

  test('an account admin lets support in, and the operator opens that session', async ({
    browser,
  }) => {
    const admin = await pageAs(browser, 'firmAdmin');
    await admin.goto('/account');
    await expect(
      admin.getByRole('heading', { name: 'PlanetPulse support access', level: 2 }),
    ).toBeVisible();
    await checkPage(admin);
    // The security journey leaves a grant of firm A's live; the admin ends it first, so this one starts fresh.
    const endNow = admin.getByRole('button', { name: 'End access now' });
    if (await endNow.isVisible()) {
      await endNow.click();
      await admin
        .getByRole('alertdialog', { name: 'End PlanetPulse support access now?' })
        .getByRole('button', { name: 'End access' })
        .click();
      await expect(endNow).toHaveCount(0);
    }
    await admin.getByRole('button', { name: 'Let support in' }).click();
    await expect(admin.getByRole('button', { name: 'End access now' })).toBeVisible();
    await admin.context().close();

    await operator.goto(`/accounts/${FIRM_A}`);
    await expect(operator.getByRole('heading', { name: 'Demo Advisory', level: 1 })).toBeVisible();
    const grants = operator.getByRole('table', { name: 'Support grants' });
    const live = grants.getByRole('row').filter({ hasText: 'Active' });
    await expect(live).toHaveCount(1);
    await expect(live.getByText('Read only')).toBeVisible();
    await checkBothWidths(operator);
    await live.getByRole('button', { name: 'Open support session' }).click();
    await expect.poll(() => operator.evaluate<string | undefined>('window.__opened')).toBeTruthy();
    const link = new URL((await operator.evaluate<string>('window.__opened'))!);
    // The token rides in the fragment, never the query (ADR M15-0003 decision 7).
    expect(link.search).toBe('');
    expect(link.hash).toMatch(/^#token=/);

    // Support opens the link in a browser of its own: no customer session in it.
    const support = await browser.newContext({
      extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.50' },
    });
    const page = await support.newPage();
    await page.goto(`${WEB_URL}${link.pathname}${link.hash}`);
    await expect(page).not.toHaveURL(/\/support\/start/);
    await expect(page.getByText('PlanetPulse support').first()).toBeVisible();
    await checkPage(page);
    await support.close();
  });

  test('the operator pauses an account, nobody in it gets in, then reopens it', async () => {
    await operator.goto(`/accounts/${FIRM_B}`);
    await expect(operator.getByRole('heading', { name: SECOND_LEDGER, level: 1 })).toBeVisible();

    // A session of the account's, open before the pause: it is refused while the account is paused, and works again after.
    const ospreyAdmin = await apiAs('ospreyAdmin');
    expect((await ospreyAdmin.get('/clients')).status).toBe(200);

    await operator.getByRole('button', { name: 'Suspend account' }).click();
    const suspend = operator.getByRole('alertdialog', { name: `Suspend ${SECOND_LEDGER}?` });
    await suspend.getByLabel('Reason').fill('Invoice unpaid for 60 days (integrated journey).');
    // An open dialog hides the page behind it, its heading too, so axe alone checks it.
    await expectNoA11yViolations(operator);
    await suspend.getByRole('button', { name: 'Suspend account' }).click();
    await expect(
      operator.getByText(`${SECOND_LEDGER} is suspended.`, { exact: true }),
    ).toBeVisible();
    await expect(operator.getByRole('button', { name: 'Resume account' })).toBeVisible();

    const paused = await ospreyAdmin.get('/clients');
    expect(paused.status).toBeGreaterThanOrEqual(400);
    expect(paused.body).toMatchObject({ error: { code: 'ACCOUNT_SUSPENDED' } });

    await operator.getByRole('button', { name: 'Resume account' }).click();
    const resume = operator.getByRole('alertdialog', { name: `Resume ${SECOND_LEDGER}?` });
    await resume.getByLabel('Reason').fill('Invoice paid (integrated journey).');
    await resume.getByRole('button', { name: 'Resume account' }).click();
    await expect(
      operator.getByText(`${SECOND_LEDGER} is open again.`, { exact: true }),
    ).toBeVisible();
    await expect(operator.getByRole('button', { name: 'Suspend account' })).toBeVisible();

    expect((await ospreyAdmin.get('/clients')).status).toBe(200);
    await ospreyAdmin.dispose();
  });

  test('the operator audit records each step, with its reason', async () => {
    await operator.getByRole('link', { name: 'Operator audit' }).first().click();
    await expect(operator.getByRole('heading', { name: 'Operator audit', level: 1 })).toBeVisible();
    const audit = operator.getByRole('table', { name: 'Operator audit' });
    await expect(audit.getByText('Created account').first()).toBeVisible();
    await expect(audit.getByText('Invoice unpaid for 60 days (integrated journey).')).toBeVisible();
    await expect(audit.getByText('Invoice paid (integrated journey).')).toBeVisible();
    // Operator audit never carries a person's name or email (apps/api/src/platform/CLAUDE.md).
    await expect(audit.getByText('owner@highmoor-fabrics.test')).toHaveCount(0);
    await checkBothWidths(operator);
  });
});
