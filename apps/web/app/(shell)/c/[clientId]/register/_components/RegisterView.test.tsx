import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from '@canopy/ui';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegisterPage } from '../_lib/register-api';
import { CLIENT_ID, makeRow, makeRows, PERSON_ID } from '../_test/rows';

const PATH = `/c/${CLIENT_ID}/register`;

vi.mock('next/navigation', () => ({
  usePathname: () => PATH,
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const actions = vi.hoisted(() => ({
  loadMoreRows: vi.fn(),
  bulkApproveRows: vi.fn(),
  startRegisterExport: vi.fn(),
  registerExportState: vi.fn(),
  waitingRows: vi.fn(),
}));
vi.mock('../actions', () => actions);

const { RegisterView, EXPORT_POLL_MS } = await import('./RegisterView');
type Props = Parameters<typeof RegisterView>[0];

const QUERY = 'fy=2022-23&sort=dueDate';
const facets = { departments: [], acts: [], units: [], categories: [] };

function view(props: Partial<Props> = {}) {
  return (
    <>
      <RegisterView
        clientId={CLIENT_ID}
        personId={PERSON_ID}
        query={QUERY}
        page={{ rows: makeRows(3), nextCursor: null, total: 3 }}
        facets={facets}
        canApprove={false}
        canExport={false}
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

const assign = vi.fn();
beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('RegisterView', () => {
  it('loads the next page on request and stops when the server has no more', async () => {
    const user = userEvent.setup();
    const next: RegisterPage = { rows: [makeRow(4)], nextCursor: null };
    actions.loadMoreRows.mockResolvedValue(next);
    renderView({ page: { rows: makeRows(3), nextCursor: 'c1', total: 4 } });
    expect(screen.getByText('Showing 3 of 4')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(actions.loadMoreRows).toHaveBeenCalledWith(CLIENT_ID, QUERY, 'c1');
    await waitFor(() => expect(screen.getByText('Obligation 4')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('starts again from the new first page when the URL changes', async () => {
    const user = userEvent.setup();
    actions.loadMoreRows.mockResolvedValue({ rows: [makeRow(4)], nextCursor: 'c2' });
    const { rerender } = renderView({ page: { rows: makeRows(3), nextCursor: 'c1', total: 9 } });
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getByText('Obligation 4')).toBeTruthy());
    rerender({ query: 'status=OVERDUE', page: { rows: [makeRow(7)], nextCursor: null, total: 1 } });
    expect(screen.queryByText('Obligation 4')).toBeNull();
    expect(screen.getByText('Obligation 7')).toBeTruthy();
  });

  it('says so when more rows fail to load', async () => {
    const user = userEvent.setup();
    actions.loadMoreRows.mockRejectedValue(new Error('down'));
    renderView({ page: { rows: makeRows(3), nextCursor: 'c1', total: 9 } });
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('More rows didn’t load. Try again.')).toBeTruthy();
  });

  it('approves the selected rows with the versions they were shown at', async () => {
    const user = userEvent.setup();
    actions.bulkApproveRows.mockResolvedValue({ tone: 'success', message: 'Approved 1 instance.' });
    const rows = makeRows(3).map((r, i) => ({ ...r, version: i + 4 }));
    renderView({ page: { rows, nextCursor: null, total: 3 }, canApprove: true });
    await user.click(screen.getByRole('checkbox', { name: 'Select TAX-CL-0002, Obligation 2' }));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve 1 instance?' });
    expect(dialog.textContent).toContain('Approves the selected instance as you see it.');
    expect(actions.bulkApproveRows).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(actions.bulkApproveRows).toHaveBeenCalledWith(CLIENT_ID, [
      { id: rows[2]!.id, version: 6 },
    ]);
    expect(await screen.findByText('Approved 1 instance.')).toBeTruthy();
  });

  it('asks before "Select all", then approves the waiting rows at the versions the page loaded', async () => {
    const user = userEvent.setup();
    const rows = makeRows(3).map((r) => ({ ...r, version: 2 }));
    // Row 0 changed since the page loaded it; the unloaded row goes at the version just read.
    actions.waitingRows.mockResolvedValue([
      { id: rows[0]!.id, version: 3 },
      { id: 'unloaded', version: 5 },
    ]);
    actions.bulkApproveRows.mockResolvedValue({ tone: 'warn', message: 'Approved 1 of 2.' });
    renderView({ page: { rows, nextCursor: 'c1', total: 424 }, canApprove: true });
    await user.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    await user.click(screen.getByRole('button', { name: 'Select all 424' }));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(actions.waitingRows).toHaveBeenCalledWith(CLIENT_ID, QUERY);
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve 2 instances?' });
    expect(dialog.textContent).toContain(
      'These are all 2 instances in this view waiting for approval.',
    );
    expect(actions.bulkApproveRows).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(actions.bulkApproveRows).toHaveBeenCalledWith(CLIENT_ID, [
      { id: rows[0]!.id, version: 2 },
      { id: 'unloaded', version: 5 },
    ]);
    expect(await screen.findByText('Approved 1 of 2.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('approves nothing when "Select all" is cancelled, finds nothing waiting, or can’t list the rows', async () => {
    const user = userEvent.setup();
    renderView({ page: { rows: makeRows(3), nextCursor: 'c1', total: 9 }, canApprove: true });
    const approveAll = async () => {
      const box = screen.getByRole('checkbox', { name: 'Select all rows' });
      if (box.getAttribute('aria-checked') !== 'true' && !(box as HTMLInputElement).checked) {
        await user.click(box);
      }
      const all = screen.queryByRole('button', { name: 'Select all 9' });
      if (all) await user.click(all);
      await user.click(screen.getByRole('button', { name: 'Approve' }));
    };

    actions.waitingRows.mockResolvedValue([{ id: 'x', version: 1 }]);
    await approveAll();
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve 1 instance?' });
    expect(dialog.textContent).toContain('This is the one instance');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    actions.waitingRows.mockResolvedValue([]);
    await approveAll();
    expect(await screen.findByText('Nothing in this view is waiting for approval.')).toBeTruthy();

    actions.waitingRows.mockRejectedValue(new Error('down'));
    await approveAll();
    expect(await screen.findByText('The rows to approve didn’t load. Try again.')).toBeTruthy();

    // More than one approval takes: say so and ask nothing.
    actions.waitingRows.mockResolvedValue(
      Array.from({ length: 2001 }, (_, i) => ({ id: `id-${i}`, version: 1 })),
    );
    await approveAll();
    expect(
      await screen.findByText(
        'More than 2,000 instances are selected. Narrow the filters to approve up to 2,000 at a time.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(actions.bulkApproveRows).not.toHaveBeenCalled();
  });

  it('says so when the approvals fail, and offers no approve without the role', async () => {
    const user = userEvent.setup();
    actions.bulkApproveRows.mockRejectedValue(new Error('down'));
    const { rerender } = renderView({ canApprove: true });
    await user.click(screen.getByRole('checkbox', { name: 'Select TAX-CL-0001, Obligation 1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select TAX-CL-0002, Obligation 2' }));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve 2 instances?' });
    expect(dialog.textContent).toContain('Approves the 2 instances you selected as you see them.');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('The approvals didn’t go through. Try again.')).toBeTruthy();
    rerender({ canApprove: false });
    expect(screen.queryAllByRole('checkbox', { name: /TAX-CL-0001/ })).toHaveLength(0);
  });

  it('exports this view and downloads it when ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    actions.startRegisterExport.mockResolvedValue('job-1');
    actions.registerExportState
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'ready', url: 'https://files.test/x.xlsx' });
    renderView({ canExport: true });
    await user.click(screen.getByRole('button', { name: /Export/ }));
    expect(actions.startRegisterExport).toHaveBeenCalledWith(CLIENT_ID, QUERY);
    expect(await screen.findByText('Preparing your Excel export…')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(EXPORT_POLL_MS));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://files.test/x.xlsx'));
    expect(actions.registerExportState).toHaveBeenCalledWith('job-1');
  });

  it('says when an export fails or doesn’t start, and offers none to an owner', async () => {
    const user = userEvent.setup();
    actions.startRegisterExport.mockResolvedValue('job-1');
    actions.registerExportState.mockResolvedValue({ status: 'failed' });
    const { rerender } = renderView({ canExport: true });
    await user.click(screen.getByRole('button', { name: /Export/ }));
    expect(await screen.findByText('The export didn’t finish. Try again.')).toBeTruthy();
    actions.startRegisterExport.mockRejectedValue(new Error('down'));
    await user.click(screen.getByRole('button', { name: /Export/ }));
    expect(await screen.findByText('The export didn’t start. Try again.')).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    rerender({ canExport: false });
    expect(screen.queryByRole('button', { name: /Export/ })).toBeNull();
  });
});
