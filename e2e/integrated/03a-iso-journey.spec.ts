import { readFileSync } from 'node:fs';

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import pg from 'pg';

import { expectNoA11yViolations } from '../support/a11y.js';
import { apiAs, type ApiSession } from './api.js';
import { checkPage, pageAs, seeded } from './helpers.js';
import {
  CONSOLE_URL,
  E2E_DATABASE,
  FIRM_A,
  OPERATOR,
  OPERATOR_TOTP_FILE,
  databaseUrl,
} from './stack.js';
import { nextUnusedCode } from './totp.js';

// The ISO add-on end to end (docs/iso/packages.md ISO-13): the operator turns it on for firm A in the console, and the
// client's ISO screens say it is being set up until M9 has copied the catalogue; the client admin sets up a management
// system and runs an internal audit whose finding raises a nonconformity; its owner closes it out with a corrective
// action and a file, whose upload, download and removal each land on the client audit trail on the nonconformity; its
// approver verifies it; then the operator turns the add-on off, the same session's next request gets 403, every ISO
// screen says it is not turned on, and the console shows Off. axe runs on every page, the console's included.
//
// It runs before 04-security, which turns the add-on on for both firms with its own account overrides and copies their
// catalogues: here firm A's copy is still to come, so "being set up" is the real state between the switch and the copy.
// afterAll takes the console's override back off, as 04-security does with its own, so later files start as before.

const DEMO_ADVISORY = 'Demo Advisory';
const ISO = 'ISO management systems';
const OFF = `${ISO} is not turned on for your account`;
const SETTING_UP = `${ISO} is being set up`;
const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 800 };
/** A one-page PDF's bytes are enough: the stand-in clamd passes anything without EICAR in it. */
const PDF = Buffer.from('%PDF-1.4\n% integrated ISO journey record\n%%EOF\n');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Today in the client's time zone (Asia/Kolkata, the default), as a date field takes it: "27 Oct 2026". */
function clientToday(): string {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
    .format(new Date())
    .split('-')
    .map(Number);
  return `${d} ${MONTHS[m! - 1]} ${y}`;
}

/** Picks an option of a design-system select. */
async function choose(page: Page, scope: Locator, label: string, option: string): Promise<void> {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** Types into a picker of several and takes the first match. */
async function addTo(page: Page, scope: Locator, label: string, text: string): Promise<void> {
  await scope.getByRole('combobox', { name: label, exact: true }).fill(text);
  await page.getByRole('option').first().click();
}

/** Types a date and leaves the field, which is when a date field takes it. */
async function date(scope: Locator, label: string, value: string): Promise<void> {
  const input = scope.getByRole('textbox', { name: label, exact: true });
  await input.fill(value);
  await input.press('Tab');
}

/** The record's state panel. */
const standing = (page: Page) => page.getByRole('region', { name: 'Where it stands' });

/** checkPage once a server action's refresh has put the title back. */
async function settled(page: Page): Promise<void> {
  await expect(page).toHaveTitle(/PlanetPulse Compliance$/);
  await checkPage(page);
}

/** With a drawer or dialog open the page behind it is hidden, its heading too, so axe alone checks it. */
async function settledOpen(page: Page): Promise<void> {
  await expect(page).toHaveTitle(/PlanetPulse Compliance$/);
  await expectNoA11yViolations(page);
}

async function bothWidths(page: Page): Promise<void> {
  await page.setViewportSize(PHONE);
  await checkPage(page);
  await page.setViewportSize(DESKTOP);
  await checkPage(page);
}

let console_: BrowserContext;
let operator: Page;

/** Signs the operator in through the console's own sign-in page, with their authenticator code (as 08-accounts). */
async function operatorSignIn(browser: Browser): Promise<void> {
  console_ = await browser.newContext({ baseURL: CONSOLE_URL, viewport: DESKTOP });
  operator = await console_.newPage();
  await operator.goto('/accounts');
  await expect(operator).toHaveURL(/\/login/);
  await operator.getByLabel('Email').fill(OPERATOR.email);
  await operator.getByLabel('Password').fill(OPERATOR.password);
  const secret = readFileSync(OPERATOR_TOTP_FILE, 'utf8');
  await operator.getByLabel('Authenticator code').fill(await nextUnusedCode('operator', secret));
  await operator.getByRole('button', { name: 'Sign in' }).click();
  await expect(operator).toHaveURL(/\/accounts$/);
}

/** Firm A's account page in the console, with its Add-ons card. */
async function addOns(): Promise<Locator> {
  await operator.goto(`/accounts/${FIRM_A}`);
  await expect(operator.getByRole('heading', { name: DEMO_ADVISORY, level: 1 })).toBeVisible();
  return operator.getByRole('region', { name: 'Add-ons' });
}

/** Flips the ISO switch on the Add-ons card, giving a reason, with axe on the open drawer. */
async function flipIso(card: Locator, on: boolean, reason: string): Promise<void> {
  const toggle = card.getByRole('switch', { name: `${ISO} for ${DEMO_ADVISORY}` });
  await expect(toggle).toBeChecked({ checked: !on });
  await toggle.click();
  const drawer = operator.getByRole('dialog', { name: `Turn ${on ? 'on' : 'off'} ${ISO}` });
  await drawer.getByLabel('Reason').fill(reason);
  await expectNoA11yViolations(operator);
  await drawer.getByRole('button', { name: on ? 'Turn on' : 'Turn off' }).click();
  await expect(
    operator.getByText(`${ISO} is ${on ? 'on' : 'off'} for ${DEMO_ADVISORY}.`, { exact: true }),
  ).toBeVisible();
  await expect(toggle).toBeChecked({ checked: on });
}

/** The ISO add-on's row on the Add-ons card. */
const isoRow = (card: Locator) => card.getByRole('listitem').filter({ hasText: ISO });

/** The owner's connection to the run's database (as prepare.ts and 04-security use it). */
function ownerDb(): pg.Client {
  return new pg.Client({ connectionString: databaseUrl(process.env.DATABASE_URL!, E2E_DATABASE) });
}

/** Ids the journey's steps hand on. */
const journey: { ncId?: string; ncPath?: string; auditPath?: string; keptFile?: string } = {};
const DESCRIPTION = `Calibration label missing on the line 2 scale ${Date.now().toString(36)}`;
const AUDIT = `Measuring equipment audit ${Date.now().toString(36)}`;
const SYSTEM = 'Kestrel quality system';
const KEPT = 'calibration-certificate.pdf';
const WRONG = 'wrong-scale.pdf';
const CHECKED = 'Line 2 scale checked against the reference weights; label in place.';

test.describe.serial('the ISO add-on, turned on, used and turned off', () => {
  test.beforeAll(async ({ browser }) => operatorSignIn(browser));
  test.afterAll(async () => {
    await console_?.close();
    // The console turned the add-on off with an override of its own; drop it, so 04-security adds its own.
    const owner = ownerDb();
    await owner.connect();
    await owner.query(`DELETE FROM platform.account_override WHERE account_id = $1`, [FIRM_A]);
    await owner.end();
  });

  test('the operator turns the add-on on, and the screens say it is being set up until the copy is recorded', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const { clients } = seeded();
    const iso = `/clients/${clients.kestrel}/iso`;

    const card = await addOns();
    await expect(isoRow(card).getByText('Off', { exact: true })).toBeVisible();
    await bothWidths(operator);

    // Hold the copy where it would be mid-way: a share lock on the catalogue's standards lets M9's copier record its
    // marker but not insert, so it cannot commit until the lock goes, however soon the outbox relay picks up the switch.
    const owner = ownerDb();
    await owner.connect();
    await owner.query('BEGIN');
    await owner.query('LOCK TABLE iso_standard IN SHARE MODE');
    try {
      await flipIso(card, true, 'Client starts ISO 9001 work (integrated journey).');
      await expect(isoRow(card).getByText('On', { exact: true })).toBeVisible();
      await expect(isoRow(card).getByText('ISO set-up is in progress.')).toBeVisible();
      await checkPage(operator);

      // The customer's side: the add-on is on, but every ISO read waits for the copy.
      const admin = await apiAs('clientAdmin');
      const early = await admin.get(`${iso}/systems`);
      expect(early).toMatchObject({ status: 409, body: { error: { code: 'FEATURE_NOT_READY' } } });
      await admin.dispose();
      const page = await pageAs(browser, 'clientAdmin');
      for (const path of ['overview', 'nonconformities']) {
        await page.goto(`/c/${clients.kestrel}/iso/${path}`);
        await expect(page.getByRole('heading', { name: SETTING_UP })).toBeVisible();
        await expect(page.getByRole('table')).toHaveCount(0);
        await checkPage(page);
      }
      await page.context().close();
    } finally {
      await owner.query('COMMIT');
      await owner.end();
    }

    // The copy goes through once the lock is gone: the switch's event, or the 10-minute sweep, retries it.
    const admin = await apiAs('clientAdmin');
    await expect
      .poll(async () => (await admin.get(`${iso}/catalogue/standards`)).status, {
        timeout: 200_000,
        intervals: [5_000],
      })
      .toBe(200);
    await admin.dispose();
    const after = await addOns();
    await expect(isoRow(after).getByText('ISO set up')).toBeVisible();
    await checkPage(operator);
  });

  test('the client admin sets up a management system and runs an internal audit whose finding raises a nonconformity', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const { clients } = seeded();
    const base = `/c/${clients.kestrel}/iso`;
    const today = clientToday();
    const page = await pageAs(browser, 'clientAdmin');

    await page.goto(`${base}/overview`);
    await expect(page.getByRole('heading', { level: 1, name: 'ISO overview' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No management system yet' })).toBeVisible();
    await settled(page);
    await page.getByRole('button', { name: 'Set up a management system' }).click();
    const setUp = page.getByRole('dialog', { name: 'Set up a management system' });
    await setUp.getByRole('textbox', { name: 'Name' }).fill(SYSTEM);
    await setUp.getByRole('checkbox', { name: /^ISO 9001\b/ }).check();
    await settledOpen(page);
    await setUp.getByRole('button', { name: 'Set up system' }).click();
    await expect(page.getByRole('heading', { level: 2, name: SYSTEM })).toBeVisible();
    await settled(page);

    await page.goto(`${base}/audits`);
    await expect(page.getByRole('heading', { level: 1, name: 'Audits' })).toBeVisible();
    await settled(page);
    await page.getByRole('button', { name: /^Start FY \d{4}-\d{2} programme$/ }).click();
    const start = page.getByRole('dialog', { name: /^Start FY \d{4}-\d{2} programme$/ });
    await settledOpen(page);
    await start.getByRole('button', { name: 'Start programme' }).click();
    await expect(
      page.getByRole('listitem', { name: /^Programme for FY \d{4}-\d{2}$/ }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Plan an internal audit' }).click();
    const plan = page.getByRole('dialog', { name: 'Plan an internal audit' });
    await plan.getByRole('textbox', { name: 'Title' }).fill(AUDIT);
    await date(plan, 'Starts on', today);
    await date(plan, 'Ends on', today);
    await addTo(page, plan, 'Clauses', '7.1.5');
    await choose(page, plan, 'Lead auditor', 'Kiran Kestrel');
    await addTo(page, plan, 'Auditees', 'Person Mike');
    await addTo(page, plan, 'Reported to (optional until the report)', 'Person Oscar');
    await settledOpen(page);
    await plan.getByRole('button', { name: 'Plan audit' }).click();
    await expect(page.getByRole('heading', { level: 1, name: AUDIT })).toBeVisible();
    journey.auditPath = new URL(page.url()).pathname;
    await expect(standing(page).getByText('Planned', { exact: true })).toBeVisible();
    await settled(page);

    await page.getByRole('button', { name: 'Add checklist row' }).click();
    const add = page.getByRole('dialog', { name: 'Add checklist row' });
    await add
      .getByRole('textbox', { name: 'Question' })
      .fill('Does every scale carry a calibration label?');
    await settledOpen(page);
    await add.getByRole('button', { name: 'Add row' }).click();
    const row = page.getByRole('listitem', {
      name: 'Checklist row: Does every scale carry a calibration label?',
    });
    await expect(row.getByText('Not answered')).toBeVisible();

    await standing(page).getByRole('button', { name: 'Start audit' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Start audit' }).click();
    await expect(standing(page).getByText('In progress', { exact: true })).toBeVisible();
    await settled(page);

    await row.getByRole('button', { name: 'Record finding' }).click();
    const finding = page.getByRole('dialog', { name: 'Record finding' });
    await choose(page, finding, 'Type', 'Minor nonconformity');
    await finding.getByRole('textbox', { name: 'Description' }).fill(DESCRIPTION);
    await choose(page, finding, 'Owner', 'Person Mike');
    await choose(page, finding, 'Approver', 'Person Oscar');
    await date(finding, 'Due on', '31 Dec 2030');
    await settledOpen(page);
    await finding.getByRole('button', { name: 'Record finding' }).click();
    const found = page.getByRole('listitem', { name: `Finding: ${DESCRIPTION}` });
    await expect(found.getByText('Minor nonconformity', { exact: true })).toBeVisible();
    await expect(found.getByText('Open', { exact: true })).toBeVisible();
    await settled(page);

    await standing(page).getByRole('button', { name: 'Report audit' }).click();
    const report = page.getByRole('dialog', { name: 'Report audit' });
    await report.getByRole('textbox', { name: 'Summary' }).fill('One scale without its label.');
    await date(report, 'Reported on', today);
    await settledOpen(page);
    await report.getByRole('button', { name: 'Report audit' }).click();
    await expect(standing(page).getByText('Reported', { exact: true })).toBeVisible();
    await settled(page);

    await found.getByRole('link', { name: 'Open the nonconformity it raised' }).click();
    await expect(page.getByRole('heading', { level: 1, name: DESCRIPTION })).toBeVisible();
    await expect(
      page.getByRole('link', { name: `A finding of the internal audit “${AUDIT}”` }),
    ).toHaveAttribute('href', journey.auditPath);
    journey.ncPath = new URL(page.url()).pathname;
    journey.ncId = journey.ncPath.split('/').pop();
    await expect(standing(page).getByText('Open', { exact: true })).toBeVisible();
    await settled(page);
    await page.context().close();
  });

  test('the owner works the nonconformity with an action and a file, the approver closes it, and the trail shows each file step', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const { clients, people } = seeded();
    const today = clientToday();
    const page = await pageAs(browser, 'owner');
    await page.goto(journey.ncPath!);
    await expect(page.getByRole('heading', { level: 1, name: DESCRIPTION })).toBeVisible();
    await settled(page);

    await standing(page).getByRole('button', { name: 'Record root cause' }).click();
    const cause = page.getByRole('dialog', { name: 'Record root cause' });
    await cause.getByRole('textbox', { name: 'Containment' }).fill('Scale taken out of use.');
    await cause
      .getByRole('textbox', { name: 'Correction' })
      .fill('Scale recalibrated and labelled.');
    await choose(page, cause, 'Root cause method', 'Five whys');
    await cause
      .getByRole('textbox', { name: 'Root cause', exact: true })
      .fill('The calibration round skipped line 2.');
    await cause
      .getByRole('textbox', { name: 'Similar occurrences' })
      .fill('Line 3 uses the same round.');
    await settledOpen(page);
    await cause.getByRole('button', { name: 'Record root cause' }).click();
    await expect(standing(page).getByText('Root cause found', { exact: true })).toBeVisible();

    const action = 'Add line 2 to the calibration round.';
    await page.getByRole('button', { name: 'Add corrective action' }).click();
    const add = page.getByRole('dialog', { name: 'Add corrective action' });
    await add.getByRole('textbox', { name: 'What is to be done' }).fill(action);
    await date(add, 'Due on', '31 Dec 2030');
    await settledOpen(page);
    await add.getByRole('button', { name: 'Add corrective action' }).click();
    const item = page.getByRole('listitem', { name: `Corrective action: ${action}` });
    await expect(item.getByText('Open', { exact: true })).toBeVisible();

    // The check falls due today, so the approver can verify it in this run.
    await standing(page).getByRole('button', { name: 'Mark actions planned' }).click();
    const planned = page.getByRole('dialog', { name: 'Mark actions planned' });
    await date(planned, 'Effectiveness check due on', today);
    await settledOpen(page);
    await planned.getByRole('button', { name: 'Mark actions planned' }).click();
    await expect(standing(page).getByText('Actions planned', { exact: true })).toBeVisible();
    await settled(page);

    // Two files through the screen (upload link, PUT to storage, confirm); the wrong one comes off again.
    const files = page.getByRole('region', { name: 'Files' });
    for (const name of [WRONG, KEPT]) {
      await files.locator('input[type="file"]').setInputFiles({
        name,
        mimeType: 'application/pdf',
        buffer: PDF,
      });
      await expect(files.getByRole('listitem').filter({ hasText: name })).toBeVisible();
    }
    await expect(files.getByText('Being checked').first()).toBeVisible();
    await files.getByRole('button', { name: `Remove ${WRONG}` }).click();
    const remove = page.getByRole('alertdialog', { name: `Remove ${WRONG}?` });
    await remove.getByLabel('Reason').fill('Uploaded the wrong scale’s certificate.');
    await settledOpen(page);
    await remove.getByRole('button', { name: 'Remove' }).click();
    await expect(files.getByRole('listitem').filter({ hasText: WRONG })).toHaveCount(0);

    // M9's scan job passes it within a minute or two; the panel shows it on the next load.
    await expect(async () => {
      await page.reload();
      await expect(
        files.getByRole('listitem').filter({ hasText: KEPT }).getByText('Ready'),
      ).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 200_000, intervals: [5_000] });
    await settled(page);
    const download = page.waitForEvent('download');
    await files.getByRole('button', { name: `Download ${KEPT}` }).click();
    const got = await download;
    expect(got.url()).toMatch(/X-Amz-Expires=300/);
    expect(got.suggestedFilename()).toBe(KEPT);

    await item.getByRole('button', { name: 'Mark done' }).click();
    const done = page.getByRole('dialog', { name: 'Mark the action done' });
    await date(done, 'Done on', today);
    await settledOpen(page);
    await done.getByRole('button', { name: 'Mark done' }).click();
    await expect(item.getByRole('button', { name: 'Mark done' })).toHaveCount(0);

    await standing(page).getByRole('button', { name: 'Submit for verification' }).click();
    const send = page.getByRole('dialog', { name: 'Submit for verification' });
    await send.getByRole('textbox', { name: 'Risk review' }).fill('None needed.');
    await send
      .getByRole('textbox', { name: 'Change to the system' })
      .fill('Line 2 added to the calibration schedule.');
    await settledOpen(page);
    await send.getByRole('button', { name: 'Submit for verification' }).click();
    await expect(standing(page).getByText('Awaiting verification', { exact: true })).toBeVisible();
    await settled(page);
    await page.context().close();

    const approver = await pageAs(browser, 'approver');
    await approver.goto(journey.ncPath!);
    await standing(approver).getByRole('button', { name: 'Verify effective' }).click();
    const verify = approver.getByRole('dialog', { name: 'Verify effective' });
    await verify.getByRole('textbox', { name: 'How it was checked' }).fill(CHECKED);
    await settledOpen(approver);
    await verify.getByRole('button', { name: 'Verify and close' }).click();
    await expect(standing(approver).getByText('Closed', { exact: true })).toBeVisible();
    // Closed, so the file stays and can no longer come off.
    const closedFiles = approver.getByRole('region', { name: 'Files' });
    await expect(closedFiles.getByRole('listitem').filter({ hasText: KEPT })).toBeVisible();
    await expect(closedFiles.getByRole('button', { name: /^Remove / })).toHaveCount(0);
    await settled(approver);
    await approver.context().close();

    // Its finding settled, the audit closes.
    const admin = await pageAs(browser, 'clientAdmin');
    await admin.goto(journey.auditPath!);
    await standing(admin).getByRole('button', { name: 'Close audit' }).click();
    await admin.getByRole('alertdialog').getByRole('button', { name: 'Close audit' }).click();
    await expect(standing(admin).getByText('Closed', { exact: true })).toBeVisible();
    await settled(admin);

    // The file's upload (twice), download and removal, each on the nonconformity, by its owner.
    const api = await apiAs('clientAdmin');
    const trail = await api.get(
      `/clients/${clients.kestrel}/audit?entityType=nonconformity&entityId=${journey.ncId}` +
        '&action=EVIDENCE_ADD,EVIDENCE_DOWNLOAD,EVIDENCE_REMOVE&limit=50',
    );
    expect(trail.status, JSON.stringify(trail.body)).toBe(200);
    type Event = { action: string; actorId: string; entityType: string; entityId: string };
    const events = (trail.body as { items: Event[] }).items;
    expect(events.map((e) => e.action).sort()).toEqual([
      'EVIDENCE_ADD',
      'EVIDENCE_ADD',
      'EVIDENCE_DOWNLOAD',
      'EVIDENCE_REMOVE',
    ]);
    for (const e of events) {
      expect(e).toMatchObject({
        entityType: 'nonconformity',
        entityId: journey.ncId,
        actorId: people.owner,
      });
    }
    await api.dispose();

    // And on the screen, as the client admin reads the trail.
    await admin.goto(`/c/${clients.kestrel}/audit?kind=evidence`);
    await expect(admin.getByRole('heading', { level: 1, name: 'Audit trail' })).toBeVisible();
    const rows = admin.getByRole('table', { name: 'Audit trail' }).getByRole('row');
    for (const words of [
      'Added evidence to a nonconformity',
      'Downloaded evidence from a nonconformity',
      'Removed evidence from a nonconformity',
    ]) {
      await expect(
        rows.filter({ hasText: words }).filter({ hasText: 'Person Mike' }).first(),
      ).toBeVisible();
    }
    await settled(admin);
    await admin.context().close();
  });

  test('the operator turns it off: the next request is refused, every ISO screen says so, and the console shows Off', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const { clients } = seeded();
    const iso = `/clients/${clients.kestrel}/iso`;
    // A session open before the switch, as the client admin's browser is.
    const admin: ApiSession = await apiAs('clientAdmin');
    expect((await admin.get(`${iso}/nonconformities/${journey.ncId}`)).status).toBe(200);
    const files = await admin.get(
      `${iso}/files?subjectType=nonconformity&subjectId=${journey.ncId}`,
    );
    expect(files.status).toBe(200);
    const file = (files.body as { items: { id: string }[] }).items[0]!;

    const card = await addOns();
    await flipIso(card, false, 'Client paused its ISO work (integrated journey).');
    await expect(isoRow(card).getByText('Off', { exact: true })).toBeVisible();
    await expect(isoRow(card).getByText(/ISO set/)).toHaveCount(0);
    await bothWidths(operator);

    // The very next request on the same session sees the switch: reads, file downloads and writes alike.
    for (const res of [
      await admin.get(`${iso}/nonconformities/${journey.ncId}`),
      await admin.get(`${iso}/files/${file.id}/download-url`),
      await admin.post(`${iso}/systems`, { name: 'Second system', standardIds: [] }),
    ]) {
      expect(res).toMatchObject({ status: 403, body: { error: { code: 'FEATURE_NOT_ENABLED' } } });
    }
    await admin.dispose();

    // Every ISO screen, lists and records alike, says so and shows nothing of the add-on's. Records with no id from
    // this journey take a made-up one: the gate answers before any read.
    const none = '00000000-0000-5000-8000-00000000abcd';
    const page = await pageAs(browser, 'clientAdmin');
    await page.goto(`/c/${clients.kestrel}/overview`);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Register', exact: true })).toBeVisible();
    await expect(nav.getByText('ISO', { exact: true })).toHaveCount(0);
    for (const path of [
      'overview',
      'checklist',
      'documents',
      `documents/${none}`,
      'risks',
      `risks/${none}`,
      'objectives',
      `objectives/${none}`,
      'audits',
      journey.auditPath!.split('/iso/')[1]!,
      'nonconformities',
      journey.ncPath!.split('/iso/')[1]!,
      'management-reviews',
      `management-reviews/${none}`,
      'certification',
    ]) {
      await page.goto(`/c/${clients.kestrel}/iso/${path}`);
      await expect(page.getByRole('heading', { name: OFF }), path).toBeVisible();
      await expect(page).toHaveTitle(
        'Not turned on · Kestrel Metals Group · PlanetPulse Compliance',
      );
      await expect(page.getByRole('table')).toHaveCount(0);
      await expect(page.getByText(DESCRIPTION)).toHaveCount(0);
      await checkPage(page);
    }
    await page.context().close();
  });
});
