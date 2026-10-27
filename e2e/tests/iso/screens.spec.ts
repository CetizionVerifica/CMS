import { devices, expect, type Locator, type Page, test } from '@playwright/test';

import { expectNoA11yViolations } from '../../support/a11y.js';
import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// ISO screens part 1 (M17, docs/iso/packages.md ISO-6a) against the web app's demo API: the overview, the clause
// checklist with its N/A request and decision, controlled documents with a revision from draft to approval, and
// certification. The demo account has the add-on; company@demo.test's account does not.
const ISO = `/c/${DEMO_METALS}/iso`;
const OFF = 'ISO management systems is not turned on for your account';

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

/** A row link in a long (virtual) table: scroll the table until the row is drawn. */
async function rowLink(page: Page, table: Locator, name: RegExp): Promise<Locator> {
  const link = table.getByRole('link', { name });
  for (let i = 0; i < 40 && (await link.count()) === 0; i++) {
    await table.hover();
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(50);
  }
  return link.first();
}

async function switchUser(page: Page, email: string, path: string): Promise<void> {
  await page.context().clearCookies();
  await signIn(page, email, path);
}

test.describe('ISO screens at 1280px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the overview shows readiness, gates and counts, and a count opens exactly its records', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', `${ISO}/overview`);
    await expect(page.getByRole('heading', { level: 1, name: 'ISO overview' })).toBeVisible();
    await expect(page).toHaveTitle('ISO overview · Demo Metals · PlanetPulse Compliance');
    await expect(page.getByRole('heading', { name: /^Clause readiness/ })).toBeVisible();
    await expect(page.getByRole('list', { name: 'ISO 9001 certification gates' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'System set-up' })).toBeVisible();
    await settled(page);

    const inReview = page
      .getByRole('region', { name: 'Documents' })
      .getByRole('link', { name: /revision in review/ });
    const counted = (await inReview.innerText()).trim();
    await inReview.click();
    await expect(page).toHaveURL(/\/iso\/documents\?ids=/);
    await expect(page.getByText('Showing the documents the ISO overview counted.')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /documents?$/ })).toHaveText(
      new RegExp(`^${counted} documents?$`),
    );
    await settled(page);

    await page.goto(`${ISO}/overview`);
    await page
      .getByRole('list', { name: 'ISO 9001 checklist' })
      .getByRole('link', { name: /partial/ })
      .click();
    await expect(page).toHaveURL(/\/iso\/checklist\?system=.*status=PARTIAL/);
    await expect(
      page.getByRole('group', { name: 'Filters' }).getByText('Status: Partial'),
    ).toBeVisible();
    await settled(page);
  });

  test('a clause is requested not applicable, approved, then withdrawn', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `${ISO}/checklist`);
    await expect(page.getByRole('heading', { level: 1, name: 'Checklist' })).toBeVisible();
    await settled(page);
    const table = page.getByRole('table', { name: 'Checklist' });
    const link = await rowLink(page, table, /^7\.1\.5\.2 /);
    const rowPath = await link.getAttribute('href');
    await link.click();
    const drawer = page.getByRole('dialog', { name: /7\.1\.5\.2/ });
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(/row=/);
    await settledOpen(page);

    await drawer.getByRole('button', { name: 'Request not applicable' }).click();
    const ask = page.getByRole('alertdialog');
    await ask.getByRole('textbox').fill('No measuring equipment needs traceable calibration here.');
    await ask.getByRole('button', { name: 'Request not applicable' }).click();
    await expect(
      drawer.getByText('Justification: No measuring equipment needs traceable calibration here.'),
    ).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Approve not applicable' })).toHaveCount(0);

    await switchUser(page, 'approver@demo.test', rowPath!);
    const theirs = page.getByRole('dialog', { name: /7\.1\.5\.2/ });
    await theirs.getByRole('button', { name: 'Approve not applicable' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Approve not applicable' })
      .click();
    await expect(theirs.getByText('Not applicable approved').first()).toBeVisible();
    await settledOpen(page);

    await switchUser(page, 'consultant@demo.test', rowPath!);
    const again = page.getByRole('dialog', { name: /7\.1\.5\.2/ });
    await again.getByRole('button', { name: 'Withdraw not applicable' }).click();
    await page.getByRole('alertdialog').getByRole('textbox').fill('The demo journey puts it back.');
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Withdraw not applicable' })
      .click();
    await expect(again.getByRole('button', { name: 'Request not applicable' })).toBeVisible();
  });

  test('a document goes from added to its first approved revision', async ({ page }) => {
    const code = `QP-E2E-${Date.now().toString(36)}`;
    await signIn(page, 'consultant@demo.test', `${ISO}/documents`);
    await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
    await settled(page);
    await page.getByRole('button', { name: 'Add document' }).click();
    const add = page.getByRole('dialog', { name: 'Add document' });
    await add.getByRole('textbox', { name: 'Code' }).fill(code);
    await add.getByRole('textbox', { name: 'Title' }).fill('Allergen changeover check');
    await add.getByRole('combobox', { name: 'Owner' }).click();
    await page.getByRole('option', { name: 'Rohan Joshi' }).click();
    await add.getByRole('combobox', { name: 'Approver' }).click();
    await page.getByRole('option', { name: 'Nisha Patil' }).click();
    await add.getByRole('button', { name: 'Add document' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: `${code} Allergen changeover check` }),
    ).toBeVisible();
    const documentPath = new URL(page.url()).pathname;
    await expect(page).toHaveTitle(
      `${code} Allergen changeover check · Demo Metals · PlanetPulse Compliance`,
    );

    await switchUser(page, 'owner@demo.test', documentPath);
    await page.getByRole('button', { name: 'Draft a revision' }).click();
    const draft = page.getByRole('dialog', { name: 'Draft a revision' });
    await expect(draft.getByRole('textbox', { name: 'Revision' })).toHaveValue('A');
    await draft.getByRole('textbox', { name: 'Change note' }).fill('First issue.');
    await draft.getByRole('button', { name: 'Start revision' }).click();
    const revision = page.getByRole('listitem', { name: 'Revision A' });
    await expect(revision.getByText('Draft', { exact: true })).toBeVisible();
    await revision.getByLabel('Add a file').setInputFiles({
      name: 'changeover-check.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 demo'),
    });
    await expect(revision.getByText('changeover-check.pdf')).toBeVisible();
    await expect(revision.getByText('Ready', { exact: true })).toBeVisible();
    await settled(page);
    await revision.getByRole('button', { name: 'Submit for approval' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Submit for approval' })
      .click();
    await expect(revision.getByText('In review')).toBeVisible();

    await switchUser(page, 'approver@demo.test', documentPath);
    const toApprove = page.getByRole('listitem', { name: 'Revision A' });
    await toApprove.getByRole('button', { name: 'Approve', exact: true }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Approve', exact: true })
      .click();
    await expect(toApprove.getByText('Approved', { exact: true })).toBeVisible();
    await expect(toApprove.getByText('In force')).toBeVisible();
    await settled(page);
  });

  test('certification shows certificates and a visit with its findings and report', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', `${ISO}/certification`);
    await expect(page.getByRole('heading', { level: 1, name: 'Certification' })).toBeVisible();
    await expect(
      page.getByRole('listitem', { name: /ISO 9001 certificate/ }).getByText('Issued'),
    ).toBeVisible();
    await expect(
      page.getByRole('listitem', { name: /ISO 14001 certificate/ }).getByText('Being pursued'),
    ).toBeVisible();
    await settled(page);
    await page.getByRole('link', { name: 'Stage 1 · ISO 14001, ISO 45001' }).click();
    const visit = page.getByRole('dialog', { name: 'Stage 1 · ISO 14001, ISO 45001' });
    await expect(
      visit.getByRole('link', { name: 'Open the nonconformity it raised' }),
    ).toBeVisible();
    await expect(visit.getByText('stage-1-audit-report.pdf')).toBeVisible();
    await settledOpen(page);
    await page.keyboard.press('Escape');
    await expect(visit).toHaveCount(0);
    await expect(page).not.toHaveURL(/audit=/);
  });

  test('the checklist works from the keyboard alone', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `${ISO}/checklist`);
    const first = page.getByRole('table', { name: 'Checklist' }).getByRole('link').first();
    await expect(first).toBeVisible();
    const focused = () => page.evaluate<string>('document.activeElement?.textContent ?? ""');
    const name = (await first.innerText()).trim();
    for (let i = 0; i < 60 && (await focused()).trim() !== name; i++)
      await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(page).not.toHaveURL(/row=/);
  });

  test('every ISO-6a page, and a document under one, says the add-on is off without it', async ({
    page,
  }) => {
    await signIn(page, 'company@demo.test', `${ISO}/overview`);
    for (const path of [
      'overview',
      'checklist',
      'documents',
      'documents/00000000-0000-5000-8000-00000000abcd',
      'certification',
    ]) {
      await page.goto(`${ISO}/${path}`);
      await expect(page.getByRole('heading', { name: OFF })).toBeVisible();
      await expect(page).toHaveTitle('Not turned on · Demo Metals · PlanetPulse Compliance');
      await expect(page.getByRole('table')).toHaveCount(0);
      await checkPage(page);
    }
  });
});

test.describe('ISO screens at 375px on a phone', () => {
  test.use({
    viewport: { width: 375, height: 740 },
    userAgent: devices['iPhone 13'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test('each page fits the screen, and a record opens full screen', async ({ page }) => {
    await signIn(page, 'owner@demo.test', `${ISO}/overview`);
    for (const [path, h1] of [
      ['overview', 'ISO overview'],
      ['checklist', 'Checklist'],
      ['documents', 'Documents'],
      ['certification', 'Certification'],
    ] as const) {
      await page.goto(`${ISO}/${path}`);
      await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
      await settled(page);
    }
    await page.goto(`${ISO}/checklist`);
    await page.getByRole('table', { name: 'Checklist' }).getByRole('link').first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Back to checklist' })).toBeVisible();
    await settledOpen(page);
  });
});
