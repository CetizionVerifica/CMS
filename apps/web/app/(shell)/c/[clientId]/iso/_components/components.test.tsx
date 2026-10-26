import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IsoFileView } from '@canopy/contracts';
import { Toaster } from '@canopy/ui';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({
  path: '/c/c1/iso/documents',
  search: 'ids=a,b&type=POLICY',
  push: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, refresh: nav.refresh, replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _p,
    scroll: _s,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    prefetch?: boolean;
    scroll?: boolean;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const actions = vi.hoisted(() => ({ isoWrite: vi.fn(), isoRead: vi.fn() }));
vi.mock('../_lib/actions', () => actions);

const { BeingSetUp, IsoPill, IsoRefusal, StatePill, TimingPill } = await import('./IsoStates');
const { FormDrawer, PersonSelect, StepButton } = await import('./controls');
const { ClausePicker } = await import('./ClausePicker');
const { IsoFilterBar, withOpen, withParams } = await import('./IsoFilterBar');
const { IsoTable } = await import('./IsoTable');
const { FilesPanel } = await import('./FilesPanel');

const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (message: string) => ({ ok: false as const, code: 'FORBIDDEN' as const, message });

beforeEach(() => {
  actions.isoWrite.mockReset();
  actions.isoRead.mockReset();
  nav.push.mockReset();
  nav.refresh.mockReset();
});

describe('page states', () => {
  it('says the add-on is being set up', () => {
    render(<BeingSetUp title="Checklist" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Checklist' })).toBeTruthy();
    expect(screen.getByText('ISO management systems is being set up')).toBeTruthy();
    expect(screen.getByText('Try again in a few minutes.')).toBeTruthy();
  });

  it('words each refusal in the page’s place', () => {
    const { rerender } = render(<IsoRefusal refusal="notReady" title="Documents" homeHref="/h" />);
    expect(screen.getByText('ISO management systems is being set up')).toBeTruthy();
    rerender(<IsoRefusal refusal="notEnabled" title="Documents" homeHref="/h" />);
    expect(
      screen.getByText('ISO management systems is not turned on for your account'),
    ).toBeTruthy();
    rerender(<IsoRefusal refusal="noPermission" title="Documents" homeHref="/h" />);
    expect(screen.getByText('You don’t have access to documents')).toBeTruthy();
    rerender(<IsoRefusal refusal="notFound" title="Documents" homeHref="/h" />);
    expect(screen.getByText('We couldn’t find that page')).toBeTruthy();
  });

  it('words states as pills', () => {
    render(
      <>
        <StatePill of="ClauseNaState" value="REJECTED" />
        <StatePill of="DocumentType" value="SOP" />
        <TimingPill status={{ timing: 'OVERDUE', overdueDays: 3 }} />
        <TimingPill status={{ timing: 'ON_TIME', overdueDays: null }} />
        <IsoPill>Plain</IsoPill>
      </>,
    );
    expect(screen.getByText('Not applicable refused').className).toMatch(/crit/);
    expect(screen.getByText('Overdue 3 days').className).toMatch(/crit/);
    expect(screen.getByText('On time').className).toMatch(/neutral/);
    expect(screen.getByText('Plain')).toBeTruthy();
  });
});

describe('StepButton', () => {
  it('asks for a reason, runs the step and says it is done', async () => {
    const run = vi.fn(async () => ok(null));
    render(
      <>
        <StepButton
          label="Refuse"
          title="Refuse it?"
          reason={{ label: 'Why' }}
          done="Refused."
          run={run}
        />
        <Toaster />
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Refuse' }));
    const dialog = screen.getByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Why/ }), '  Not now  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Refuse' }));
    await waitFor(() => expect(run).toHaveBeenCalledWith('Not now'));
    expect(await screen.findByText('Refused.')).toBeTruthy();
    expect(nav.refresh).toHaveBeenCalled();
  });

  it('keeps the dialog open with the API’s words when the step fails', async () => {
    const run = vi.fn(async () => fail('You can’t do this here.'));
    render(
      <StepButton
        label="Approve"
        title="Approve it?"
        reason={{ label: 'Comment', optional: true }}
        done="Done."
        run={run}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' }),
    );
    expect(await screen.findByText('You can’t do this here.')).toBeTruthy();
    expect(run).toHaveBeenCalledWith(undefined);
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});

describe('PersonSelect and FormDrawer', () => {
  it('lists people by name, with an empty choice and someone no longer listed', async () => {
    const onChange = vi.fn();
    const people = [{ id: 'p1', name: 'Nisha Patil' }];
    const { rerender } = render(
      <PersonSelect
        label="Owner"
        people={people}
        value={null}
        onChange={onChange}
        none="Nobody yet"
      />,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Owner' }));
    await userEvent.click(screen.getByRole('option', { name: 'Nisha Patil' }));
    expect(onChange).toHaveBeenLastCalledWith('p1');
    rerender(
      <PersonSelect
        label="Owner"
        people={people}
        value="p1"
        onChange={onChange}
        none="Nobody yet"
      />,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Owner' }));
    await userEvent.click(screen.getByRole('option', { name: 'Nobody yet' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    rerender(<PersonSelect label="Owner" people={people} value="gone" onChange={onChange} />);
    expect(screen.getByRole('combobox', { name: 'Owner' }).textContent).toBe('Someone not listed');
  });

  it('submits only when nothing blocks it, and shows the error', async () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <FormDrawer
        open
        onOpenChange={onOpenChange}
        title="Add it"
        submitLabel="Save"
        pending={false}
        error="Taken"
        disabledReason="Name it"
        onSubmit={onSubmit}
      >
        <input aria-label="Name" />
      </FormDrawer>,
    );
    expect(screen.getByRole('alert').textContent).toBe('Taken');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).not.toHaveBeenCalled();
    rerender(
      <FormDrawer
        open
        onOpenChange={onOpenChange}
        title="Add it"
        submitLabel="Save"
        pending={false}
        error={null}
        onSubmit={onSubmit}
      >
        <input aria-label="Name" />
      </FormDrawer>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('ClausePicker', () => {
  it('adds a clause found by typing and removes it again', async () => {
    const onChange = vi.fn();
    const options = [
      { id: 'c1', label: 'ISO 9001 7.5 Documented information' },
      { id: 'c2', label: 'ISO 9001 8.7 Control of nonconforming outputs' },
    ];
    const { rerender } = render(
      <ClausePicker label="Clauses" options={options} value={[]} onChange={onChange} />,
    );
    await userEvent.type(screen.getByRole('combobox', { name: 'Clauses' }), '8.7');
    await userEvent.click(screen.getByRole('option', { name: /8\.7/ }));
    expect(onChange).toHaveBeenLastCalledWith(['c2']);
    rerender(
      <ClausePicker label="Clauses" options={options} value={['c2', 'gone']} onChange={onChange} />,
    );
    expect(screen.getByRole('list', { name: 'Clauses chosen' }).textContent).toContain(
      'A clause no longer listed',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove ISO 9001 8.7 Control of nonconforming outputs' }),
    );
    expect(onChange).toHaveBeenLastCalledWith(['gone']);
    rerender(
      <ClausePicker label="Clauses" options={options} value={['c1']} onChange={onChange} max={1} />,
    );
    expect(screen.getByText('Clauses: at most 1.')).toBeTruthy();
  });
});

describe('filters in the URL', () => {
  it('drops the overview’s ids on a filter change and keeps them when a record opens', () => {
    const params = new URLSearchParams('ids=a,b&type=POLICY');
    expect(withParams('/p', params, { type: ['POLICY', 'FORM'], q: undefined })).toBe(
      '/p?type=POLICY%2CFORM',
    );
    expect(withParams('/p', new URLSearchParams('ids=a'), { type: undefined })).toBe('/p');
    expect(withOpen('/p', params, 'row', 'r1')).toBe('/p?ids=a%2Cb&type=POLICY&row=r1');
    expect(withOpen('/p', new URLSearchParams('row=r1'), 'row')).toBe('/p');
  });

  it('pushes a filter or search change', async () => {
    render(
      <IsoFilterBar
        filters={[
          {
            key: 'type',
            label: 'Type',
            kind: 'multi',
            options: [{ value: 'FORM', label: 'Form' }],
          },
        ]}
        value={{ type: [] }}
        resultText="2 documents"
        resultCount={2}
        search={{ placeholder: 'Search code or title' }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Type/ }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /Form/ }));
    expect(nav.push).toHaveBeenCalledWith('/c/c1/iso/documents?type=FORM');
    nav.push.mockReset();
    await userEvent.type(screen.getByRole('searchbox'), 'oven');
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    expect(nav.push.mock.calls.at(-1)![0]).toMatch(/q=oven/);
  });

  it('renders a table whose rows link to their record', () => {
    render(
      <IsoTable
        label="Things"
        columns={[
          {
            id: 'name',
            header: 'Name',
            accessorFn: (r: { id: string; name: string }) => r.name as never,
            meta: { type: 'title' },
          },
        ]}
        data={[{ id: '1', name: 'First' }]}
        rowId={(r) => r.id}
        rowLabel={(r) => r.name}
        rowHref={(r) => `/x?row=${r.id}`}
      />,
    );
    expect(screen.getByRole('link', { name: 'First' }).getAttribute('href')).toBe('/x?row=1');
  });
});

const file = (over: Partial<IsoFileView> = {}): IsoFileView =>
  ({
    id: '00000000-0000-5000-8000-000000000f01',
    fileName: 'report.pdf',
    scanStatus: 'CLEAN',
    // 00:30 on 5 Nov in Kolkata, still 4 Nov in UTC.
    uploadedAt: '2024-11-04T19:00:00Z',
    ...over,
  }) as IsoFileView;

describe('FilesPanel', () => {
  const subject = { type: 'external_audit' as const, id: '00000000-0000-5000-8000-000000000a01' };

  it('lists files with their scan state, downloads a clean one and removes one with a reason', async () => {
    actions.isoRead.mockImplementation(async (_c: string, name: string) =>
      name === 'listIsoFiles'
        ? ok({ items: [file(), file({ id: 'f2', fileName: 'held.pdf', scanStatus: 'PENDING' })] })
        : ok({ url: 'https://storage.invalid/get' }),
    );
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    actions.isoWrite.mockResolvedValue(ok(null));
    render(
      <FilesPanel
        timeZone="Asia/Kolkata"
        clientId="c1"
        subject={subject}
        editable
        heading="Report"
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('Loading files…');
    expect(await screen.findByText('report.pdf')).toBeTruthy();
    expect(screen.getByText('Being checked')).toBeTruthy();
    expect(screen.getAllByText('5 Nov 2024')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Download held.pdf' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Download report.pdf' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://storage.invalid/get'));
    vi.unstubAllGlobals();

    await userEvent.click(screen.getByRole('button', { name: 'Remove report.pdf' }));
    const dialog = screen.getByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Wrong file');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        'c1',
        'removeIsoFile',
        { id: file().id },
        { reason: 'Wrong file' },
      ),
    );
    expect(nav.refresh).toHaveBeenCalled();
  });

  it('uploads a file through the ticket and confirm steps', async () => {
    actions.isoRead.mockResolvedValue(ok({ items: [] }));
    actions.isoWrite.mockImplementation(async (_c: string, name: string) =>
      name === 'isoFileUploadUrl'
        ? ok({ uploadId: 'u1', url: 'https://storage.invalid/put', headers: {}, expiresAt: 'x' })
        : ok(file()),
    );
    render(
      <FilesPanel
        timeZone="Asia/Kolkata"
        clientId="c1"
        subject={subject}
        editable
        helper="Attach the report."
      />,
    );
    expect(await screen.findByText('No files yet.')).toBeTruthy();
    expect(screen.getByText('Attach the report.')).toBeTruthy();
    await act(() =>
      userEvent.upload(
        screen.getByLabelText('Add a file'),
        new File(['x'], 'report.pdf', { type: 'application/pdf' }),
      ),
    );
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        'c1',
        'confirmIsoFile',
        {},
        expect.objectContaining({ uploadId: 'u1', fileName: 'report.pdf' }),
      ),
    );
    expect(nav.refresh).toHaveBeenCalled();
  });

  it('says what went wrong, and offers no changes on a locked record', async () => {
    actions.isoRead.mockResolvedValue(fail('You can’t do this here.'));
    render(<FilesPanel timeZone="Asia/Kolkata" clientId="c1" subject={subject} editable={false} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByLabelText('Add a file')).toBeNull();

    actions.isoRead.mockReset();
    actions.isoRead.mockImplementation(async (_c: string, name: string) =>
      name === 'listIsoFiles' ? ok({ items: [file()] }) : fail('Gone.'),
    );
    actions.isoWrite.mockResolvedValue(fail('Too big.'));
    render(
      <FilesPanel
        timeZone="Asia/Kolkata"
        clientId="c1"
        subject={subject}
        editable
        heading="Other"
      />,
    );
    const panel = await screen.findByRole('region', { name: 'Other' });
    await within(panel).findByText('report.pdf');
    await userEvent.click(within(panel).getByRole('button', { name: 'Download report.pdf' }));
    expect(await within(panel).findByText('Gone.')).toBeTruthy();
    await act(() =>
      userEvent.upload(within(panel).getByLabelText('Add a file'), new File(['x'], 'a.pdf')),
    );
    expect(await within(panel).findByText('Too big.')).toBeTruthy();
  });
});
