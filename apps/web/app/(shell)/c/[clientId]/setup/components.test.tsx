import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const actions = vi.hoisted(() => ({
  createDepartmentAction: vi.fn(),
  updateDepartmentAction: vi.fn(),
  mergeDepartmentsAction: vi.fn(),
  saveRemindersAction: vi.fn(),
}));
vi.mock('./actions', () => actions);
vi.mock('../actions', () => actions);
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const { DepartmentsView } = await import('./departments/DepartmentsView');
const { RemindersForm } = await import('./reminders/RemindersForm');

const CLIENT = '00000000-0000-5000-8000-000000000101';
const ok = { ok: true } as const;
const no = (message: string) => ({ ok: false, message }) as const;
const rows = [
  { id: 'd1', name: 'EHS', aliases: 'Safety', version: 2 },
  { id: 'd2', name: 'Human Resources', aliases: '', version: 1 },
  { id: 'd3', name: 'HR', aliases: '', version: 1 },
];

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  router.push.mockReset();
  router.refresh.mockReset();
});

describe('DepartmentsView', () => {
  it('lists departments with their other spellings', () => {
    render(<DepartmentsView clientId={CLIENT} rows={rows} />);
    const table = screen.getByRole('table', { name: 'Departments' });
    const [, ehs, hr] = within(table).getAllByRole('row');
    expect(ehs!.textContent).toContain('Safety');
    expect(hr!.textContent).toContain('—');
  });

  it('says what to do when there are none', () => {
    render(<DepartmentsView clientId={CLIENT} rows={[]} />);
    expect(screen.getByText(/No departments yet/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('adds a department, then clears the form and says so', async () => {
    actions.createDepartmentAction.mockResolvedValue(ok);
    render(<DepartmentsView clientId={CLIENT} rows={rows} />);
    const add = screen.getByRole('button', { name: /Add department/ });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(add);
    expect(actions.createDepartmentAction).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Department name'), ' Quality ');
    await userEvent.type(screen.getByLabelText('Other spellings (optional)'), 'QA, quality, QC');
    await userEvent.click(screen.getByRole('button', { name: 'Add department' }));
    expect(actions.createDepartmentAction).toHaveBeenCalledWith(CLIENT, {
      name: 'Quality',
      aliases: ['QA', 'QC'],
    });
    expect(await screen.findByText('Quality was added.')).toBeTruthy();
    expect((screen.getByLabelText('Department name') as HTMLInputElement).value).toBe('');
    expect(router.refresh).toHaveBeenCalled();
  });

  it('shows a refused add', async () => {
    actions.createDepartmentAction.mockResolvedValue(
      no('This client already has a department with that name.'),
    );
    render(<DepartmentsView clientId={CLIENT} rows={rows} />);
    await userEvent.type(screen.getByLabelText('Department name'), 'EHS');
    await userEvent.click(screen.getByRole('button', { name: 'Add department' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This client already has a department with that name.',
    );
    expect((screen.getByLabelText('Department name') as HTMLInputElement).value).toBe('EHS');
  });

  it('renames a department and changes its spellings', async () => {
    actions.updateDepartmentAction.mockResolvedValue(ok);
    render(<DepartmentsView clientId={CLIENT} rows={rows} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit EHS' }));
    const drawer = screen.getByRole('dialog', { name: 'EHS' });
    const save = within(drawer).getByRole('button', { name: /Save changes/ });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    const name = within(drawer).getByLabelText('Department name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Health and safety');
    await userEvent.type(within(drawer).getByLabelText('Other spellings'), ', EHS');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save changes' }));
    expect(actions.updateDepartmentAction).toHaveBeenCalledWith(CLIENT, 'd1', {
      version: 2,
      name: 'Health and safety',
      aliases: ['Safety', 'EHS'],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the drawer open with the reason when a save is refused', async () => {
    actions.updateDepartmentAction.mockResolvedValue(no('Someone else changed this.'));
    render(<DepartmentsView clientId={CLIENT} rows={rows} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit EHS' }));
    const drawer = screen.getByRole('dialog', { name: 'EHS' });
    await userEvent.type(within(drawer).getByLabelText('Other spellings'), ', Environment');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save changes' }));
    expect((await within(drawer).findByRole('alert')).textContent).toBe(
      'Someone else changed this.',
    );
    // A rename only changes the name; aliases-only saves send no name.
    expect(actions.updateDepartmentAction.mock.calls[0]![2]).toEqual({
      version: 2,
      aliases: ['Safety', 'Environment'],
    });
    expect(router.refresh).toHaveBeenCalled();
  });

  it('merges duplicates into a department after a confirmation', async () => {
    actions.mergeDepartmentsAction.mockResolvedValue(ok);
    render(<DepartmentsView clientId={CLIENT} rows={rows} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit Human Resources' }));
    const drawer = screen.getByRole('dialog', { name: 'Human Resources' });
    const group = within(drawer).getByRole('group', {
      name: 'Merge other departments into Human Resources',
    });
    expect(
      within(group)
        .getByRole('button', { name: /Merge department/ })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    await userEvent.click(within(group).getByRole('checkbox', { name: 'HR' }));
    await userEvent.click(within(group).getByRole('button', { name: 'Merge department' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Merge HR into Human Resources?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Merge' }));
    expect(actions.mergeDepartmentsAction).toHaveBeenCalledWith(CLIENT, 'd2', {
      version: 1,
      sourceIds: ['d3'],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('names the count when several are merged, and unticks', async () => {
    render(<DepartmentsView clientId={CLIENT} rows={rows} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit EHS' }));
    const drawer = screen.getByRole('dialog', { name: 'EHS' });
    await userEvent.click(within(drawer).getByRole('checkbox', { name: 'HR' }));
    await userEvent.click(within(drawer).getByRole('checkbox', { name: 'Human Resources' }));
    await userEvent.click(within(drawer).getByRole('checkbox', { name: 'HR' }));
    await userEvent.click(within(drawer).getByRole('checkbox', { name: 'HR' }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Merge departments' }));
    expect(screen.getByRole('alertdialog', { name: 'Merge 2 departments into EHS?' })).toBeTruthy();
  });

  it('closes the drawer when its department disappears', () => {
    const { rerender } = render(<DepartmentsView clientId={CLIENT} rows={rows} />);
    return userEvent.click(screen.getByRole('button', { name: 'Edit HR' })).then(() => {
      expect(screen.getByRole('dialog', { name: 'HR' })).toBeTruthy();
      rerender(<DepartmentsView clientId={CLIENT} rows={rows.slice(0, 2)} />);
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

describe('RemindersForm', () => {
  const reminders = {
    ownerDaysBefore: [7, 1],
    approverDaysAfter: [2],
    sendAtLocalTime: '09:00',
    consultantDigestWeekday: 1,
  };

  it('reads the settings back and saves them', async () => {
    actions.saveRemindersAction.mockResolvedValue(ok);
    render(<RemindersForm clientId={CLIENT} version={4} reminders={reminders} />);
    const summary = screen.getByRole('region', { name: 'With these settings' });
    expect(summary.textContent).toContain(
      'Owners are reminded 7 days and 1 day before the due date.',
    );
    expect(screen.getByRole('combobox', { name: "Consultants' weekly digest" }).textContent).toBe(
      'Monday',
    );
    const before = screen.getByLabelText('Remind owners this many days before the due date');
    await userEvent.clear(before);
    await userEvent.type(before, '3, 0');
    expect(summary.textContent).toContain(
      'Owners are reminded 3 days before the due date, and on the due date.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save reminders' }));
    expect(actions.saveRemindersAction).toHaveBeenCalledWith(CLIENT, {
      version: 4,
      reminders: { ...reminders, ownerDaysBefore: [3, 0] },
    });
    expect((await screen.findByText('Reminder settings saved.')).getAttribute('role')).toBe(
      'status',
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it('marks values it cannot save and holds the save', async () => {
    render(<RemindersForm clientId={CLIENT} version={4} reminders={reminders} />);
    const after = screen.getByLabelText(
      'Remind approvers this many days after a submission reaches them',
    );
    await userEvent.type(after, ', 120');
    expect(after.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByRole('region', { name: 'With these settings' })).toBeNull();
    const save = screen.getByRole('button', { name: /Save reminders/ });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(save);
    expect(actions.saveRemindersAction).not.toHaveBeenCalled();
  });

  it('shows a refused save', async () => {
    actions.saveRemindersAction.mockResolvedValue(no('Someone else changed this.'));
    render(<RemindersForm clientId={CLIENT} version={4} reminders={reminders} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save reminders' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Someone else changed this.');
  });

  it('keeps what was typed after a refused save', async () => {
    actions.saveRemindersAction.mockResolvedValue(
      no('You can no longer change this client’s setup.'),
    );
    const { rerender } = render(
      <RemindersForm clientId={CLIENT} version={4} reminders={reminders} />,
    );
    const before = screen.getByLabelText('Remind owners this many days before the due date');
    await userEvent.clear(before);
    await userEvent.type(before, '14');
    await userEvent.click(screen.getByRole('button', { name: 'Save reminders' }));
    await screen.findByRole('alert');
    // The refresh after the refusal brings the same version as a new object.
    rerender(<RemindersForm clientId={CLIENT} version={4} reminders={{ ...reminders }} />);
    expect((before as HTMLInputElement).value).toBe('14');
  });

  it('takes a new version from the server', () => {
    const { rerender } = render(
      <RemindersForm clientId={CLIENT} version={4} reminders={reminders} />,
    );
    rerender(
      <RemindersForm
        clientId={CLIENT}
        version={5}
        reminders={{ ...reminders, approverDaysAfter: [] }}
      />,
    );
    expect(
      (
        screen.getByLabelText(
          'Remind approvers this many days after a submission reaches them',
        ) as HTMLInputElement
      ).value,
    ).toBe('');
  });
});
