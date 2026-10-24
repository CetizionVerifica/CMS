import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { breakdown, CLIENT, id, instance, result } from '../overview/test-data';
import { overdueRows, reportRows } from './reports-model';

const actions = vi.hoisted(() => ({
  startExportAction: vi.fn(),
  exportProgressAction: vi.fn(),
}));
vi.mock('./actions', () => actions);

const { ReportsView } = await import('./ReportsView');

const acts = reportRows(
  CLIENT,
  breakdown('act', [
    { key: id(1), label: 'Factories Act', result: result({ OVERDUE: 2, COMPLIED: 1 }, 40, 50) },
    { key: id(2), label: 'Shops Act', result: result({}) },
  ]),
  'actId',
  { fy: '2024-25' },
);
const departments = reportRows(
  CLIENT,
  breakdown('department', [{ key: id(3), label: 'EHS', result: result({ UPCOMING: 1 }, 100) }]),
  'departmentId',
  { fy: '2024-25' },
);
const overdue = overdueRows(
  [
    instance(1, {
      status: 'OVERDUE',
      overdueDays: 12,
      title: 'Annual return',
      dueDate: '2024-06-30' as never,
    }),
  ],
  { fy: '2024-25' },
);

const assign = vi.fn();
beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const view = (fy: string | null = '2024-25') =>
  render(
    <ReportsView
      clientId={CLIENT}
      fy={fy}
      acts={acts}
      departments={departments}
      overdue={overdue}
    />,
  );

describe('ReportsView', () => {
  it('shows scores by Act and department, with each count linking to its rows', () => {
    view();
    const byAct = screen.getByRole('table', { name: 'Scores by Act' });
    const [, factories, shops] = within(byAct).getAllByRole('row');
    expect(factories!.textContent).toContain('40%');
    expect(
      within(factories!)
        .getByRole('link', { name: '2 overdue under Factories Act' })
        .getAttribute('href'),
    ).toBe(acts[0]!.overdue.href);
    expect(shops!.textContent).toContain('No items due');
    const byDepartment = screen.getByRole('table', { name: 'Scores by department' });
    expect(within(byDepartment).getByRole('link', { name: '1 still open under EHS' })).toBeTruthy();
    const late = screen.getByRole('table', { name: 'Overdue instances' });
    expect(late.textContent).toContain('Annual return');
    expect(late.textContent).toContain('30 Jun 2024');
  });

  it('says when nothing is overdue', () => {
    render(<ReportsView clientId={CLIENT} fy={null} acts={[]} departments={[]} overdue={[]} />);
    expect(screen.getByText('Nothing is overdue in this period.')).toBeTruthy();
    expect(screen.getByText('Each download covers the current financial year.')).toBeTruthy();
  });

  it('downloads a report once its export is ready', async () => {
    actions.startExportAction.mockResolvedValue({ ok: true, id: 'x1' });
    actions.exportProgressAction.mockResolvedValue({
      status: 'ready',
      url: 'https://files.example/x1',
    });
    view();
    await userEvent.click(
      screen.getByRole('button', { name: 'Download the Act-wise report (Excel)' }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://files.example/x1'));
    expect(actions.startExportAction).toHaveBeenCalledWith(CLIENT, 'ACT_REPORT_XLSX', '2024-25');
    expect(screen.getByRole('status').textContent).toBe('The act-wise report is downloading.');
  });

  it('waits for an export that is still being prepared', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    actions.startExportAction.mockResolvedValue({ ok: true, id: 'x2' });
    actions.exportProgressAction
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'ready', url: 'https://files.example/x2' });
    view();
    await userEvent.click(
      screen.getByRole('button', { name: 'Download the Compliance certificate (PDF)' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://files.example/x2'));
    expect(actions.exportProgressAction).toHaveBeenCalledTimes(2);
  });

  it('says why a download did not start or failed', async () => {
    actions.startExportAction.mockResolvedValueOnce({
      ok: false,
      message: 'You can’t download reports for this client.',
    });
    view();
    await userEvent.click(
      screen.getByRole('button', { name: 'Download the Overdue report (Excel)' }),
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      'You can’t download reports for this client.',
    );

    actions.startExportAction.mockResolvedValueOnce({ ok: true, id: 'x3' });
    actions.exportProgressAction.mockResolvedValueOnce({
      status: 'failed',
      message: 'The download couldn’t be prepared. Try again.',
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Download the Overdue report (Excel)' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'The download couldn’t be prepared. Try again.',
      ),
    );
    expect(assign).not.toHaveBeenCalled();
  });
});
