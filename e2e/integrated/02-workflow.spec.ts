import { expect, test } from '@playwright/test';

import { apiAs, itemsOf } from './api.js';
import { checkPage, pageAs, seeded } from './helpers.js';

// The owner submits, the approver approves, and the audit trail records both, across M7's state machine, the register
// (M12) and the audit API. The owner submits through the API the instance drawer calls, so this journey checks the
// register's bulk approve on its own; the drawer's own journey covers the screen.
test('an owner submits two items and the approver approves them from the register', async ({
  browser,
}) => {
  const { clients, people } = seeded();
  const owner = await apiAs('owner');
  const open = await owner.get(
    `/clients/${clients.kestrel}/instances?fy=2022-23&ownerId=${people.owner}&approverId=${people.approver}&workflowState=OPEN&limit=2`,
  );
  expect(open.status).toBe(200);
  const rows = itemsOf(open.body);
  expect(rows).toHaveLength(2);

  for (const row of rows) {
    const submitted = await owner.post(`/instances/${row.id}/submit`, {
      version: row.version,
      completedOn: '2023-03-01',
      comment: 'Return filed; acknowledgement in the shared folder.',
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body).toMatchObject({ id: row.id, workflowState: 'SUBMITTED' });
  }
  // A second submit of a stale version is refused, not applied twice.
  const again = await owner.post(`/instances/${rows[0]!.id}/submit`, {
    version: rows[0]!.version,
    completedOn: '2023-03-01',
    comment: 'Again.',
  });
  expect(again.status).toBe(409);
  await owner.dispose();

  const page = await pageAs(browser, 'approver');
  await page.goto(`/c/${clients.kestrel}/register?fy=2022-23&workflowState=SUBMITTED`);
  const table = page.getByRole('table', { name: 'Register' });
  await expect(table.getByRole('row')).toHaveCount(3);
  await checkPage(page);
  await table.getByRole('checkbox', { name: 'Select all rows' }).check();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Approve 2 instances?' });
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Approved 2 instances.', { exact: true })).toBeVisible();
  await checkPage(page);

  const approver = await apiAs('approver');
  for (const row of rows) {
    const detail = await approver.get(`/instances/${row.id}`);
    expect(detail.body).toMatchObject({ workflowState: 'APPROVED', completedOn: '2023-03-01' });
    const trail = await approver.get(`/instances/${row.id}/audit`);
    expect(trail.status).toBe(200);
    // Newest first: the approval, the submission, then the import that created the row.
    const events = (
      trail.body as { items: { action: string; after: { workflowState?: string } }[] }
    ).items;
    expect(events.map((e) => [e.action, e.after.workflowState])).toEqual([
      ['TRANSITION', 'APPROVED'],
      ['TRANSITION', 'SUBMITTED'],
      ['IMPORT', expect.anything()],
    ]);
  }
  await approver.dispose();
});

test('the owner cannot approve their own work, and the viewer cannot change anything', async () => {
  const { clients, people } = seeded();
  const owner = await apiAs('owner');
  const open = itemsOf(
    (
      await owner.get(
        `/clients/${clients.kestrel}/instances?fy=2022-23&ownerId=${people.owner}&workflowState=OPEN&limit=1`,
      )
    ).body,
  )[0]!;
  const approve = await owner.post(`/instances/${open.id}/approve`, { version: open.version });
  expect(approve.status).toBe(403);
  await owner.dispose();

  const viewer = await apiAs('viewer');
  const submit = await viewer.post(`/instances/${open.id}/submit`, {
    version: open.version,
    completedOn: '2023-03-01',
    comment: 'Viewer tries.',
  });
  expect(submit.status).toBe(403);
  const read = await viewer.get(`/instances/${open.id}`);
  expect(read.status).toBe(200);
  await viewer.dispose();
});
