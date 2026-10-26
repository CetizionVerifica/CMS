import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ClauseAssessmentView } from '@canopy/contracts';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ISO } from '../_test/fixture';
import { checklistRows, filterDefs } from './checklist-model';

const nav = vi.hoisted(() => ({ search: '', push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/c/c1/iso/checklist',
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

const { ChecklistView } = await import('./ChecklistView');

const SYS = ISO.system.id;
const ME = '00000000-0000-5000-8000-0000000000aa';
const ok = <T,>(data: T) => ({ ok: true as const, data });
const base = ISO.checklist.find((r) => r.clauseNumber === '7.1.5.2')!;
const row = (over: Partial<ClauseAssessmentView> = {}): ClauseAssessmentView => ({
  ...base,
  ...over,
});

function view(
  rows: ClauseAssessmentView[],
  openRowId: string | null,
  opts: { all?: boolean; reassign?: boolean } = {},
) {
  return render(
    <ChecklistView
      clientId="c1"
      systemId={SYS}
      rows={checklistRows(rows, ISO.standards, ISO.people, ISO.system.standardIds)}
      people={ISO.people}
      filters={filterDefs(ISO.standards, ISO.system.standardIds)}
      filterValue={{ standardId: [], status: [], naState: [], ownerId: [] }}
      openRowId={openRowId}
      editable={{ all: opts.all ?? true, personId: ME }}
      canReassign={opts.reassign ?? true}
      today="2024-11-15"
      timeZone="Asia/Kolkata"
    />,
  );
}

beforeEach(() => {
  actions.isoWrite.mockReset();
  actions.isoWrite.mockResolvedValue(ok({}));
  actions.isoRead.mockReset();
  actions.isoRead.mockResolvedValue(ok({ items: [] }));
  nav.push.mockReset();
  nav.search = '';
});

describe('ChecklistView', () => {
  it('lists clauses with status, N/A state and owner; a row opens its drawer in the URL', () => {
    nav.search = 'status=PARTIAL';
    view(ISO.checklist.slice(0, 5), null);
    expect(screen.getByRole('table', { name: 'Checklist' })).toBeTruthy();
    const link = screen.getAllByRole('link')[0]!;
    expect(link.getAttribute('href')).toBe(
      `/c/c1/iso/checklist?status=PARTIAL&row=${ISO.checklist[0]!.id}`,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says when no clause matches', () => {
    view([], null);
    expect(
      screen.getByText('No clause matches these filters. Clear a filter to see more.'),
    ).toBeTruthy();
  });

  it('requests N/A with a justification, only where the row allows it', async () => {
    view([row({ allowedActions: ['REQUEST_NA'] })], base.id);
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText(/may be excluded with a justification/)).toBeTruthy();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Request not applicable' }));
    const confirm = screen.getByRole('alertdialog');
    await userEvent.type(within(confirm).getByRole('textbox'), 'No measuring equipment.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Request not applicable' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        'c1',
        'requestIsoClauseNa',
        { id: SYS, rowId: base.id },
        {
          version: base.version,
          reason: 'No measuring equipment.',
        },
      ),
    );
  });

  it('offers the approver both decisions, with an optional comment to approve', async () => {
    const requested = row({
      status: 'NOT_APPLICABLE',
      naState: 'REQUESTED',
      justification: 'No equipment.',
      statusBeforeNa: 'PARTIAL',
      naRequestedById: ME,
      allowedActions: ['APPROVE_NA', 'REJECT_NA'],
    });
    view([requested], base.id, { all: false, reassign: false });
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText('Justification: No equipment.')).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: 'Save clause' })).toBeNull();
    expect(
      within(drawer).getByText('No notes yet.') ?? within(drawer).getByText(base.notes!),
    ).toBeTruthy();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Approve not applicable' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Approve not applicable',
      }),
    );
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        'c1',
        'approveIsoClauseNa',
        { id: SYS, rowId: base.id },
        {
          version: base.version,
        },
      ),
    );
    await userEvent.click(within(drawer).getByRole('button', { name: 'Refuse' }));
    const confirm = screen.getByRole('alertdialog');
    await userEvent.type(within(confirm).getByRole('textbox'), 'It applies.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Refuse' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenLastCalledWith(
        'c1',
        'rejectIsoClauseNa',
        { id: SYS, rowId: base.id },
        {
          version: base.version,
          reason: 'It applies.',
        },
      ),
    );
  });

  it('withdraws an approved N/A, and keeps the status locked meanwhile', async () => {
    view(
      [
        row({
          status: 'NOT_APPLICABLE',
          naState: 'APPROVED',
          justification: 'No equipment.',
          statusBeforeNa: 'PARTIAL',
          naRequestedById: ME,
          naDecidedById: ISO.people[0]!.id,
          naDecidedAt: '2024-11-10T05:00:00Z',
          allowedActions: ['WITHDRAW_NA'],
        }),
      ],
      base.id,
    );
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText(/status stays Not applicable/)).toBeTruthy();
    expect(within(drawer).queryByRole('combobox', { name: 'Status' })).toBeNull();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Withdraw not applicable' }));
    const confirm = screen.getByRole('alertdialog');
    await userEvent.type(within(confirm).getByRole('textbox'), 'Design work starts.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Withdraw not applicable' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        'c1',
        'withdrawIsoClauseNa',
        { id: SYS, rowId: base.id },
        {
          version: base.version,
          reason: 'Design work starts.',
        },
      ),
    );
  });

  it('saves status, notes and a new owner, which needs a reason', async () => {
    view(
      [row({ allowedActions: [], exclusionAllowed: false, notes: null, status: 'NOT_STARTED' })],
      base.id,
    );
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText(/does not allow it to be excluded/)).toBeTruthy();
    expect(
      within(drawer).getByRole('button', { name: 'Save clause' }).getAttribute('aria-disabled'),
    ).toBe('true');
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Status' }));
    expect(screen.queryByRole('option', { name: 'Not applicable' })).toBeNull();
    await userEvent.click(screen.getByRole('option', { name: 'Implemented' }));
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Notes' }),
      'Calibration log.',
    );
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Owner' }));
    await userEvent.click(screen.getByRole('option', { name: 'Nisha Patil' }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save clause' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Why the owner changes' }),
      'Moved teams',
    );
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save clause' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        'c1',
        'updateIsoChecklistRow',
        { id: SYS, rowId: base.id },
        {
          version: base.version,
          status: 'IMPLEMENTED',
          ownerId: ISO.people.find((p) => p.name === 'Nisha Patil')!.id,
          reason: 'Moved teams',
          notes: 'Calibration log.',
        },
      ),
    );
  });

  it('lets an owner edit only rows they own, and moves between rows', async () => {
    const mine = row({ ownerId: ME, allowedActions: [] });
    const theirs = {
      ...ISO.checklist.find((r) => r.clauseNumber === '7.1.5.1')!,
      allowedActions: [],
    };
    view([theirs, mine], mine.id, { all: false, reassign: false });
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByRole('button', { name: 'Save clause' })).toBeTruthy();
    expect(within(drawer).queryByRole('combobox', { name: 'Owner' })).toBeNull();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Previous clause' }));
    expect(nav.push).toHaveBeenCalledWith(`/c/c1/iso/checklist?row=${theirs.id}`, {
      scroll: false,
    });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(nav.push).toHaveBeenLastCalledWith('/c/c1/iso/checklist', { scroll: false });
  });
});
