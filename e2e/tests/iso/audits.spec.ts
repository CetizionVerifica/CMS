import { devices, expect, type Locator, type Page, test } from '@playwright/test';

import { expectNoA11yViolations } from '../../support/a11y.js';
import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// ISO screens part 3b (M17, docs/iso/packages.md ISO-6c) against the web app's demo API: an internal audit planned,
// started, given a checklist row and a nonconformity finding, reported and, once its nonconformity has left Open,
// closed; the overview's audit programme counts opening exactly their audits; the audit report download.
const ISO = `/c/${DEMO_METALS}/iso`;
const OFF = 'ISO management systems is not turned on for your account';
const FILES = 'https://files.mock.invalid/**';

/** checkPage once the title is back: a server action's refresh briefly leaves the document without one. */
async function settled(page: Page): Promise<void> {
  await expect(page).toHaveTitle(/PlanetPulse Compliance$/);
  await checkPage(page);
}

/** The same with a drawer open: the page behind it, its heading included, is hidden from assistive tech. */
async function settledOpen(page: Page): Promise<void> {
  await expect(page).toHaveTitle(/PlanetPulse Compliance$/);
  await expectNoA11yViolations(page);
}

async function choose(page: Page, scope: Locator, label: string, option: string): Promise<void> {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** Types into a picker of several and chooses the first match. */
async function addTo(page: Page, scope: Locator, label: string, text: string): Promise<void> {
  await scope.getByRole('combobox', { name: label, exact: true }).fill(text);
  await page.getByRole('option').first().click();
}

async function date(scope: Locator, label: string, value: string): Promise<void> {
  const input = scope.getByRole('textbox', { name: label, exact: true });
  await input.fill(value);
  await input.press('Tab');
}

async function switchUser(page: Page, email: string, path: string): Promise<void> {
  await page.context().clearCookies();
  await signIn(page, email, path);
}

async function shown(page: Page, noun: RegExp): Promise<string> {
  const status = page.getByRole('status').filter({ hasText: noun });
  await expect(status).toBeVisible();
  return (await status.innerText()).trim().split(' ')[0]!;
}

function standing(page: Page): Locator {
  return page.getByRole('region', { name: 'Where it stands' });
}

/** Confirms a step's dialog. */
async function confirm(page: Page, label: string): Promise<void> {
  await page.getByRole('alertdialog').getByRole('button', { name: label }).click();
}

test.describe('ISO screens part 3b at 1280px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('an audit is planned, finds a nonconformity, is reported and closes once that is worked', async ({
    page,
  }) => {
    const title = `Cold store audit ${Date.now().toString(36)}`;
    await signIn(page, 'consultant@demo.test', `${ISO}/audits`);
    await expect(page.getByRole('heading', { level: 1, name: 'Audits' })).toBeVisible();
    await expect(page.getByRole('listitem', { name: 'Programme for FY 2024-25' })).toBeVisible();
    await settled(page);

    await page.getByRole('button', { name: 'Plan an internal audit' }).click();
    const plan = page.getByRole('dialog', { name: 'Plan an internal audit' });
    await plan.getByRole('textbox', { name: 'Title' }).fill(title);
    await date(plan, 'Starts on', '13 Nov 2024');
    await date(plan, 'Ends on', '14 Nov 2024');
    await addTo(page, plan, 'Clauses', '8.5');
    await plan.getByRole('checkbox', { name: 'Pune Plant' }).check();
    await choose(page, plan, 'Lead auditor', 'Sameer Gowda');
    await addTo(page, plan, 'Auditees', 'Rohan');
    await addTo(page, plan, 'Reported to (optional until the report)', 'Kabir');
    await settledOpen(page);
    await plan.getByRole('button', { name: 'Plan audit' }).click();

    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page).toHaveTitle(`${title} · Demo Metals · PlanetPulse Compliance`);
    const auditPath = new URL(page.url()).pathname;
    await expect(standing(page).getByText('Planned', { exact: true })).toBeVisible();
    await settled(page);

    await page.getByRole('button', { name: 'Add checklist row' }).click();
    const add = page.getByRole('dialog', { name: 'Add checklist row' });
    await choose(page, add, 'Unit (optional)', 'Pune Plant');
    await add.getByRole('textbox', { name: 'Question' }).fill('Is cold store temperature logged?');
    await add.getByRole('button', { name: 'Add row' }).click();
    const row = page.getByRole('listitem', {
      name: 'Checklist row: Is cold store temperature logged?',
    });
    await expect(row.getByText('Not answered')).toBeVisible();

    await standing(page).getByRole('button', { name: 'Start audit' }).click();
    await confirm(page, 'Start audit');
    await expect(standing(page).getByText('In progress', { exact: true })).toBeVisible();
    await settled(page);

    await row.getByRole('button', { name: 'Record finding' }).click();
    const finding = page.getByRole('dialog', { name: 'Record finding' });
    await finding
      .getByRole('textbox', { name: 'Description' })
      .fill('Two nights of cold store readings are missing.');
    await choose(page, finding, 'Owner', 'Rohan Joshi');
    await choose(page, finding, 'Approver', 'Nisha Patil');
    await date(finding, 'Due on', '31 Dec 2030');
    await settledOpen(page);
    await finding.getByRole('button', { name: 'Record finding' }).click();
    await expect(row.getByText('Finding', { exact: true })).toBeVisible();
    const found = page.getByRole('listitem', {
      name: 'Finding: Two nights of cold store readings are missing.',
    });
    await expect(found.getByText('Minor nonconformity', { exact: true })).toBeVisible();
    await expect(found.getByText('Open', { exact: true })).toBeVisible();
    await settled(page);

    await standing(page).getByRole('button', { name: 'Report audit' }).click();
    const report = page.getByRole('dialog', { name: 'Report audit' });
    await report.getByRole('textbox', { name: 'Summary' }).fill('Logging gaps at night.');
    // The demo API's today is its data's (15 Nov 2024), and a report may not be dated after it.
    const reportedOn = report.getByRole('textbox', { name: 'Reported on' });
    await reportedOn.fill('15 Nov 2024');
    await reportedOn.press('Tab');
    await settledOpen(page);
    await report.getByRole('button', { name: 'Report audit' }).click();
    await expect(standing(page).getByText('Reported', { exact: true })).toBeVisible();
    await expect(standing(page).getByText('Logging gaps at night.')).toBeVisible();
    // Closing waits for its nonconformity to leave Open: the API refuses it, and the dialog says why.
    await standing(page).getByRole('button', { name: 'Close audit' }).click();
    await confirm(page, 'Close audit');
    await expect(page.getByRole('alertdialog')).toContainText(/nonconformit/i);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(standing(page).getByText('Reported', { exact: true })).toBeVisible();
    await settled(page);

    // The nonconformity names the audit that raised it.
    await found.getByRole('link', { name: 'Open the nonconformity it raised' }).click();
    await expect(
      page.getByRole('link', { name: `A finding of the internal audit “${title}”` }),
    ).toHaveAttribute('href', auditPath);
    const ncPath = new URL(page.url()).pathname;

    await switchUser(page, 'owner@demo.test', ncPath);
    await page
      .getByRole('region', { name: 'Where it stands' })
      .getByRole('button', { name: 'Record root cause' })
      .click();
    const cause = page.getByRole('dialog', { name: 'Record root cause' });
    await cause.getByRole('textbox', { name: 'Containment' }).fill('Readings taken by hand.');
    await cause.getByRole('textbox', { name: 'Correction' }).fill('Logger restarted.');
    await choose(page, cause, 'Root cause method', 'Five whys');
    await cause
      .getByRole('textbox', { name: 'Root cause', exact: true })
      .fill('Logger battery ran out.');
    await cause
      .getByRole('textbox', { name: 'Similar occurrences' })
      .fill('The freezer logger uses the same battery.');
    await cause.getByRole('button', { name: 'Record root cause' }).click();
    await expect(
      page
        .getByRole('region', { name: 'Where it stands' })
        .getByText('Root cause found', { exact: true }),
    ).toBeVisible();

    await switchUser(page, 'consultant@demo.test', auditPath);
    await standing(page).getByRole('button', { name: 'Close audit' }).click();
    await confirm(page, 'Close audit');
    await expect(standing(page).getByText('Closed', { exact: true })).toBeVisible();
    await expect(standing(page).getByRole('button', { name: /audit$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add checklist row' })).toHaveCount(0);
    await settled(page);
  });

  test('each overview audit programme count opens a list showing that many audits', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', `${ISO}/overview`);
    await expect(page.getByRole('heading', { level: 1, name: 'ISO overview' })).toBeVisible();
    const names: string[] = [];
    for (const link of await page
      .getByRole('region', { name: 'Audit programme' })
      .getByRole('link')
      .all()) {
      names.push((await link.getAttribute('aria-label'))!);
    }
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) {
      await page.goto(`${ISO}/overview`);
      const link = page
        .getByRole('region', { name: 'Audit programme' })
        .getByRole('link', { name, exact: true });
      const counted = (await link.innerText()).trim();
      await link.click();
      await expect(page).toHaveURL(/\/iso\/audits\?ids=/);
      expect(await shown(page, /audits?$/), name).toBe(counted);
      await expect(page.getByText('Showing the audits the ISO overview counted.')).toBeVisible();
    }
    await settled(page);
  });

  test('a reported audit downloads its report, and opens from the list by keyboard alone', async ({
    page,
  }) => {
    let downloaded = '';
    await page.route(FILES, async (route) => {
      downloaded = route.request().url();
      await route.fulfill({
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="audit-report.pdf"' },
        body: 'report',
      });
    });
    await signIn(page, 'consultant@demo.test', `${ISO}/audits?state=REPORTED`);
    const first = page.getByRole('table', { name: 'Internal audits' }).getByRole('link').first();
    await expect(first).toBeVisible();
    const name = (await first.innerText()).trim();
    const focused = () => page.evaluate<string>('document.activeElement?.textContent ?? ""');
    for (let i = 0; i < 80 && (await focused()).trim() !== name; i++)
      await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Checklist' })).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download audit report (PDF)' }).click();
    await download;
    expect(downloaded).toMatch(/^https:\/\/files\.mock\.invalid\/exports\//);
    await settled(page);
  });

  test('every audit page says the add-on is off without it', async ({ page }) => {
    await signIn(page, 'company@demo.test', `${ISO}/overview`);
    for (const path of ['audits', 'audits/00000000-0000-5000-8000-00000000abcd']) {
      await page.goto(`${ISO}/${path}`);
      await expect(page.getByRole('heading', { name: OFF })).toBeVisible();
      await expect(page).toHaveTitle('Not turned on · Demo Metals · PlanetPulse Compliance');
      await expect(page.getByRole('table')).toHaveCount(0);
      await checkPage(page);
    }
  });
});

test.describe('ISO screens part 3b at 375px on a phone', () => {
  test.use({
    viewport: { width: 375, height: 740 },
    userAgent: devices['iPhone 13'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test('the programme, the list and an audit fit the screen', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `${ISO}/audits`);
    await expect(page.getByRole('heading', { level: 1, name: 'Audits' })).toBeVisible();
    await settled(page);
    await page.getByRole('button', { name: 'Plan an internal audit' }).click();
    await expect(page.getByRole('dialog', { name: 'Plan an internal audit' })).toBeVisible();
    await settledOpen(page);
    await page.keyboard.press('Escape');
    await page.getByRole('table', { name: 'Internal audits' }).getByRole('link').first().click();
    await expect(page.getByRole('heading', { name: 'Plan and team' })).toBeVisible();
    await settled(page);
  });
});
