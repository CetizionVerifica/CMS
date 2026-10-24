import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Comment, EvidenceView, InstanceAction, InstanceDetail } from '@canopy/contracts';
import { Toaster } from '@canopy/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DrawerData } from '../_lib/instance-api';
import { CLIENT_ID, makeRow, PERSON_ID } from '../_test/rows';

const actions = vi.hoisted(() => ({
  loadInstanceDrawer: vi.fn(),
  loadMoreHistory: vi.fn(),
  reloadEvidence: vi.fn(),
  runInstanceAction: vi.fn(),
  postComment: vi.fn(),
  startEvidenceUpload: vi.fn(),
  confirmEvidenceUpload: vi.fn(),
  evidenceDownload: vi.fn(),
  removeEvidenceFile: vi.fn(),
}));
vi.mock('../instance-actions', () => actions);

const { InstanceDrawer, SCAN_POLL_MS } = await import('./InstanceDrawer');
type Props = Parameters<typeof InstanceDrawer>[0];

const row = makeRow(1);
const OWNER = row.ownerId;
const APPROVER = row.approverId;
const T = '2024-11-15T05:30:00Z';

function detail(overrides: Partial<InstanceDetail> = {}): InstanceDetail {
  return {
    ...row,
    title: 'Deposit TDS for the month',
    description: '1. Compute the tax.\n2. Deposit it with the bank.',
    applicabilityText: 'Every unit that pays salaries.',
    naReason: null,
    forms: [{ label: 'Challan 281', fileName: 'challan-281.pdf', templateFileId: null }],
    logSheets: [],
    evidenceRequired: true,
    allowedActions: ['SUBMIT', 'REQUEST_NA', 'COMMENT', 'UPLOAD_EVIDENCE'],
    ...overrides,
  };
}

const evidence = (overrides: Partial<EvidenceView> = {}): EvidenceView => ({
  id: '00000000-0000-5000-8000-000000000e01',
  firmId: '00000000-0000-5000-8000-0000000000f1',
  createdAt: T,
  updatedAt: T,
  archivedAt: null,
  instanceId: row.id,
  clientId: CLIENT_ID,
  fileName: 'bank-receipt.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2 * 1024 * 1024,
  sha256: 'a'.repeat(64),
  scanStatus: 'CLEAN',
  uploadedById: OWNER,
  ...overrides,
});

const comment = (overrides: Partial<Comment> = {}): Comment => ({
  id: '00000000-0000-5000-8000-000000000c01',
  firmId: '00000000-0000-5000-8000-0000000000f1',
  createdAt: T,
  updatedAt: T,
  archivedAt: null,
  instanceId: row.id,
  clientId: CLIENT_ID,
  authorId: APPROVER,
  kind: 'SEND_BACK',
  body: 'Wrong month.\nPlease attach April.',
  ...overrides,
});

function data(overrides: Partial<DrawerData> = {}, d: Partial<InstanceDetail> = {}): DrawerData {
  return {
    detail: detail(d),
    evidence: [evidence()],
    comments: [comment()],
    moreComments: false,
    audit: {
      events: [
        {
          id: '00000000-0000-5000-8000-000000000a01',
          firmId: '00000000-0000-5000-8000-0000000000f1',
          clientId: CLIENT_ID,
          at: T,
          requestId: 'r1',
          actorId: APPROVER,
          actorKind: 'PERSON',
          action: 'TRANSITION',
          entityType: 'instance',
          entityId: row.id,
          before: { workflowState: 'SUBMITTED' },
          after: { workflowState: 'SENT_BACK' },
          reason: 'Wrong month.',
        },
      ],
      nextCursor: null,
    },
    names: { [OWNER]: 'Owner 01', [APPROVER]: 'Approver 01' },
    ...overrides,
  };
}

const ok = <T,>(value: T) => ({ ok: true, data: value });
const as = (allowedActions: InstanceAction[], d: Partial<InstanceDetail> = {}) =>
  data({}, { allowedActions, ...d });

const onClose = vi.fn();
const onChanged = vi.fn();
function renderDrawer(props: Partial<Props> = {}) {
  const view = (p: Partial<Props>) => (
    <>
      <InstanceDrawer
        instanceId={row.id}
        timeZone="Asia/Kolkata"
        canManage={false}
        personId={OWNER}
        onClose={onClose}
        onChanged={onChanged}
        {...p}
      />
      <Toaster />
    </>
  );
  const utils = render(view(props));
  return { ...utils, rerender: (p: Partial<Props>) => utils.rerender(view(p)) };
}

const dialog = () => screen.getByRole('dialog');

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  onClose.mockReset();
  onChanged.mockReset();
  actions.loadInstanceDrawer.mockResolvedValue(ok(data()));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('InstanceDrawer', () => {
  it('shows the instance: header, description with its line breaks, details, templates, evidence, comments, history', async () => {
    renderDrawer();
    expect(await screen.findByRole('heading', { name: 'Deposit TDS for the month' })).toBeTruthy();
    const d = dialog();
    expect(within(d).getByText(row.externalRef!)).toBeTruthy();
    expect(within(d).getByText('Due 2 Mar 2023')).toBeTruthy();
    const description = within(d).getByText(/Compute the tax/);
    expect(description.textContent).toBe('1. Compute the tax.\n2. Deposit it with the bank.');
    expect(description.className).toContain('whitespace-pre-line');
    expect(within(d).getByText('Every unit that pays salaries.')).toBeTruthy();
    expect(within(d).getByText('Challan 281')).toBeTruthy();
    expect(within(d).getByText('(challan-281.pdf)')).toBeTruthy();
    expect(within(d).getByText('No log sheets for this obligation.')).toBeTruthy();
    const files = within(d).getByRole('list', { name: 'Evidence files' });
    expect(within(files).getByText('bank-receipt.pdf')).toBeTruthy();
    expect(within(files).getByText(/2 MB · Added by Owner 01/)).toBeTruthy();
    const comments = within(d).getByRole('list', { name: 'Comments' });
    expect(within(comments).getByText('Approver 01').parentElement!.textContent).toContain(
      'Approver 01 · Sent back · 15 Nov 2024',
    );
    expect(within(d).getByText(/sent it back/)).toBeTruthy();
    expect(actions.loadInstanceDrawer).toHaveBeenCalledWith(row.id);
  });

  it('shows the row’s title while loading, then the empty, error and unavailable states', async () => {
    let resolve: (v: unknown) => void = () => {};
    actions.loadInstanceDrawer.mockReturnValue(new Promise((r) => (resolve = r)));
    const { rerender } = renderDrawer({ fallbackTitle: 'Row title' });
    expect(screen.getByRole('heading', { name: 'Row title' })).toBeTruthy();
    expect(screen.getByText('Loading')).toBeTruthy();
    await act(async () =>
      resolve(
        ok(
          data(
            { evidence: [], comments: [], audit: { events: [], nextCursor: null } },
            { applicabilityText: null, forms: [], allowedActions: [] },
          ),
        ),
      ),
    );
    expect(screen.getByText('No evidence attached.')).toBeTruthy();
    expect(screen.getByText('No comments yet.')).toBeTruthy();
    expect(screen.getByText('No history yet.')).toBeTruthy();
    expect(screen.queryByText('Applicability')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();

    actions.loadInstanceDrawer.mockResolvedValue({ ok: false, code: 'NOT_FOUND', message: 'x' });
    rerender({ instanceId: '00000000-0000-5000-8000-000000000999' });
    expect(await screen.findByText("This instance isn't available to you")).toBeTruthy();

    actions.loadInstanceDrawer.mockRejectedValueOnce(new Error('network'));
    rerender({ instanceId: '00000000-0000-5000-8000-000000000998' });
    expect(await screen.findByText('The instance didn’t load. Try again.')).toBeTruthy();
    actions.loadInstanceDrawer.mockResolvedValue(ok(data()));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Deposit TDS for the month' })).toBeTruthy();

    actions.loadInstanceDrawer.mockClear();
    rerender({ instanceId: 'not-an-id' });
    expect(await screen.findByText("This instance isn't available to you")).toBeTruthy();
    expect(actions.loadInstanceDrawer).not.toHaveBeenCalled();
  });

  it('is closed with no instance, and closing calls onClose', async () => {
    const { rerender } = renderDrawer({ instanceId: null });
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender({});
    await screen.findByRole('heading', { name: 'Deposit TDS for the month' });
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('lets the owner submit with a completion date and comment, at the version seen', async () => {
    const user = userEvent.setup();
    const next = detail({ workflowState: 'SUBMITTED', version: 2, allowedActions: ['COMMENT'] });
    actions.runInstanceAction.mockResolvedValue(ok(next));
    renderDrawer();
    await screen.findByRole('heading', { name: 'Mark as done' });
    expect(screen.getByText(/needs evidence/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(screen.getByText('Enter the date the work was done.')).toBeTruthy();
    expect(screen.getByText('Say what was done.')).toBeTruthy();
    expect(actions.runInstanceAction).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/Completed on/), '15/11/2024');
    await user.type(screen.getByLabelText('What was done'), '  Paid on 15 Nov.  ');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() =>
      expect(actions.runInstanceAction).toHaveBeenCalledWith(row.id, {
        kind: 'SUBMIT',
        version: 1,
        completedOn: '2024-11-15',
        comment: 'Paid on 15 Nov.',
      }),
    );
    expect(await screen.findByText('Submitted for approval.')).toBeTruthy();
    expect(onChanged).toHaveBeenCalledWith(next);
    // The form is gone, so focus moves to the drawer's title.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Deposit TDS for the month' }),
      ),
    );
    // Comments and history are read again behind the change.
    await waitFor(() => expect(actions.loadInstanceDrawer).toHaveBeenCalledTimes(2));
  });

  it('shows the API’s reason: a future date on the field, missing evidence as a message', async () => {
    const user = userEvent.setup();
    actions.runInstanceAction.mockResolvedValueOnce({
      ok: false,
      code: 'DATE_IN_FUTURE',
      message: 'The completion date can’t be after today.',
    });
    renderDrawer();
    await user.type(await screen.findByLabelText(/Completed on/), '15/11/2030');
    await user.type(screen.getByLabelText('What was done'), 'Done');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findAllByText('The completion date can’t be after today.')).toHaveLength(2);

    actions.runInstanceAction.mockResolvedValueOnce({
      ok: false,
      code: 'EVIDENCE_REQUIRED',
      message: 'Attach evidence that has passed the virus check before you submit.',
    });
    await user.clear(screen.getByLabelText(/Completed on/));
    await user.type(screen.getByLabelText(/Completed on/), '14/11/2024');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(
      await screen.findByText('Attach evidence that has passed the virus check before you submit.'),
    ).toBeTruthy();
    // Nothing reloads: what the person typed stays for another try.
    expect(actions.loadInstanceDrawer).toHaveBeenCalledOnce();
    expect(screen.getByLabelText<HTMLTextAreaElement>('What was done').value).toBe('Done');
  });

  it('submits with Ctrl+Enter from the submit comment, but Ctrl+Enter in a new comment posts the comment', async () => {
    const user = userEvent.setup();
    actions.runInstanceAction.mockResolvedValue(ok(detail({ version: 2 })));
    actions.postComment.mockResolvedValue(ok(comment({ kind: 'NOTE', body: 'On it.' })));
    renderDrawer();
    await user.type(await screen.findByLabelText(/Completed on/), '15/11/2024');
    await user.tab();
    await user.type(screen.getByLabelText('What was done'), 'Done{Control>}{Enter}{/Control}');
    await waitFor(() => expect(actions.runInstanceAction).toHaveBeenCalledOnce());

    // After posting, the drawer reads the instance again, which now has the comment.
    actions.loadInstanceDrawer.mockResolvedValue(
      ok(data({ comments: [comment(), comment({ id: CLIENT_ID, kind: 'NOTE', body: 'On it.' })] })),
    );
    await user.type(screen.getByLabelText('Add a comment'), 'On it.{Control>}{Enter}{/Control}');
    await waitFor(() => expect(actions.postComment).toHaveBeenCalledWith(row.id, 'On it.'));
    expect(actions.runInstanceAction).toHaveBeenCalledOnce();
    expect(await screen.findByText('On it.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Add a comment').value).toBe('');
  });

  it('keeps a comment that didn’t post', async () => {
    const user = userEvent.setup();
    actions.postComment.mockResolvedValue({
      ok: false,
      code: 'INTERNAL',
      message: 'Nope, try again.',
    });
    renderDrawer();
    await user.type(await screen.findByLabelText('Add a comment'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByText('Nope, try again.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Add a comment').value).toBe('Hello');
  });

  it('lets the approver approve, with an optional comment, or send back with a reason', async () => {
    const user = userEvent.setup();
    actions.loadInstanceDrawer.mockResolvedValue(
      ok(as(['APPROVE', 'SEND_BACK', 'COMMENT'], { workflowState: 'SUBMITTED', version: 3 })),
    );
    actions.runInstanceAction.mockResolvedValue(ok(detail({ workflowState: 'APPROVED' })));
    renderDrawer({ personId: APPROVER });
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const approve = screen.getByRole('alertdialog', { name: 'Approve this instance?' });
    await user.click(within(approve).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(actions.runInstanceAction).toHaveBeenCalledWith(row.id, {
        kind: 'APPROVE',
        version: 3,
      }),
    );
    expect(await screen.findByText('Approved.')).toBeTruthy();
    // The Approve button is still there (the stand-in API answers the same actions), so focus goes back to it.
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Approve'));

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.type(screen.getByLabelText('Comment (optional)'), 'Checked.');
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' }),
    );
    await waitFor(() =>
      expect(actions.runInstanceAction).toHaveBeenLastCalledWith(row.id, {
        kind: 'APPROVE',
        version: 3,
        comment: 'Checked.',
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Send back…' }));
    const back = screen.getByRole('alertdialog', { name: 'Send this back to the owner?' });
    await user.click(within(back).getByRole('button', { name: 'Send back' }));
    expect(within(back).getByText('Enter a reason.')).toBeTruthy();
    await user.type(within(back).getByLabelText(/Reason/), 'Wrong month');
    await user.click(within(back).getByRole('button', { name: 'Send back' }));
    await waitFor(() =>
      expect(actions.runInstanceAction).toHaveBeenLastCalledWith(row.id, {
        kind: 'SEND_BACK',
        version: 3,
        reason: 'Wrong month',
      }),
    );
  });

  it('names an NA request’s approval, and offers reopen and not-applicable when allowed', async () => {
    const user = userEvent.setup();
    actions.loadInstanceDrawer.mockResolvedValue(
      ok(
        as(['APPROVE', 'SEND_BACK'], {
          workflowState: 'SUBMITTED',
          pendingKind: 'NA',
          naReason: 'No boilers at this unit.',
        }),
      ),
    );
    const { rerender } = renderDrawer({ personId: APPROVER });
    expect(await screen.findByText('No boilers at this unit.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Approve as not applicable' }));
    expect(screen.getByRole('alertdialog', { name: 'Approve as not applicable?' })).toBeTruthy();
    await user.keyboard('{Escape}');

    actions.loadInstanceDrawer.mockResolvedValueOnce(
      ok(as(['REOPEN'], { workflowState: 'APPROVED' })),
    );
    actions.loadInstanceDrawer.mockResolvedValue(ok(as(['SUBMIT'])));
    actions.runInstanceAction.mockResolvedValue(
      ok(detail({ workflowState: 'OPEN', allowedActions: ['SUBMIT'] })),
    );
    rerender({ instanceId: '00000000-0000-5000-8000-000000000997' });
    await user.click(await screen.findByRole('button', { name: 'Reopen…' }));
    const reopen = screen.getByRole('alertdialog', { name: 'Reopen this instance?' });
    await user.type(within(reopen).getByLabelText(/Reason/), 'Wrong unit');
    await user.click(within(reopen).getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByText('Reopened.')).toBeTruthy();
    // Reopen is no longer offered, so focus goes to the title rather than nowhere.
    await waitFor(() => expect(document.activeElement?.tagName).toBe('H2'));

    actions.loadInstanceDrawer.mockResolvedValue(ok(as(['SUBMIT', 'REQUEST_NA'])));
    actions.runInstanceAction.mockResolvedValue(ok(detail({ workflowState: 'SUBMITTED' })));
    rerender({ instanceId: '00000000-0000-5000-8000-000000000996' });
    await user.click(await screen.findByRole('button', { name: 'Not applicable…' }));
    const na = screen.getByRole('alertdialog', { name: 'Ask to mark this not applicable?' });
    await user.type(within(na).getByLabelText(/doesn’t apply/), 'No boilers');
    await user.click(within(na).getByRole('button', { name: 'Ask for not applicable' }));
    await waitFor(() =>
      expect(actions.runInstanceAction).toHaveBeenLastCalledWith(
        '00000000-0000-5000-8000-000000000996',
        { kind: 'REQUEST_NA', version: 1, reason: 'No boilers' },
      ),
    );
    expect(await screen.findByText('Sent to the approver as not applicable.')).toBeTruthy();
  });

  it('reloads when the instance changed underneath, and keeps the dialog open on other failures', async () => {
    const user = userEvent.setup();
    actions.loadInstanceDrawer.mockResolvedValue(
      ok(as(['APPROVE', 'SEND_BACK'], { workflowState: 'SUBMITTED' })),
    );
    actions.runInstanceAction.mockResolvedValueOnce({
      ok: false,
      code: 'INTERNAL',
      message: 'That didn’t go through. Try again.',
    });
    renderDrawer({ personId: APPROVER });
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' }),
    );
    expect(await screen.findByText('That didn’t go through. Try again.')).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    actions.runInstanceAction.mockResolvedValueOnce({
      ok: false,
      code: 'STALE_VERSION',
      message: 'Someone changed this instance since you opened it.',
    });
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' }),
    );
    expect(
      await screen.findByText('Someone changed this instance since you opened it.'),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(actions.loadInstanceDrawer).toHaveBeenCalledTimes(2));
    expect(onChanged).not.toHaveBeenCalled();

    actions.runInstanceAction.mockRejectedValueOnce(new Error('network'));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' }),
    );
    expect(await screen.findAllByText('That didn’t go through. Try again.')).not.toHaveLength(0);
  });

  it('uploads evidence, waits for the virus check, then opens it', async () => {
    const user = userEvent.setup();
    const added = evidence({ fileName: 'challan.pdf', scanStatus: 'PENDING', sizeBytes: 13 });
    // The first read has no evidence; reads after the upload have the new file.
    actions.loadInstanceDrawer.mockResolvedValueOnce(ok(data({ evidence: [] })));
    actions.loadInstanceDrawer.mockResolvedValue(ok(data({ evidence: [added] })));
    actions.startEvidenceUpload.mockResolvedValue(
      ok({
        uploadId: '00000000-0000-5000-8000-000000000b01',
        url: 'https://files.mock.invalid/uploads/1',
        headers: {},
        expiresAt: T,
      }),
    );
    actions.confirmEvidenceUpload.mockResolvedValue(ok(added));
    actions.reloadEvidence.mockResolvedValue(ok([{ ...added, scanStatus: 'CLEAN' }]));
    actions.evidenceDownload.mockResolvedValue(ok('https://files.example.com/signed'));
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    const open = vi.fn(() => tab);
    vi.stubGlobal('open', open);

    renderDrawer();
    await screen.findByRole('group', { name: 'Add evidence' });
    const input = dialog().querySelector<HTMLInputElement>('input[type=file]')!;
    await user.upload(
      input,
      new File(['%PDF-1.4 demo'], 'challan.pdf', { type: 'application/pdf' }),
    );
    const files = await screen.findByRole('list', { name: 'Evidence files' });
    expect(await within(files).findByText(/Checking for viruses/)).toBeTruthy();
    expect(actions.startEvidenceUpload).toHaveBeenCalledWith(row.id, {
      fileName: 'challan.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 13,
    });
    expect(within(files).queryByRole('button', { name: 'Open challan.pdf' })).toBeNull();

    await waitFor(() => expect(actions.reloadEvidence).toHaveBeenCalled(), {
      timeout: SCAN_POLL_MS + 1000,
    });
    await user.click(await within(files).findByRole('button', { name: 'Open challan.pdf' }));
    await waitFor(() => expect(tab.location.href).toBe('https://files.example.com/signed'));
    expect(tab.opener).toBeNull();
    expect(actions.evidenceDownload).toHaveBeenCalledWith(added.id);
  });

  it('says why a file didn’t upload or open', async () => {
    const user = userEvent.setup();
    actions.loadInstanceDrawer.mockResolvedValue(ok(data()));
    actions.startEvidenceUpload.mockResolvedValue({
      ok: false,
      code: 'INVALID_TRANSITION',
      message: 'This instance has moved on.',
    });
    actions.evidenceDownload.mockResolvedValue({ ok: false, code: 'FORBIDDEN', message: 'No.' });
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.stubGlobal(
      'open',
      vi.fn(() => tab),
    );
    renderDrawer();
    await screen.findByRole('group', { name: 'Add evidence' });
    await user.upload(
      dialog().querySelector<HTMLInputElement>('input[type=file]')!,
      new File(['x'], 'a.pdf', { type: 'application/pdf' }),
    );
    expect(await screen.findByText('This instance has moved on.')).toBeTruthy();
    expect(await screen.findByText('Upload failed')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry a.pdf' }));
    await waitFor(() => expect(actions.startEvidenceUpload).toHaveBeenCalledTimes(2));
    await user.click(await screen.findByRole('button', { name: 'Remove a.pdf' }));
    expect(screen.queryByText('Upload failed')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Open bank-receipt.pdf' }));
    expect(await screen.findByText('No.')).toBeTruthy();
    expect(tab.close).toHaveBeenCalled();

    vi.stubGlobal(
      'open',
      vi.fn(() => null),
    );
    actions.evidenceDownload.mockResolvedValue(ok('https://files.example.com/signed'));
    await user.click(screen.getByRole('button', { name: 'Open bank-receipt.pdf' }));
    expect(await screen.findByText('Allow pop-ups for this site to open evidence.')).toBeTruthy();
  });

  it('removes evidence with a reason, for the owner and managers only', async () => {
    const user = userEvent.setup();
    actions.removeEvidenceFile.mockResolvedValueOnce({
      ok: false,
      code: 'FORBIDDEN',
      message: 'Not yours.',
    });
    actions.removeEvidenceFile.mockResolvedValueOnce(ok(evidence({ archivedAt: T })));
    const { rerender } = renderDrawer({ personId: APPROVER });
    await screen.findByRole('list', { name: 'Evidence files' });
    expect(screen.queryByRole('button', { name: 'Remove bank-receipt.pdf' })).toBeNull();

    rerender({ personId: APPROVER, canManage: true });
    await user.click(screen.getByRole('button', { name: 'Remove bank-receipt.pdf' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Remove bank-receipt.pdf?' });
    await user.type(within(confirm).getByLabelText(/Reason/), 'Wrong file');
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Not yours.')).toBeTruthy();
    actions.loadInstanceDrawer.mockResolvedValue(ok(data({ evidence: [] })));
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Evidence files' })).toBeNull());
    expect(actions.removeEvidenceFile).toHaveBeenLastCalledWith(evidence().id, 'Wrong file');

    actions.loadInstanceDrawer.mockResolvedValue(ok(as(['COMMENT'])));
    rerender({
      instanceId: '00000000-0000-5000-8000-000000000995',
      personId: OWNER,
      canManage: true,
    });
    await screen.findByRole('list', { name: 'Evidence files' });
    // Approved or otherwise closed: nobody adds or removes files.
    expect(screen.queryByRole('button', { name: 'Remove bank-receipt.pdf' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Add evidence' })).toBeNull();
  });

  it('hides previous and next while something is typed, and loads earlier history', async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    actions.loadInstanceDrawer.mockResolvedValue(
      ok(data({ audit: { ...data().audit, nextCursor: 'c2' } })),
    );
    actions.loadMoreHistory.mockResolvedValue(
      ok({
        events: [
          {
            ...data().audit.events[0]!,
            id: '00000000-0000-5000-8000-000000000a02',
            action: 'EVIDENCE_ADD',
          },
        ],
        nextCursor: null,
      }),
    );
    renderDrawer({ onNext, onPrev: vi.fn() });
    await user.click(await screen.findByRole('button', { name: 'Next instance' }));
    expect(onNext).toHaveBeenCalledOnce();

    await user.type(screen.getByLabelText('Add a comment'), 'x');
    expect(screen.queryByRole('button', { name: 'Next instance' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous instance' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show earlier activity' }));
    expect(await screen.findByText(/added evidence/)).toBeTruthy();
    expect(actions.loadMoreHistory).toHaveBeenCalledWith(row.id, 'c2');
    expect(screen.queryByRole('button', { name: 'Show earlier activity' })).toBeNull();
  });

  it('says when more history or comments didn’t load', async () => {
    const user = userEvent.setup();
    actions.loadInstanceDrawer.mockResolvedValue(
      ok(data({ moreComments: true, audit: { ...data().audit, nextCursor: 'c2' } })),
    );
    actions.loadMoreHistory.mockResolvedValue({ ok: false, code: 'INTERNAL', message: 'x' });
    renderDrawer();
    expect(await screen.findByText('Showing the first 1 comments.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show earlier activity' }));
    expect(await screen.findByText('More history didn’t load. Try again.')).toBeTruthy();
  });

  it('asks before closing over unsaved input', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await user.type(await screen.findByLabelText('Add a comment'), 'half a thought');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('alertdialog', { name: 'Discard what you’ve typed?' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('names the signed-in person nowhere it shouldn’t: an unknown author is "Someone", an import "Imported"', async () => {
    actions.loadInstanceDrawer.mockResolvedValue(
      ok(
        data({
          comments: [
            comment({ authorId: PERSON_ID, kind: 'NOTE', body: 'From a stranger' }),
            comment({
              id: '00000000-0000-5000-8000-000000000c02',
              authorId: null,
              kind: 'IMPORT',
              body: 'From the Excel',
            }),
          ],
        }),
      ),
    );
    renderDrawer();
    const comments = await screen.findByRole('list', { name: 'Comments' });
    expect(within(comments).getByText('Someone')).toBeTruthy();
    expect(within(comments).getByText('Imported').parentElement!.textContent).toContain('Imported');
  });
});
