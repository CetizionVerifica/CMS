import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const entities = vi.hoisted(() => ({
  createCompanyAction: vi.fn(),
  renameCompanyAction: vi.fn(),
  archiveCompanyAction: vi.fn(),
  createUnitAction: vi.fn(),
  updateUnitAction: vi.fn(),
  archiveUnitAction: vi.fn(),
}));
const people = vi.hoisted(() => ({
  addPersonAction: vi.fn(),
  updatePersonAction: vi.fn(),
  mergePeopleAction: vi.fn(),
  rolesAction: vi.fn(),
}));
vi.mock('./entities/actions', () => entities);
vi.mock('./people/actions', () => people);
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const { EntitiesView } = await import('./entities/EntitiesView');
const { PeopleView } = await import('./people/PeopleView');

const CLIENT = '00000000-0000-5000-8000-000000000101';
const ok = { ok: true } as const;
const no = (message: string) => ({ ok: false, message }) as const;

const companies = [
  { id: 'c1', name: 'Kestrel Aluminium', version: 1, units: 1 },
  { id: 'c2', name: 'Kestrel Fibres', version: 3, units: 0 },
];
const units = [
  {
    id: 'u1',
    name: 'Riverbend Plant',
    version: 2,
    companyId: 'c1',
    company: 'Kestrel Aluminium',
    locationId: 'l1',
    location: 'Pune, Maharashtra, India',
  },
];
const locations = [
  { value: 'l1', label: 'Pune, Maharashtra, India' },
  { value: 'l2', label: 'Chennai, Tamil Nadu, India' },
];

beforeEach(() => {
  for (const fn of [...Object.values(entities), ...Object.values(people)]) fn.mockReset();
  router.refresh.mockReset();
});

const view = () =>
  render(
    <EntitiesView clientId={CLIENT} companies={companies} units={units} locations={locations} />,
  );

describe('EntitiesView: companies', () => {
  it('lists companies with their unit counts and holds archiving one with units', () => {
    view();
    const table = screen.getByRole('table', { name: 'Companies' });
    expect(within(table).getAllByRole('row')[1]!.textContent).toContain('1 unit');
    expect(
      screen
        .getByRole('button', { name: /Archive Kestrel Aluminium/ })
        .getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('adds a company and says so, or why not', async () => {
    entities.createCompanyAction.mockResolvedValueOnce(ok);
    view();
    await userEvent.type(screen.getByLabelText('New company name'), ' Osprey Textiles ');
    await userEvent.click(screen.getByRole('button', { name: 'Add company' }));
    expect(entities.createCompanyAction).toHaveBeenCalledWith(CLIENT, { name: 'Osprey Textiles' });
    expect(await screen.findByText('Osprey Textiles was added.')).toBeTruthy();
    expect((screen.getByLabelText('New company name') as HTMLInputElement).value).toBe('');

    entities.createCompanyAction.mockResolvedValueOnce(
      no('This client already has a company with that name.'),
    );
    await userEvent.type(screen.getByLabelText('New company name'), 'Kestrel Fibres');
    await userEvent.click(screen.getByRole('button', { name: 'Add company' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This client already has a company with that name.',
    );
    expect(screen.queryByText('Osprey Textiles was added.')).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it('renames a company in a dialog', async () => {
    entities.renameCompanyAction.mockResolvedValue(ok);
    view();
    await userEvent.click(screen.getByRole('button', { name: 'Rename Kestrel Fibres' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Rename Kestrel Fibres?' });
    const input = within(dialog).getByLabelText(/New name/);
    expect((input as HTMLInputElement).value).toBe('Kestrel Fibres');
    await userEvent.clear(input);
    await userEvent.type(input, 'Kestrel Yarns');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(entities.renameCompanyAction).toHaveBeenCalledWith(CLIENT, 'c2', {
      version: 3,
      name: 'Kestrel Yarns',
    });
    expect(await screen.findByText('Kestrel Fibres is now Kestrel Yarns.')).toBeTruthy();
  });

  it('archives an empty company with a reason', async () => {
    entities.archiveCompanyAction.mockResolvedValue(ok);
    view();
    await userEvent.click(screen.getByRole('button', { name: 'Archive Kestrel Fibres' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Archive Kestrel Fibres?' });
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Merged into the group');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(entities.archiveCompanyAction).toHaveBeenCalledWith(CLIENT, 'c2', {
      version: 3,
      reason: 'Merged into the group',
    });
    expect(await screen.findByText('Kestrel Fibres was archived.')).toBeTruthy();
  });

  it('says what to do with no companies or units', () => {
    render(<EntitiesView clientId={CLIENT} companies={[]} units={[]} locations={locations} />);
    expect(screen.getByText(/No companies yet/)).toBeTruthy();
    expect(screen.getByText('No units yet.')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Company' })).toBeNull();
    expect(screen.getByRole('button', { name: /Add unit/ }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });
});

describe('EntitiesView: units', () => {
  it('adds a unit under a company at a location', async () => {
    entities.createUnitAction.mockResolvedValue(ok);
    view();
    const add = screen.getByRole('button', { name: /Add unit/ });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    const location = screen.getByRole('combobox', { name: 'Location' });
    await userEvent.type(location, 'Chen');
    await userEvent.click(screen.getByRole('option', { name: 'Chennai, Tamil Nadu, India' }));
    await userEvent.type(screen.getByLabelText('Unit name'), 'Stonebridge Office');
    await userEvent.click(screen.getByRole('button', { name: 'Add unit' }));
    expect(entities.createUnitAction).toHaveBeenCalledWith(CLIENT, {
      companyId: 'c1',
      locationId: 'l2',
      name: 'Stonebridge Office',
    });
    expect(await screen.findByText('Stonebridge Office was added.')).toBeTruthy();
  });

  it('changes a unit in a drawer and archives one', async () => {
    entities.updateUnitAction.mockResolvedValueOnce(no('Someone else changed this.'));
    entities.updateUnitAction.mockResolvedValueOnce(ok);
    entities.archiveUnitAction.mockResolvedValue(ok);
    view();
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit Riverbend Plant, Kestrel Aluminium' }),
    );
    const drawer = screen.getByRole('dialog', { name: 'Riverbend Plant' });
    const save = within(drawer).getByRole('button', { name: /Save changes/ });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    const name = within(drawer).getByLabelText('Unit name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Riverbend Works');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save changes' }));
    expect((await within(drawer).findByRole('alert')).textContent).toBe(
      'Someone else changed this.',
    );
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save changes' }));
    expect(entities.updateUnitAction).toHaveBeenLastCalledWith(CLIENT, 'u1', {
      version: 2,
      name: 'Riverbend Works',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Riverbend Works was saved.')).toBeTruthy();

    await userEvent.click(
      screen.getByRole('button', { name: 'Archive Riverbend Plant, Kestrel Aluminium' }),
    );
    const dialog = screen.getByRole('alertdialog', { name: 'Archive Riverbend Plant?' });
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Closed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(entities.archiveUnitAction).toHaveBeenCalledWith(CLIENT, 'u1', {
      version: 2,
      reason: 'Closed',
    });
  });
});

const rows = [
  {
    id: 'p1',
    name: 'Asha Kulkarni',
    email: 'asha@kestrel.example',
    status: 'Active',
    version: 2,
    emailRequired: true,
  },
  {
    id: 'p2',
    name: 'Asha K',
    email: null,
    status: 'Not invited',
    version: 1,
    emailRequired: false,
  },
  {
    id: 'p3',
    name: 'Ravi Nair',
    email: null,
    status: 'Not invited',
    version: 1,
    emailRequired: false,
  },
];

describe('PeopleView', () => {
  it('lists people with email and status', () => {
    render(<PeopleView clientId={CLIENT} rows={rows} />);
    const [, asha, k] = within(screen.getByRole('table', { name: 'People' })).getAllByRole('row');
    expect(asha!.textContent).toContain('asha@kestrel.example');
    expect(k!.textContent).toContain('—');
    expect(k!.textContent).toContain('Not invited');
  });

  it('says what to do when there is nobody', () => {
    render(<PeopleView clientId={CLIENT} rows={[]} />);
    expect(screen.getByText(/No people yet/)).toBeTruthy();
  });

  it('adds a person with a role, with or without an email', async () => {
    people.addPersonAction.mockResolvedValue({ ok: true, value: undefined });
    render(<PeopleView clientId={CLIENT} rows={rows} />);
    await userEvent.type(screen.getByLabelText('Name'), 'Meera Rao');
    const email = screen.getByLabelText('Email (optional)');
    await userEvent.type(email, 'meera@');
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('button', { name: /Add person/ }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    await userEvent.type(email, 'kestrel.example');
    await userEvent.click(screen.getByRole('combobox', { name: 'Role' }));
    await userEvent.click(screen.getByRole('option', { name: 'Approver' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
    expect(people.addPersonAction).toHaveBeenCalledWith(CLIENT, {
      displayName: 'Meera Rao',
      email: 'meera@kestrel.example',
      role: 'APPROVER',
    });
    expect(await screen.findByText('Meera Rao was added as invited.')).toBeTruthy();

    await userEvent.type(screen.getByLabelText('Name'), 'Ravi N');
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
    expect(
      await screen.findByText('Ravi N was added. Add an email when they need to sign in.'),
    ).toBeTruthy();
  });

  it('shows a refused add', async () => {
    people.addPersonAction.mockResolvedValue(no('Someone in your firm already has this email.'));
    render(<PeopleView clientId={CLIENT} rows={rows} />);
    await userEvent.type(screen.getByLabelText('Name'), 'Asha');
    await userEvent.type(screen.getByLabelText('Email (optional)'), 'asha@kestrel.example');
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Someone in your firm already has this email.',
    );
  });

  it('edits a person, shows their roles, and keeps an active person’s email', async () => {
    people.rolesAction.mockResolvedValue({ ok: true, value: ['Owner · all units'] });
    people.updatePersonAction.mockResolvedValue({ ok: true, value: undefined });
    render(<PeopleView clientId={CLIENT} rows={rows} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit Asha Kulkarni' }));
    const drawer = screen.getByRole('dialog', { name: 'Asha Kulkarni' });
    expect(await within(drawer).findByText('Owner · all units')).toBeTruthy();
    const email = within(drawer).getByLabelText('Email');
    await userEvent.clear(email);
    expect(
      within(drawer)
        .getByRole('button', { name: /Save changes/ })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    await userEvent.type(email, 'asha.k@kestrel.example');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save changes' }));
    expect(people.updatePersonAction).toHaveBeenCalledWith(CLIENT, 'p1', {
      version: 2,
      email: 'asha.k@kestrel.example',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows a refused save and no roles when they cannot be read', async () => {
    people.rolesAction.mockResolvedValue(no('x'));
    people.updatePersonAction.mockResolvedValue(no('Someone else changed this.'));
    render(<PeopleView clientId={CLIENT} rows={rows} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit Ravi Nair' }));
    const drawer = screen.getByRole('dialog', { name: 'Ravi Nair' });
    expect(await within(drawer).findByText('No roles here.')).toBeTruthy();
    await userEvent.type(within(drawer).getByLabelText('Name'), ' Iyer');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save changes' }));
    expect((await within(drawer).findByRole('alert')).textContent).toBe(
      'Someone else changed this.',
    );
    expect(people.updatePersonAction.mock.calls[0]![2]).toEqual({
      version: 1,
      displayName: 'Ravi Nair Iyer',
    });
  });

  it('merges a duplicate after a confirmation', async () => {
    people.rolesAction.mockResolvedValue({ ok: true, value: [] });
    people.mergePeopleAction.mockResolvedValue({ ok: true, value: undefined });
    render(<PeopleView clientId={CLIENT} rows={rows} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit Asha Kulkarni' }));
    const drawer = screen.getByRole('dialog', { name: 'Asha Kulkarni' });
    const group = within(drawer).getByRole('group', {
      name: 'Merge duplicates into Asha Kulkarni',
    });
    await userEvent.click(within(group).getByRole('checkbox', { name: 'Asha K' }));
    await userEvent.click(within(group).getByRole('button', { name: 'Merge person' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Merge Asha K into Asha Kulkarni?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Merge' }));
    expect(people.mergePeopleAction).toHaveBeenCalledWith(CLIENT, 'p1', {
      version: 2,
      sourceIds: ['p2'],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
