import { readFileSync } from 'node:fs';

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import pg from 'pg';

import { expectNoA11yViolations } from '../support/a11y.js';
import { apiAs } from './api.js';
import { checkPage, pageAs, seeded } from './helpers.js';
import { latestTo, type Mail } from './mailbox.js';
import {
  APP_URL,
  CONSOLE_URL,
  E2E_DATABASE,
  FIRM_A,
  FIRM_B,
  OPERATOR,
  OPERATOR_LOGIN,
  OPERATOR_LOGIN_PASSWORD,
  OPERATOR_TOTP_FILE,
  WEB_URL,
  databaseUrl,
} from './stack.js';
import { nextUnusedCode } from './totp.js';

// Company accounts and the operator console (M15, ADR M15-0001): the platform operator signs in with a code, creates
// an account, pauses and reopens one, and reads the operator audit; a customer's account admin lets support in, and
// the operator opens the support session the grant allows. The console is the built app against the real API.

const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 800 };
const SECOND_LEDGER = 'Second Ledger Consulting';
/** The account the operator creates, and its owner, who accepts the emailed invite. Fictional. */
const HIGHMOOR = {
  name: 'Highmoor Fabrics',
  owner: 'Isha Highmoor',
  email: 'owner@highmoor-fabrics.test',
  password: 'highmoor owner password',
} as const;

/** The invite link in an invite email: on the customer app's origin (APP_URL), its token in the path. */
function inviteLink(mail: Mail | undefined): URL | undefined {
  const href = mail && /https?:\/\/[^\s"<>]+\/invite\/[^\s"<>]+/.exec(mail.text)?.[0];
  return href ? new URL(href) : undefined;
}

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
    await operator.getByLabel('Display name').fill(HIGHMOOR.name);
    await operator.getByLabel("Owner's name").fill(HIGHMOOR.owner);
    await operator.getByLabel("Owner's email").fill(HIGHMOOR.email);
    await operator.getByRole('button', { name: 'Create account' }).click();
    await expect(operator.getByRole('heading', { name: HIGHMOOR.name, level: 1 })).toBeVisible();
    await expect(operator.getByText('Waiting for owner').first()).toBeVisible();
    await expect(operator.getByRole('button', { name: 'Resend owner invite' })).toBeVisible();
    await checkBothWidths(operator);
  });

  test('the owner accepts the emailed invite, sets up sign-in codes, and the account opens', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const accountPage = operator.url();
    // The invite goes out through the outbox relay and then the email job, each once a minute.
    let link: URL | undefined;
    await expect
      .poll(
        () => {
          link = inviteLink(latestTo(HIGHMOOR.email));
          return link?.pathname;
        },
        { timeout: 180_000, intervals: [5_000] },
      )
      .toMatch(/^\/invite\//);
    // The link points at the customer app (APP_URL); the run serves it on WEB_URL, over http.
    expect(link!.origin).toBe(new URL(APP_URL).origin);
    expect(link!.search).toBe('');

    const owner = await browser.newContext({
      extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.51' },
    });
    const page = await owner.newPage();
    await page.goto(`${WEB_URL}${link!.pathname}`);
    await expect(
      page.getByRole('heading', { name: `Welcome, ${HIGHMOOR.owner}`, level: 1 }),
    ).toBeVisible();
    await expect(page.getByLabel('Work email')).toHaveValue(HIGHMOOR.email);
    await checkPage(page);
    // An account admin signs in with a code too, so the invite page sets up the authenticator before the account
    // exists (F14, ADR M5-0003): the first code goes with the password, and no session ever lacks MFA.
    await page.getByRole('button', { name: 'Get a setup key' }).click();
    const key = (await page.locator('code').first().textContent())!.replace(/\s+/g, '');
    await checkPage(page);
    // The account opens only once its library is copied (ADR M15-0001 decision 8), a job of its own; until then the
    // page asks to try again in a moment. Each try takes a fresh code: the API accepts a step once.
    await expect(async () => {
      await page.getByLabel('Choose a password').fill(HIGHMOOR.password);
      await page.getByLabel('Repeat the password').fill(HIGHMOOR.password);
      await page.getByLabel('6-digit code').fill(await nextUnusedCode('highmoorOwner', key));
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(page).not.toHaveURL(/\/invite\//, { timeout: 15_000 });
    }).toPass({ timeout: 180_000, intervals: [5_000] });
    // Straight into the app: the codes are already set up, so there is no setup step after the invite.
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await checkPage(page);
    await owner.close();

    // The link is spent, and the console shows the account open, in its trial.
    const spent = await browser.newContext();
    const again = await spent.newPage();
    await again.goto(`${WEB_URL}${link!.pathname}`);
    await expect(
      again.getByRole('heading', { name: 'This invite isn’t valid', level: 1 }),
    ).toBeVisible();
    await spent.close();
    await operator.goto(accountPage);
    await expect(operator.getByRole('heading', { name: HIGHMOOR.name, level: 1 })).toBeVisible();
    await expect(operator.getByText('Trial').first()).toBeVisible();
    await expect(operator.getByRole('button', { name: 'Resend owner invite' })).toHaveCount(0);
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

  test('a lowered limit stops the account at it, and lifting it lets the account grow again', async ({
    browser,
  }) => {
    const { clients } = seeded();
    await operator.goto(`/accounts/${FIRM_B}`);
    await expect(operator.getByRole('heading', { name: SECOND_LEDGER, level: 1 })).toBeVisible();
    const limits = operator.getByRole('table', { name: 'Limits and usage' });
    const companies = limits.getByRole('row').filter({ hasText: 'Companies' });
    const used = Number(
      /^\d+/.exec((await companies.getByRole('cell').first().textContent())!)?.[0],
    );
    expect(Number.isInteger(used)).toBe(true);

    // Hold the account at the companies it has.
    await operator.getByRole('button', { name: 'Override limits' }).click();
    const hold = operator.getByRole('dialog', { name: 'Override limits' });
    await hold.getByLabel('Companies').fill(String(used));
    await hold.getByLabel('Reason').fill('Hold at current companies (integrated journey).');
    await expectNoA11yViolations(operator);
    await hold.getByRole('button', { name: 'Save override' }).click();
    await expect(operator.getByText('Limits saved.', { exact: true })).toBeVisible();
    await expect(companies).toContainText('At limit');

    // The account admin sees it on their account page; one more company is refused, with the numbers.
    const admin = await pageAs(browser, 'ospreyFirmAdmin');
    await admin.goto('/account');
    await expect(
      admin
        .getByRole('region', { name: 'Plan limits and usage' })
        .getByRole('row')
        .filter({ hasText: 'Companies' }),
    ).toContainText('At the limit');
    await checkPage(admin);
    await admin.context().close();
    // The client admin adding one in the setup page is told why nothing was added.
    const setup = await pageAs(browser, 'ospreyAdmin');
    await setup.goto(`/c/${clients.osprey}/setup/entities`);
    await setup.getByLabel('New company name').fill('Stonebridge Weaving');
    await setup.getByRole('button', { name: 'Add company' }).click();
    // Next's route announcer is an alert too, so pick the form's by its words.
    await expect(setup.getByRole('alert').filter({ hasText: 'limit is reached' })).toHaveText(
      'Your plan’s company or unit limit is reached, so nothing was added. Your account admin can ask PlanetPulse to raise it.',
    );
    await checkPage(setup);
    await setup.context().close();
    const ospreyAdmin = await apiAs('ospreyAdmin');
    const refused = await ospreyAdmin.post(`/clients/${clients.osprey}/companies`, {
      name: 'Stonebridge Weaving',
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      error: { code: 'PLAN_LIMIT_REACHED', details: { limit: 'companies', max: used, used } },
    });

    // Lift the hold: blank keeps the plan's limit.
    await operator.getByRole('button', { name: 'Override limits' }).click();
    const lift = operator.getByRole('dialog', { name: 'Override limits' });
    await lift.getByLabel('Companies').fill('');
    await lift.getByLabel('Reason').fill('Hold lifted (integrated journey).');
    await lift.getByRole('button', { name: 'Save override' }).click();
    await expect(companies).not.toContainText('At limit');
    const created = await ospreyAdmin.post(`/clients/${clients.osprey}/companies`, {
      name: 'Stonebridge Weaving',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await ospreyAdmin.dispose();
  });

  test('the operator API answers 404 to an address outside the allowlist, signed in or not', async ({
    browser,
  }) => {
    const accounts = `${CONSOLE_URL}/api/platform/v1/accounts`;
    // From an allowed address (the run's loopback) the operator's session reads the accounts.
    expect((await console_.request.get(accounts)).status()).toBe(200);
    // The same session from another address, passed on by the console's rewrite as X-Forwarded-For: nothing there.
    const outside = await browser.newContext({
      storageState: await console_.storageState(),
      extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.60' },
    });
    expect((await outside.request.get(accounts)).status()).toBe(404);
    const signIn = await outside.request.post(`${CONSOLE_URL}/api/platform/v1/auth/login`, {
      data: { email: OPERATOR.email, password: OPERATOR.password, code: '000000' },
    });
    expect(signIn.status()).toBe(404);
    await outside.close();
  });

  test('the operator audit records each step, with its reason', async () => {
    await operator.getByRole('link', { name: 'Operator audit' }).first().click();
    await expect(operator.getByRole('heading', { name: 'Operator audit', level: 1 })).toBeVisible();
    const audit = operator.getByRole('table', { name: 'Operator audit' });
    await expect(audit.getByText('Created account').first()).toBeVisible();
    await expect(audit.getByText('Invoice unpaid for 60 days (integrated journey).')).toBeVisible();
    await expect(audit.getByText('Invoice paid (integrated journey).')).toBeVisible();
    await expect(audit.getByText('Hold at current companies (integrated journey).')).toBeVisible();
    // Operator audit never carries a person's name or email (apps/api/src/platform/CLAUDE.md).
    await expect(audit.getByText(HIGHMOOR.email)).toHaveCount(0);
    await checkBothWidths(operator);
  });
});

test('the console’s database login reaches no customer data', async () => {
  const client = new pg.Client({
    connectionString: databaseUrl(process.env.DATABASE_URL!, E2E_DATABASE, [
      OPERATOR_LOGIN,
      OPERATOR_LOGIN_PASSWORD,
    ]),
  });
  await client.connect();
  try {
    // Accounts, yes (ADR M3-0002): the console reads the firm row.
    expect((await client.query('SELECT count(*)::int AS n FROM firm')).rows[0].n).toBeGreaterThan(
      1,
    );
    // Clients' records, people and sign-ins, no: permission denied, not an empty answer.
    for (const table of [
      'client',
      'company',
      'compliance_instance',
      'evidence',
      'comment',
      'person',
      'audit_event',
      'auth_credential',
      'auth_session',
    ]) {
      await expect(
        client.query(`SELECT 1 FROM ${table} LIMIT 1`),
        `${table} is closed to the console`,
      ).rejects.toMatchObject({ code: '42501' });
    }
  } finally {
    await client.end();
  }
});
