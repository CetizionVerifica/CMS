import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstanceRow } from '@canopy/contracts';
import { Toaster } from '@canopy/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLIENT_ID, makeRow, PERSON_ID } from '../../register/_test/rows';
import type { ApprovalsPage } from '../_lib/approvals-api';

const PATH = `/c/${CLIENT_ID}/approvals`;

const nav = vi.hoisted(() => ({ path: '', refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: nav.refresh }),
}));
const actions = vi.hoisted(() => ({ loadMoreApprovals: vi.fn() }));
vi.mock('../actions', () => actions);
const drawerActions = vi.hoisted(() => ({ runInstanceAction: vi.fn() }));
vi.mock('../../register/instance-actions', () => drawerActions);
// The drawer has its own tests; here a stand-in shows what the view hands it.
const changed = vi.hoisted(() => ({ state: 'APPROVED' }));
vi.mock('../../register/_components/InstanceDrawer', () => ({
  InstanceDrawer: (p: {
    instanceId: string | null;
    fallbackTitle?: string;
    backLabel?: string;
    onClose: () => void;
    onPrev?: () => void;
    onNext?: () => void;
    onChanged: (detail: unknown) => void;
  }) =>
    p.instanceId === null ? null : (
      <div data-testid="drawer">
        <span>
          {p.instanceId} {p.fallbackTitle} {p.backLabel}
        </span>
        <button onClick={p.onClose}>Close drawer</button>
        {p.onPrev ? <button onClick={p.onPrev}>Previous</button> : null}
        {p.onNext ? <button onClick={p.onNext}>Next</button> : null}
        <button
          onClick={() =>
            p.onChanged({
              ...waiting(0),
              workflowState: changed.state,
              description: 'd',
              applicabilityText: null,
              naReason: null,
              forms: [],
              logSheets: [],
              evidenceRequired: false,
              allowedActions: [],
            })
          }
        >
          Decide in the drawer
        </button>
      </div>
    ),
}));

const { ApprovalsView, waitingLine } = await import('./ApprovalsView');
type Props = Parameters<typeof ApprovalsView>[0];

function waiting(i: number, overrides: Partial<InstanceRow> = {}): InstanceRow {
  return makeRow(i, {
    workflowState: 'SUBMITTED',
    pendingKind: 'COMPLETION',
    status: 'SUBMITTED',
    ...overrides,
  });
}
const rows3 = () => [waiting(0), waiting(1, { pendingKind: 'NA' }), waiting(2)];
const page = (rows = rows3(), nextCursor: string | null = null): ApprovalsPage => ({
  rows,
  nextCursor,
  total: rows.length,
});

function view(props: Partial<Props> = {}) {
  return (
    <>
      <ApprovalsView
        clientId={CLIENT_ID}
        personId={PERSON_ID}
        scope="mine"
        page={page()}
        waitingEverywhere={3}
        canManage={false}
        timeZone="Asia/Kolkata"
        {...props}
      />
      <Toaster />
    </>
  );
}
function renderView(props: Partial<Props> = {}) {
  const utils = render(view(props));
  return { ...utils, rerender: (next: Partial<Props>) => utils.rerender(view(next)) };
}
const link = (i: number) => screen.getByRole('link', { name: new RegExp(`^Obligation ${i},`) });
const ok = (data: unknown = {}) => ({ ok: true, data });

let push: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  nav.path = PATH;
  nav.refresh.mockReset();
  actions.loadMoreApprovals.mockReset();
  drawerActions.runInstanceAction.mockReset();
  changed.state = 'APPROVED';
  push = vi.spyOn(window.history, 'pushState').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('waitingLine', () => {
  it('counts here, and across all clients when more wait elsewhere', () => {
    expect(waitingLine(1, 1, 'mine')).toBe('1 item waiting for your approval here.');
    expect(waitingLine(2, 5, 'mine')).toBe(
      '2 items waiting for your approval here, 5 across all your clients.',
    );
    expect(waitingLine(1200, 0, 'client')).toBe('1,200 items waiting for approval here.');
  });
});

describe('ApprovalsView', () => {
  it('lists what waits, says who sent it and what it asks for, and offers the shortcuts', async () => {
    renderView({ waitingEverywhere: 7 });
    expect(
      screen.getByRole('heading', {
        name: '3 items waiting for your approval here, 7 across all your clients.',
      }),
    ).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Waiting for approval' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(list.textContent).toContain('Owner 01 marked done');
    expect(list.textContent).toContain('Owner 01 asks to mark not applicable');
    expect(link(0).getAttribute('href')).toBe(`${PATH}/${waiting(0).id}`);
    await userEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' }).textContent).toContain(
      'Send back',
    );
  });

  it('says so when nothing is waiting', () => {
    renderView({ page: page([]), waitingEverywhere: 0 });
    expect(screen.getByText('Nothing waiting for your approval.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^0 items/ })).toBeTruthy();
  });

  it('approves with A on a row, with the version seen, and moves focus to the next row', async () => {
    drawerActions.runInstanceAction.mockResolvedValue(ok());
    renderView();
    link(0).focus();
    await userEvent.keyboard('a');
    expect(drawerActions.runInstanceAction).toHaveBeenCalledWith(waiting(0).id, {
      kind: 'APPROVE',
      version: 1,
    });
    expect(await screen.findByText('Approved “Obligation 0”.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Obligation 0,/ })).toBeNull();
    expect(document.activeElement).toBe(link(1));
    expect(screen.getByRole('heading', { name: /^2 items/ })).toBeTruthy();
    expect(nav.refresh).toHaveBeenCalledOnce();
  });

  it('moves with J and K, and an approved NA request says so', async () => {
    drawerActions.runInstanceAction.mockResolvedValue(ok());
    renderView();
    link(0).focus();
    await userEvent.keyboard('j');
    expect(document.activeElement).toBe(link(1));
    await userEvent.keyboard('jk');
    expect(document.activeElement).toBe(link(1));
    await userEvent.click(screen.getByRole('button', { name: 'Approve Obligation 1' }));
    expect(await screen.findByText('Approved “Obligation 1” as not applicable.')).toBeTruthy();
  });

  it('sends back with S and a reason, then focuses the row that took its place', async () => {
    drawerActions.runInstanceAction.mockResolvedValue(ok());
    renderView();
    link(1).focus();
    await userEvent.keyboard('s');
    const dialog = await screen.findByRole('alertdialog', { name: 'Send back to Owner 01?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send back' }));
    expect(drawerActions.runInstanceAction).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Challan is for the wrong month');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send back' }));
    expect(drawerActions.runInstanceAction).toHaveBeenCalledWith(waiting(1).id, {
      kind: 'SEND_BACK',
      version: 1,
      reason: 'Challan is for the wrong month',
    });
    expect(await screen.findByText('Sent “Obligation 1” back to Owner 01.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(link(2)));
  });

  it('keeps the dialog and the reason when the send back fails, and closes it when the row moved on', async () => {
    drawerActions.runInstanceAction.mockResolvedValueOnce({
      ok: false,
      code: 'FORBIDDEN',
      message: 'You can’t send this back.',
    });
    renderView();
    await userEvent.click(screen.getByRole('button', { name: 'Send back Obligation 0' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Wrong file');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send back' }));
    expect(await screen.findByText('You can’t send this back.')).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect((within(dialog).getByLabelText(/Reason/) as HTMLTextAreaElement).value).toBe(
      'Wrong file',
    );
    expect(nav.refresh).not.toHaveBeenCalled();

    drawerActions.runInstanceAction.mockResolvedValueOnce({
      ok: false,
      code: 'STALE_VERSION',
      message: 'Someone changed this while you were looking at it.',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send back' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(nav.refresh).toHaveBeenCalledOnce();
    // The row stays until the refreshed page says otherwise.
    expect(link(0)).toBeTruthy();
  });

  it('answers a failed approve without losing the row', async () => {
    drawerActions.runInstanceAction.mockRejectedValueOnce(new Error('network'));
    renderView();
    await userEvent.click(screen.getByRole('button', { name: 'Approve Obligation 2' }));
    expect(await screen.findByText('That didn’t go through. Try again.')).toBeTruthy();
    expect(link(2)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Approve Obligation 2' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('loads more on request, without repeating rows, and says when that fails', async () => {
    actions.loadMoreApprovals.mockResolvedValueOnce({
      rows: [waiting(2), waiting(3)],
      nextCursor: 'c2',
    });
    renderView({ page: page(rows3(), 'c1'), scope: 'client' });
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(actions.loadMoreApprovals).toHaveBeenCalledWith(CLIENT_ID, 'client', 'c1');
    expect(await screen.findByRole('link', { name: /^Obligation 3,/ })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /^Obligation 2,/ })).toHaveLength(1);

    actions.loadMoreApprovals.mockRejectedValueOnce(new Error('network'));
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('More items didn’t load. Try again.')).toBeTruthy();
  });

  it('takes a new first page from the server after a refresh', () => {
    const { rerender } = renderView();
    rerender({ page: page([waiting(5)]) });
    expect(
      within(screen.getByRole('list', { name: 'Waiting for approval' })).getAllByRole('listitem'),
    ).toHaveLength(1);
    expect(link(5)).toBeTruthy();
  });

  describe('the drawer', () => {
    it('opens a row in place on a plain click, and leaves a new-tab click alone', async () => {
      renderView();
      await userEvent.click(link(0));
      expect(push).toHaveBeenCalledWith(null, '', `${PATH}/${waiting(0).id}`);

      push.mockClear();
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
      act(() => {
        link(1).dispatchEvent(click);
      });
      expect(push).not.toHaveBeenCalled();
      expect(click.defaultPrevented).toBe(false);
    });

    it('shows the instance in the path and moves through the list', async () => {
      const replace = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
      nav.path = `${PATH}/${waiting(1).id}`;
      renderView();
      expect(screen.getByTestId('drawer').textContent).toContain(
        `${waiting(1).id} Obligation 1 Back to approvals`,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Next' }));
      expect(replace).toHaveBeenCalledWith(null, '', `${PATH}/${waiting(2).id}`);
      await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
      expect(replace).toHaveBeenCalledWith(null, '', `${PATH}/${waiting(0).id}`);
      await userEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
      expect(push).toHaveBeenCalledWith(null, '', PATH);
    });

    it('drops a row decided in the drawer when it closes, and refreshes the page', async () => {
      nav.path = `${PATH}/${waiting(0).id}`;
      // The same page: closing the drawer changes the path, not what the server rendered.
      const props = { page: page() };
      const { rerender } = renderView(props);
      await userEvent.click(screen.getByRole('button', { name: 'Decide in the drawer' }));
      // Still listed while the drawer is open, so previous and next keep working.
      expect(link(0)).toBeTruthy();
      expect(nav.refresh).not.toHaveBeenCalled();
      nav.path = PATH;
      rerender(props);
      expect(screen.queryByRole('link', { name: /^Obligation 0,/ })).toBeNull();
      expect(screen.getByRole('heading', { name: /^2 items/ })).toBeTruthy();
      expect(nav.refresh).toHaveBeenCalledOnce();
    });

    it('keeps a row that still waits after a change in the drawer, such as a comment', async () => {
      changed.state = 'SUBMITTED';
      nav.path = `${PATH}/${waiting(0).id}`;
      const props = { page: page() };
      const { rerender } = renderView(props);
      await userEvent.click(screen.getByRole('button', { name: 'Decide in the drawer' }));
      nav.path = PATH;
      rerender(props);
      expect(link(0)).toBeTruthy();
      expect(screen.getByRole('heading', { name: /^3 items/ })).toBeTruthy();
      expect(nav.refresh).toHaveBeenCalledOnce();
    });
  });
});
