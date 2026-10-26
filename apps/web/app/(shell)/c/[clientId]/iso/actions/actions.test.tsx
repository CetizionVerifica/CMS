import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IsoActionView } from '@canopy/contracts';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ISO } from '../_test/fixture';
import { actionFilterDefs, actionSubjects } from './actions-model';

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/c/c1/iso/actions',
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

const { ActionsView } = await import('./ActionsView');
const { ActionsPanel } = await import('../_components/ActionsPanel');

const C = 'c1';
const PATH = `/c/${C}/iso/actions`;
const ok = <T,>(data: T) => ({ ok: true as const, data });
const person = (name: string) => ISO.people.find((p) => p.name === name)!.id;
const ROHAN = person('Rohan Joshi');
const SAMEER = person('Sameer Gowda');
const HAZARD = ISO.risks.find((r) => r.activity === 'Changing oven trays on line 2')!;
const onHazard = ISO.actions.filter((a) => a.subject.id === HAZARD.id);
const TRAYS = onHazard.find((a) => a.state === 'OPEN')!;
const action = (over: Partial<IsoActionView>): IsoActionView => ({ ...TRAYS, ...over });
const subjects = actionSubjects(C, ISO.actions, ISO.risks, ISO.objectives);

beforeEach(() => {
  actions.isoWrite.mockReset();
  actions.isoWrite.mockResolvedValue(ok({ id: 'new-action' }));
  nav.push.mockReset();
  nav.refresh.mockReset();
  nav.search = 'state=OPEN';
});

function view(openActionId: string | null, list = ISO.actions) {
  return render(
    <ActionsView
      clientId={C}
      actions={list}
      subjects={subjects}
      people={ISO.people}
      filters={actionFilterDefs()}
      filterValue={{ state: ['OPEN'] }}
      openActionId={openActionId}
      editing={{ all: false, personId: ROHAN }}
      today="2024-11-15"
    />,
  );
}

describe('ActionsView', () => {
  it('lists every action by what it is for, opening each over the list', () => {
    view(null);
    const table = screen.getByRole('table', { name: 'Actions' });
    const link = within(table).getByRole('link', { name: TRAYS.text });
    expect(link.getAttribute('href')).toBe(`${PATH}?state=OPEN&action=${TRAYS.id}`);
    expect(within(table).getAllByText(/^Objective plan · Objective: /).length).toBeGreaterThan(0);
    expect(
      within(table).getAllByText(/^Corrective action · Corrective action$/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("opens an action with its subject's link, and closes back to the list", async () => {
    view(TRAYS.id, [action({ allowedActions: ['COMPLETE', 'CANCEL'] })]);
    const drawer = screen.getByRole('dialog', { name: 'Treatment action' });
    expect(
      within(drawer).getByRole('link', { name: subjects[HAZARD.id]!.label }).getAttribute('href'),
    ).toBe(`/c/${C}/iso/risks/${HAZARD.id}`);
    expect(within(drawer).getByRole('button', { name: 'Mark done' })).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Cancel action' })).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: 'Reopen' })).toBeNull();
    // Its owner edits it, but cannot hand it to someone else.
    await userEvent.click(within(drawer).getByRole('button', { name: 'Edit action' }));
    const form = screen.getByRole('dialog', { name: 'Edit treatment action' });
    expect(within(form).queryByRole('combobox', { name: 'Owner' })).toBeNull();
    await userEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(nav.push).toHaveBeenCalledWith(`${PATH}?state=OPEN`, { scroll: false });
  });

  it('offers someone else’s action no edit', () => {
    view(TRAYS.id, [action({ ownerId: SAMEER })]);
    expect(screen.queryByRole('button', { name: 'Edit action' })).toBeNull();
  });
});

function panel(over: Partial<Parameters<typeof ActionsPanel>[0]> = {}) {
  return render(
    <ActionsPanel
      clientId={C}
      subject={{ type: 'RISK_ITEM', id: HAZARD.id }}
      subjectOpen
      actions={onHazard}
      people={ISO.people}
      canAdd
      editing={{ all: true, personId: ROHAN }}
      hierarchy="required"
      completeNote="Its control goes in place on this item."
      today="2024-11-15"
      {...over}
    />,
  );
}

describe('ActionsPanel', () => {
  it('adds a treatment action to a hazard only with its kind of control', async () => {
    panel();
    await userEvent.click(screen.getByRole('button', { name: 'Add treatment action' }));
    const form = screen.getByRole('dialog', { name: 'Add treatment action' });
    await userEvent.type(
      within(form).getByRole('textbox', { name: 'What is to be done' }),
      'Fit a tray lifter',
    );
    await userEvent.click(within(form).getByRole('combobox', { name: 'Owner' }));
    await userEvent.click(screen.getByRole('option', { name: 'Rohan Joshi' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Due on' }), '15 Jan 2025');
    await userEvent.tab();
    await userEvent.click(within(form).getByRole('button', { name: 'Add treatment action' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await userEvent.click(within(form).getByRole('combobox', { name: 'Kind of control' }));
    await userEvent.click(screen.getByRole('option', { name: 'Engineering' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Add treatment action' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'createIsoAction',
        {},
        {
          subject: { type: 'RISK_ITEM', id: HAZARD.id },
          text: 'Fit a tray lifter',
          resources: null,
          ownerId: ROHAN,
          dueOn: '2025-01-15',
          controlHierarchy: 'ENGINEERING',
        },
      ),
    );
  });

  it('adds an objective plan without a control, owned by the person adding it', async () => {
    panel({
      subject: { type: 'OBJECTIVE', id: 'o1' },
      actions: [],
      hierarchy: undefined,
      editing: { all: false, personId: ROHAN },
    });
    expect(screen.getByText('No objective plans yet.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add objective plan' }));
    const form = screen.getByRole('dialog', { name: 'Add objective plan' });
    expect(within(form).queryByRole('combobox', { name: 'Kind of control' })).toBeNull();
    expect(within(form).getByText('you')).toBeTruthy();
    await userEvent.type(
      within(form).getByRole('textbox', { name: 'What is to be done' }),
      'Solar',
    );
    await userEvent.type(within(form).getByRole('textbox', { name: 'Due on' }), '15 Jan 2025');
    await userEvent.tab();
    await userEvent.click(within(form).getByRole('button', { name: 'Add objective plan' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'createIsoAction',
        {},
        expect.objectContaining({ ownerId: ROHAN, controlHierarchy: null }),
      ),
    );
  });

  it('marks an action done, saying what that does', async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    panel({ actions: [action({ allowedActions: ['COMPLETE'] })] });
    await userEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    const form = screen.getByRole('dialog', { name: 'Mark the action done' });
    expect(within(form).getByText('Its control goes in place on this item.')).toBeTruthy();
    await userEvent.type(
      within(form).getByRole('textbox', { name: 'How well it worked (optional)' }),
      'No burns since',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Mark done' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'completeIsoAction',
        { id: TRAYS.id },
        { version: TRAYS.version, doneOn: '2024-11-15', effectivenessNote: 'No burns since' },
      ),
    );
  });

  it('cancels and reopens with a reason', async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    panel({
      actions: [
        action({ allowedActions: ['CANCEL'] }),
        action({
          id: 'done-1',
          text: 'Old plan',
          state: 'CANCELLED',
          cancelReason: 'Superseded',
          allowedActions: ['REOPEN'],
        }),
      ],
    });
    expect(screen.getByText('Superseded')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel action' }));
    let dialog = screen.getByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Line 2 closes');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel action' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'cancelIsoAction',
        { id: TRAYS.id },
        { version: TRAYS.version, reason: 'Line 2 closes' },
      ),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    dialog = screen.getByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Line 2 stays');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reopen' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'reopenIsoAction',
        { id: 'done-1' },
        { version: TRAYS.version, reason: 'Line 2 stays' },
      ),
    );
  });

  it('asks why when an edit hands the action to someone else', async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    panel({ actions: [TRAYS] });
    await userEvent.click(screen.getByRole('button', { name: 'Edit action' }));
    const form = screen.getByRole('dialog', { name: 'Edit treatment action' });
    await userEvent.click(within(form).getByRole('button', { name: 'Save action' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await userEvent.click(within(form).getByRole('combobox', { name: 'Owner' }));
    await userEvent.click(screen.getByRole('option', { name: 'Sameer Gowda' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Save action' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await userEvent.type(
      within(form).getByRole('textbox', { name: 'Why the owner or due date changes' }),
      'Sameer runs line 2 now',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save action' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoAction',
        { id: TRAYS.id },
        { version: TRAYS.version, ownerId: SAMEER, reason: 'Sameer runs line 2 now' },
      ),
    );
  });

  it('takes no new action on a closed subject', () => {
    panel({ subjectOpen: false });
    expect(screen.queryByRole('button', { name: 'Add treatment action' })).toBeNull();
  });
});
