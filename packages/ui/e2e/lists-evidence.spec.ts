import { expect, test } from '@playwright/test';

import { expectNoA11yViolations, expectNoPageOverflow, openPopup } from './a11y';

test('approvals inbox works from the keyboard', async ({ page }) => {
  await page.goto('/#/lists');
  const inbox = page.getByRole('list', { name: 'Approvals' });
  const first = inbox.getByRole('link', { name: /^Monthly PF challan/ });
  await first.focus();
  await page.keyboard.press('j');
  await expect(inbox.getByRole('link', { name: /^ESI contribution/ })).toBeFocused();
  await page.keyboard.press('k');
  await expect(first).toBeFocused();

  // A approves: the row dims, goes away and focus moves to the next one.
  await page.keyboard.press('a');
  await expect(inbox.getByRole('link', { name: /^Monthly PF challan/ })).toHaveCount(0);
  await expect(inbox.getByRole('link', { name: /^ESI contribution/ })).toBeFocused();
  await expect(page.getByText('Approved Monthly PF challan.').first()).toBeVisible();

  // S opens the send-back dialog with a required reason.
  await page.keyboard.press('s');
  const dialog = page.getByRole('alertdialog', { name: 'Send back ESI contribution?' });
  await expect(dialog).toBeVisible();
  await expectNoA11yViolations(page, openPopup('[role="alertdialog"]'));
  await page.keyboard.press('Escape');
  await expect(inbox.getByRole('link', { name: /^ESI contribution/ })).toBeFocused();

  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoPageOverflow(page);
});

test('deadline links carry the date and status in their names', async ({ page }) => {
  await page.goto('/#/lists');
  await expect(
    page.getByRole('link', { name: 'Monthly PF challan, due 10 Mar 2027, Due today' }).first(),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: '+ 2 more' })).toBeVisible();
  await expect(page.getByText('Next week', { exact: true })).toBeVisible();
});

test('evidence upload rejects, uploads, scans and confirms removal', async ({ page }) => {
  await page.goto('/#/evidence');
  const zone = page.getByRole('group', { name: 'Evidence', exact: true });
  const chooser = page.waitForEvent('filechooser');
  await zone.getByRole('button', { name: 'choose files' }).click();
  await (
    await chooser
  ).setFiles([
    { name: 'challan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') },
    { name: 'setup.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') },
  ]);
  const list = page.getByRole('list', { name: 'Evidence list' });
  await expect(list.getByText('Wrong type (EXE). Use PDF, JPG, PNG, XLSX, DOCX.')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'challan.pdf ready' })).toBeAttached({
    timeout: 5000,
  });
  await expect(list.getByRole('button', { name: 'challan.pdf', exact: true })).toBeVisible();
  await expectNoA11yViolations(page);
  await expectNoPageOverflow(page);

  await list.getByRole('button', { name: 'Remove challan.pdf' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Remove challan.pdf?' });
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(list.getByRole('button', { name: 'challan.pdf', exact: true })).toHaveCount(0);
});

test('timeline loads earlier activity and moves focus to it', async ({ page }) => {
  await page.goto('/#/evidence');
  const activity = page.getByRole('list', { name: 'Activity' }).first();
  await expect(activity.getByText('10 Mar 2027, 10:45 IST')).toBeVisible();
  const more = page.getByRole('button', { name: 'Show earlier activity' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('li[data-event]:focus')).toContainText('Priya Rane added PF challan');
  await expect(more).toHaveCount(0);
});
