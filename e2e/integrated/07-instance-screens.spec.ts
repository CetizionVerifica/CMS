import { expect, test, type Page } from '@playwright/test';

import { apiAs, itemsOf, type Row } from './api.js';
import { expectNoA11yViolations } from '../support/a11y.js';

import { checkPage, pageAs, seeded } from './helpers.js';
import { ACCOUNTS } from './stack.js';

// M12's screens on the real stack: the instance drawer (evidence, comment, submit), the approvals inbox (approve in the
// drawer, send back from the list), the evidence vault and the calendar. Evidence goes through the real upload and
// the evidence scan (the stand-in clamd, fake-clamd.ts), so "Open" appears only once the scan has passed the file.
const FY = 'fy=2022-23';
const PDF = Buffer.from('%PDF-1.4\n% drawer journey evidence\n%%EOF\n');

/** The owner's next open instances that the seeded approver approves. */
async function openForOwner(count: number): Promise<Row[]> {
  const { clients, people } = seeded();
  const owner = await apiAs('owner');
  const res = await owner.get(
    `/clients/${clients.kestrel}/instances?${FY}&ownerId=${people.owner}&approverId=${people.approver}&workflowState=OPEN&limit=${count}`,
  );
  expect(res.status).toBe(200);
  await owner.dispose();
  const rows = itemsOf(res.body);
  expect(rows).toHaveLength(count);
  return rows;
}

/**
 * Waits until the scan has passed `fileName` and its Open button shows. The drawer re-reads evidence for a minute; the
 * scan runs once a minute, so this reloads the page while it waits.
 */
async function waitUntilClean(page: Page, fileName: string): Promise<void> {
  const open = page.getByRole('button', { name: `Open ${fileName}` }).first();
  await expect(async () => {
    if (!(await open.isVisible())) await page.reload();
    await expect(open).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 150_000, intervals: [5_000] });
}

/** Clicks an Open button and checks the new tab fetched the file from storage through a signed link. */
async function opensFromStorage(page: Page, name: string): Promise<void> {
  const fetched = page
    .context()
    .waitForEvent('response', (res) => res.url().includes('X-Amz-Signature='));
  await page.getByRole('button', { name }).first().click();
  const res = await fetched;
  expect(res.status()).toBe(200);
  expect(new URL(res.url()).searchParams.get('X-Amz-Expires')).toBe('300');
}

test('an owner attaches evidence, comments and submits from the instance drawer', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { clients } = seeded();
  const [row] = await openForOwner(1);
  const page = await pageAs(browser, 'owner');
  await page.goto(`/c/${clients.kestrel}/register/${row!.id}`);
  const drawer = page.getByRole('dialog', { name: row!.title });
  await expect(drawer).toBeVisible();
  // The drawer hides the page behind it, so axe checks it on its own rather than through checkPage.
  await expectNoA11yViolations(page);

  // The upload goes straight to storage; the file is held back until the scan passes it.
  await drawer.locator('input[type="file"]').setInputFiles({
    name: 'challan.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  const files = drawer.getByRole('list', { name: 'Evidence files' });
  await expect(files.getByText('challan.pdf')).toBeVisible({ timeout: 30_000 });
  await waitUntilClean(page, 'challan.pdf');
  await opensFromStorage(page, 'Open challan.pdf');

  const comment = 'Challan uploaded; the return was filed on the portal.';
  await drawer.getByLabel('Add a comment').fill(comment);
  await drawer.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(drawer.getByRole('list', { name: 'Comments' })).toContainText(comment);

  await drawer.getByRole('textbox', { name: 'Completed on' }).fill('1 Mar 2023');
  await drawer.getByRole('textbox', { name: 'Completed on' }).press('Tab');
  await drawer.getByLabel('What was done').fill('Return filed; challan attached.');
  await drawer.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('Submitted for approval.', { exact: true })).toBeVisible();
  await expectNoA11yViolations(page);

  const owner = await apiAs('owner');
  const detail = await owner.get(`/instances/${row!.id}`);
  expect(detail.body).toMatchObject({ workflowState: 'SUBMITTED', completedOn: '2023-03-01' });
  await owner.dispose();
});

test('the approver approves in the drawer and sends back from the approvals inbox', async ({
  browser,
}) => {
  const { clients } = seeded();
  // The drawer journey left one submitted instance; the owner submits one more to send back.
  const [toSendBack] = await openForOwner(1);
  const owner = await apiAs('owner');
  const submitted = await owner.post(`/instances/${toSendBack!.id}/submit`, {
    version: toSendBack!.version,
    completedOn: '2023-03-02',
    comment: 'Register updated.',
  });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  await owner.dispose();

  const approver = await apiAs('approver');
  const queue = await approver.get(
    `/clients/${clients.kestrel}/instances?${FY}&workflowState=SUBMITTED&limit=50`,
  );
  const waiting = itemsOf(queue.body);
  const toApprove = waiting.find((r) => r.id !== toSendBack!.id)!;
  expect(toApprove).toBeDefined();

  const page = await pageAs(browser, 'approver');
  await page.goto(`/c/${clients.kestrel}/approvals`);
  const list = page.getByRole('list', { name: 'Waiting for approval' });
  await expect(list.getByText(toApprove.title).first()).toBeVisible();
  await expect(list.getByText(toSendBack!.title).first()).toBeVisible();
  await checkPage(page);

  // Approve in the drawer, after reading what the owner left there.
  await list.getByRole('link', { name: toApprove.title }).first().click();
  await expect(page).toHaveURL(new RegExp(`/approvals/${toApprove.id}$`));
  const drawer = page.getByRole('dialog', { name: toApprove.title });
  await expect(drawer.getByRole('list', { name: 'Evidence files' })).toContainText('challan.pdf');
  await expect(drawer.getByRole('list', { name: 'Comments' })).toContainText('Challan uploaded');
  await expectNoA11yViolations(page);
  await drawer.getByRole('button', { name: 'Approve', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Approve this instance?' });
  await confirm.getByRole('button', { name: 'Approve', exact: true }).click();
  // The approval also shows as a comment in the drawer, so look for it among the notifications.
  await expect(
    page.getByLabel(/^Notifications/).getByText('Approved.', { exact: true }),
  ).toBeVisible();
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${clients.kestrel}/approvals$`));
  await expect(list.getByRole('link', { name: toApprove.title })).toHaveCount(0);

  // Send back from the list, with a reason.
  await list
    .getByRole('button', { name: `Send back ${toSendBack!.title}` })
    .first()
    .click();
  const sendBack = page.getByRole('alertdialog', {
    name: `Send back to ${ACCOUNTS.owner.displayName}?`,
  });
  await sendBack.getByLabel('Reason').fill('Attach the register extract, please.');
  await sendBack.getByRole('button', { name: 'Send back', exact: true }).click();
  await expect(
    page.getByText(`Sent “${toSendBack!.title}” back to ${ACCOUNTS.owner.displayName}.`, {
      exact: true,
    }),
  ).toBeVisible();
  await checkPage(page);

  const approved = await approver.get(`/instances/${toApprove.id}`);
  expect(approved.body).toMatchObject({ workflowState: 'APPROVED' });
  const sentBack = await approver.get(`/instances/${toSendBack!.id}`);
  expect((sentBack.body as Row).workflowState).not.toBe('SUBMITTED');
  const trail = await approver.get(`/instances/${toSendBack!.id}/audit`);
  const latest = (trail.body as { items: { action: string; reason: string | null }[] }).items[0];
  expect(latest).toMatchObject({
    action: 'TRANSITION',
    reason: 'Attach the register extract, please.',
  });
  await approver.dispose();
});

test('the evidence vault lists the client’s files, opens clean ones and holds back flagged ones', async ({
  browser,
}) => {
  const { clients } = seeded();
  const page = await pageAs(browser, 'clientAdmin');
  await page.goto(`/c/${clients.kestrel}/evidence`);
  const table = page.getByRole('table', { name: 'Evidence' });
  await expect(table.getByRole('row').filter({ hasText: 'challan.pdf' }).first()).toBeVisible();
  await checkPage(page);

  // The security journey's EICAR file (04-security.spec.ts) is blocked and has no Open button.
  await page.getByPlaceholder('Search file names').fill('form-5a');
  const flagged = table.getByRole('row').filter({ hasText: 'form-5a.pdf' });
  await expect(flagged).toHaveCount(1);
  await expect(flagged).toContainText('Blocked: failed virus check');
  await expect(flagged.getByRole('button', { name: /^Open/ })).toHaveCount(0);

  await page.getByPlaceholder('Search file names').fill('challan');
  await expect(table.getByRole('row').filter({ hasText: 'form-5a.pdf' })).toHaveCount(0);
  await opensFromStorage(page, 'Open challan.pdf');
});

test('the calendar shows a month’s due instances, the same as the register, and opens one', async ({
  browser,
}) => {
  const { clients } = seeded();
  const consultant = await apiAs('consultant');
  // The month of FY 2022-23 with the most due dates, counted from the register.
  const due: Record<string, number> = {};
  let cursor: string | null = null;
  do {
    const res = await consultant.get(
      `/clients/${clients.kestrel}/instances?${FY}&limit=200${cursor ? `&cursor=${cursor}` : ''}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as { items: Row[]; nextCursor: string | null };
    for (const r of body.items) due[r.dueDate.slice(0, 7)] = (due[r.dueDate.slice(0, 7)] ?? 0) + 1;
    cursor = body.nextCursor;
  } while (cursor);
  const [month, count] = Object.entries(due).sort((a, b) => b[1] - a[1])[0]!;
  const last = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0),
  ).getUTCDate();
  const register = await consultant.get(
    `/clients/${clients.kestrel}/instances?dueFrom=${month}-01&dueTo=${month}-${last}&limit=200`,
  );
  expect(itemsOf(register.body)).toHaveLength(count);
  await consultant.dispose();

  const page = await pageAs(browser, 'consultant');
  await page.goto(`/c/${clients.kestrel}/calendar?${FY}&m=${month}`);
  await expect(
    page.getByText(`${count} ${count === 1 ? 'instance' : 'instances'} due`),
  ).toBeVisible();
  await checkPage(page);

  // Month view: a day with due dates lists them.
  const day = page.getByRole('table').getByRole('button').first();
  await day.click();
  await expect(page.getByRole('heading', { level: 3, name: /^Due / })).toBeVisible();

  // List view: one section per day, and a title opens the instance's drawer.
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'List' }).click();
  await expect(page).toHaveURL(/view=list/);
  const first = page.getByRole('region').first().getByRole('link').first();
  const title = (await first.textContent())!.trim();
  await checkPage(page);
  await first.click();
  await expect(page.getByRole('dialog', { name: title })).toBeVisible();
});
