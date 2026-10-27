import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NcAction, NonconformityView } from '@canopy/contracts';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ISO } from '../_test/fixture';
import { ncExportQuery, ncFilterDefs, ncFilters, ncRows, ncSystems } from './nc-model';

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/c/c1/iso/nonconformities',
  useSearchParams: () => new URLSearchParams(),
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
const exports = vi.hoisted(() => ({ startIsoExport: vi.fn(), isoExportProgress: vi.fn() }));
vi.mock('../_lib/export', () => exports);

const { NcLogView } = await import('./NcLogView');
const { NcRecord } = await import('./[ncId]/NcRecord');

const C = 'c1';
const PATH = `/c/${C}/iso/nonconformities`;
const ok = <T,>(data: T) => ({ ok: true as const, data });
const person = (name: string) => ISO.people.find((p) => p.name === name)!.id;
const ROHAN = person('Rohan Joshi');
const NISHA = person('Nisha Patil');
const SAMEER = person('Sameer Gowda');
const byNumber = (n: number) => ISO.ncs.find((x) => x.number === n)!;
const COMPLAINT = byNumber(7);
const INJURY = byNumber(2);
const FROM_AUDIT = byNumber(3);
const units = ISO.units.map((u) => ({ id: u.id, name: u.name }));
const [SYSTEM] = ncSystems([ISO.system], ISO.standards, ISO.clauses, ISO.risks);
const raise = {
  clientId: C,
  systems: [SYSTEM!],
  units,
  people: ISO.people,
  today: '2024-11-15',
  timeZone: 'Asia/Kolkata',
};

// Keys go in without a timer between them: typing stays in one act, quick and in order on a loaded runner.
let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  user = userEvent.setup({ delay: null });
  actions.isoWrite.mockReset();
  actions.isoWrite.mockResolvedValue(ok({ id: 'new-nc' }));
  actions.isoRead.mockReset();
  actions.isoRead.mockResolvedValue(ok({ items: [], nextCursor: null }));
  exports.startIsoExport.mockReset();
  exports.isoExportProgress.mockReset();
  nav.push.mockReset();
  nav.refresh.mockReset();
});

function log(search: Record<string, string> = {}, mayRaise = false) {
  const f = ncFilters(search, [ISO.system.id]);
  return render(
    <NcLogView
      clientId={C}
      rows={ncRows(ISO.ncs, ISO.units, ISO.people)}
      filters={ncFilterDefs()}
      filterValue={{}}
      fromOverview={f.ids.length > 0}
      clearHref={PATH}
      exportFilters={new URLSearchParams(ncExportQuery(f)).toString()}
      raise={mayRaise ? raise : null}
    />,
  );
}

describe('NcLogView', () => {
  it('lists every record the API sent, each linking to its page', () => {
    log({ ids: ISO.ncs.map((n) => n.id).join(','), state: 'OPEN' });
    const table = screen.getByRole('table', { name: 'Nonconformity log' });
    const rows = within(table).getAllByRole('link');
    expect(rows).toHaveLength(ISO.ncs.length);
    expect(
      within(table)
        .getByRole('link', { name: /^One batch of butter cookies/ })
        .getAttribute('href'),
    ).toBe(`${PATH}/${COMPLAINT.id}`);
    expect(screen.getByRole('link', { name: 'Show the whole log' }).getAttribute('href')).toBe(
      PATH,
    );
    expect(screen.queryByRole('button', { name: 'Raise a nonconformity' })).toBeNull();
  });

  it('downloads the log with its filters, without the overview’s ids, and says so', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    exports.startIsoExport.mockResolvedValue({ ok: true, id: 'exp-1' });
    exports.isoExportProgress.mockResolvedValue({ status: 'ready', url: 'https://x.invalid/l' });
    log({ ids: 'a,b', state: 'OPEN', overdue: 'true' });
    expect(screen.getByText(/without the overview’s selection/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Download NC log (Excel)' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://x.invalid/l'));
    expect(exports.startIsoExport).toHaveBeenCalledWith(
      C,
      'ISO_NC_LOG_XLSX',
      'state=OPEN&overdue=true',
    );
    vi.unstubAllGlobals();
  });

  it('raises a nonconformity from a register activity and opens it', async () => {
    actions.isoRead.mockResolvedValue(
      ok({
        items: [
          { id: 'inst-1', title: 'Emergency drill', unitName: 'Line 2', dueDate: '2024-11-01' },
        ],
        nextCursor: null,
      }),
    );
    log({}, true);
    await user.click(screen.getByRole('button', { name: 'Raise a nonconformity' }));
    const form = screen.getByRole('dialog', { name: 'Raise a nonconformity' });
    const pick = async (label: string, option: string) => {
      await user.click(within(form).getByRole('combobox', { name: label }));
      await user.click(screen.getByRole('option', { name: option }));
    };
    await pick('Where it came from', 'Process');
    await user.click(within(form).getByRole('radio', { name: 'Minor' }));
    await user.click(within(form).getByRole('checkbox', { name: SYSTEM!.standards[0]!.title }));
    await user.type(
      within(form).getByRole('textbox', { name: 'What happened or was found' }),
      'The drill took too long.',
    );
    const search = within(form).getByRole('textbox', { name: 'Search the register' });
    await user.type(search, 'd');
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    expect(within(form).getByText('Type at least two letters.')).toBeTruthy();
    await user.type(search, 'rill{Enter}');
    expect(actions.isoRead).toHaveBeenCalledWith(
      C,
      'listInstances',
      {},
      { q: 'drill', limit: '10' },
    );
    await user.click(within(form).getByRole('radio', { name: /^Emergency drill · Line 2/ }));
    expect(within(form).getByText('Emergency drill · Line 2 · due 1 Nov 2024')).toBeTruthy();
    await pick('Owner', 'Rohan Joshi');
    await pick('Approver', 'Rohan Joshi');
    await user.type(within(form).getByRole('textbox', { name: 'Due on' }), '15 Dec 2024');
    await user.tab();
    await user.click(within(form).getByRole('button', { name: 'Raise' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await pick('Approver', 'Nisha Patil');
    await user.click(within(form).getByRole('button', { name: 'Raise' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'raiseIsoNonconformity',
        {},
        {
          managementSystemId: ISO.system.id,
          source: 'PROCESS',
          sourceInstanceId: 'inst-1',
          raisedFromRiskItemId: null,
          severity: 'MINOR',
          standards: [SYSTEM!.standards[0]!.code],
          clauseIds: [],
          unitId: SYSTEM!.unitIds.length === 1 ? SYSTEM!.unitIds[0] : null,
          description: 'The drill took too long.',
          containment: null,
          correction: null,
          ownerId: ROHAN,
          approverId: NISHA,
          dueOn: '2024-12-15',
          incident: null,
        },
      ),
    );
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`${PATH}/new-nc`));
  });

  it('raises an incident with its time where the client is, its unit and its outcome', async () => {
    log({}, true);
    await user.click(screen.getByRole('button', { name: 'Raise a nonconformity' }));
    const form = screen.getByRole('dialog', { name: 'Raise a nonconformity' });
    const pick = async (label: string, option: string) => {
      await user.click(within(form).getByRole('combobox', { name: label }));
      await user.click(screen.getByRole('option', { name: option }));
    };
    await pick('Where it came from', 'Incident');
    await user.click(within(form).getByRole('checkbox', { name: SYSTEM!.standards[0]!.title }));
    expect(within(form).getAllByText(/Write no injured person’s name/).length).toBeGreaterThan(0);
    await user.click(within(form).getByRole('radio', { name: 'Major' }));
    await user.type(
      within(form).getByRole('textbox', { name: 'What happened or was found' }),
      'A hand was burnt on a tray.',
    );
    await pick('Unit', units[0]!.name);
    await user.type(within(form).getByRole('textbox', { name: 'Date it happened' }), '14 Nov 2024');
    await user.tab();
    await user.type(within(form).getByRole('textbox', { name: 'Time (HH:MM)' }), '09:30');
    await user.type(within(form).getByRole('textbox', { name: 'Where it happened' }), 'Oven bay');
    await pick('Kind of incident', 'Injury');
    await pick('Outcome', 'Lost time');
    await user.click(within(form).getByRole('checkbox', { name: 'Reportable to the authorities' }));
    expect(within(form).getByText(/A statutory accident notice is due/)).toBeTruthy();
    await pick('Owner', 'Rohan Joshi');
    await pick('Approver', 'Nisha Patil');
    await user.type(within(form).getByRole('textbox', { name: 'Due on' }), '15 Dec 2024');
    await user.tab();
    expect(
      within(form).getByRole('button', { name: 'Raise' }).getAttribute('aria-disabled') ??
        within(form).getByRole('button', { name: 'Raise' }).hasAttribute('disabled'),
    ).toBeTruthy();
    await user.type(within(form).getByRole('textbox', { name: 'Days lost' }), '2');
    await user.click(within(form).getByRole('button', { name: 'Raise' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'raiseIsoNonconformity',
        {},
        expect.objectContaining({
          source: 'INCIDENT',
          severity: 'MAJOR',
          unitId: units[0]!.id,
          incident: {
            occurredAt: '2024-11-14T04:00:00Z',
            location: 'Oven bay',
            type: 'INJURY',
            outcome: 'LOST_TIME',
            personCategory: null,
            lostDays: 2,
            reportable: true,
            statutoryInstanceId: null,
          },
        }),
      ),
    );
  });
});

function record(nc: NonconformityView, over: Partial<Parameters<typeof NcRecord>[0]> = {}) {
  return render(
    <NcRecord
      clientId={C}
      nc={nc}
      actions={ISO.actions.filter((a) => a.subject.id === nc.id)}
      people={ISO.people}
      units={units}
      unitName="Line 2"
      systemName={ISO.system.name}
      system={SYSTEM!}
      standards={ISO.standards}
      risks={ISO.risks.map((r) => ({ id: r.id, label: r.activity, href: `/r/${r.id}` }))}
      liveRiskIds={ISO.risks.map((r) => r.id)}
      documents={ISO.docs.map((d) => ({ id: d.id, label: d.title, href: `/d/${d.id}` }))}
      sourceInstance={null}
      statutory={null}
      raisedBy={null}
      raisedFromRisk={null}
      canEdit
      canReassign
      canAddAction
      actionEditing={{ all: true, personId: ROHAN }}
      today="2024-11-15"
      timeZone="Asia/Kolkata"
      {...over}
    />,
  );
}

/** Why a button is blocked, as its tooltip says. */
const blocked = (button: HTMLElement) =>
  document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent ?? null;

const withSteps = (nc: NonconformityView, steps: NcAction[]) =>
  ({ ...nc, allowedActions: steps }) as NonconformityView;

describe('NcRecord', () => {
  it('offers exactly the steps the view allows', () => {
    record(withSteps(COMPLAINT, []), { canEdit: false, canReassign: false });
    expect(screen.queryByRole('button', { name: 'Record root cause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel nonconformity' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reassign' })).toBeNull();
  });

  it('shows an incident with the personal-data notice, its notice instance and its sources', () => {
    record(INJURY, {
      statutory: {
        id: 's',
        label: 'Report a reportable accident',
        href: '/reg/s',
        due: '2024-08-26',
      },
      sourceInstance: { id: 'i', label: 'A register activity you cannot open', href: null },
      raisedFromRisk: { id: 'r', label: 'Hazard: trays', href: '/r/r' },
    });
    const incident = screen.getByRole('region', { name: 'The incident' });
    expect(within(incident).getByText(/Write no injured person’s name/)).toBeTruthy();
    expect(
      within(incident)
        .getByRole('link', { name: 'Report a reportable accident · due 26 Aug 2024' })
        .getAttribute('href'),
    ).toBe('/reg/s');
    expect(within(incident).getByText('19 Aug 2024, 15:10 IST')).toBeTruthy();
    expect(within(incident).getByText('Lost time, 3 days lost')).toBeTruthy();
    expect(screen.getByText('A register activity you cannot open')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Hazard: trays' })).toBeTruthy();
    expect(screen.getByText(/Effectiveness check due 12 Nov 2024, overdue 3 days/)).toBeTruthy();
  });

  it('records the root cause, asking for what ADD_ROOT_CAUSE needs', async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    record(withSteps(COMPLAINT, ['ADD_ROOT_CAUSE', 'CANCEL']));
    await user.click(screen.getByRole('button', { name: 'Record root cause' }));
    const form = screen.getByRole('dialog', { name: 'Record root cause' });
    const fill = async (label: string, text: string) =>
      user.type(within(form).getByRole('textbox', { name: label }), text);
    await fill('Containment', 'Held the batch.');
    await fill('Correction', 'Repacked it.');
    await user.click(within(form).getByRole('combobox', { name: 'Root cause method' }));
    await user.click(screen.getByRole('option', { name: 'Five whys' }));
    await fill('Root cause', 'Label roll swapped.');
    await user.click(within(form).getByRole('button', { name: 'Record root cause' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await fill('Similar occurrences', 'None found.');
    await user.click(within(form).getByRole('button', { name: 'Record root cause' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'addIsoNcRootCause',
        { id: COMPLAINT.id },
        {
          version: COMPLAINT.version,
          containment: `${COMPLAINT.containment ?? ''}Held the batch.`,
          correction: 'Repacked it.',
          rootCause: 'Label roll swapped.',
          similarOccurrences: 'None found.',
          rootCauseMethod: 'FIVE_WHYS',
        },
      ),
    );
  });

  it('cancels with a reason', async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    record(withSteps(COMPLAINT, ['CANCEL']));
    await user.click(screen.getByRole('button', { name: 'Cancel nonconformity' }));
    const dialog = screen.getByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Raised twice');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel nonconformity' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'cancelIsoNc',
        { id: COMPLAINT.id },
        {
          version: COMPLAINT.version,
          reason: 'Raised twice',
        },
      ),
    );
  });

  it('plans the actions only with an open one, and submits once they are done', async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    const rcf = withSteps(byNumber(5), ['PLAN_ACTIONS', 'SUBMIT_NO_ACTION']);
    const { unmount } = record(rcf, { actions: [] });
    await user.click(screen.getByRole('button', { name: 'Mark actions planned' }));
    let form = screen.getByRole('dialog', { name: 'Mark actions planned' });
    expect(within(form).getByText(/There is no open corrective action yet/)).toBeTruthy();
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Close without corrective action' }));
    form = screen.getByRole('dialog', { name: 'Close without corrective action' });
    for (const [label, text] of [
      ['Why no corrective action is needed', 'Corrected on the spot.'],
      ['Risk review', 'None needed.'],
      ['Change to the system', 'None needed.'],
    ] as const) {
      await user.type(within(form).getByRole('textbox', { name: label }), text);
    }
    await user.click(within(form).getByRole('button', { name: 'Submit for verification' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'submitIsoNcNoAction',
        { id: rcf.id },
        {
          version: rcf.version,
          noActionReason: 'Corrected on the spot.',
          riskReview: 'None needed.',
          systemChange: 'None needed.',
        },
      ),
    );
    unmount();

    const open = ISO.actions.find((a) => a.subject.type === 'NONCONFORMITY' && a.state === 'OPEN')!;
    const planned = withSteps(FROM_AUDIT, ['SUBMIT']);
    const second = record(planned, { actions: [open] });
    await user.click(screen.getByRole('button', { name: 'Submit for verification' }));
    form = screen.getByRole('dialog', { name: 'Submit for verification' });
    expect(within(form).getByText('1 corrective action is still open.')).toBeTruthy();
    second.unmount();

    record(withSteps(byNumber(5), ['PLAN_ACTIONS']), { actions: [open] });
    await user.click(screen.getByRole('button', { name: 'Mark actions planned' }));
    form = screen.getByRole('dialog', { name: 'Mark actions planned' });
    await user.type(
      within(form).getByRole('textbox', { name: 'Effectiveness check due on' }),
      '31 Jan 2025',
    );
    await user.tab();
    await user.click(within(form).getByRole('button', { name: 'Mark actions planned' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'planIsoNcActions',
        { id: byNumber(5).id },
        {
          version: byNumber(5).version,
          effectivenessDueOn: '2025-01-31',
        },
      ),
    );
  });

  it('submits with the risk review and system change, once every action is settled', async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    const planned = withSteps(FROM_AUDIT, ['SUBMIT']);
    record(planned, { actions: [] });
    await user.click(screen.getByRole('button', { name: 'Submit for verification' }));
    const form = screen.getByRole('dialog', { name: 'Submit for verification' });
    await user.type(within(form).getByRole('textbox', { name: 'Risk review' }), 'Reviewed.');
    await user.type(
      within(form).getByRole('textbox', { name: 'Change to the system' }),
      'Tray lifter added.',
    );
    await user.click(within(form).getByRole('button', { name: 'Submit for verification' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'submitIsoNc',
        { id: planned.id },
        {
          version: planned.version,
          riskReview: `${planned.riskReview ?? ''}Reviewed.`,
          systemChange: `${planned.systemChange ?? ''}Tray lifter added.`,
        },
      ),
    );
  });

  it('verifies effective, or sends it back with a reason and a new date', async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    const awaiting = withSteps(INJURY, ['VERIFY_EFFECTIVE', 'VERIFY_NOT_EFFECTIVE']);
    record(awaiting);
    await user.click(screen.getByRole('button', { name: 'Verify effective' }));
    let form = screen.getByRole('dialog', { name: 'Verify effective' });
    expect(within(form).getByText(/due on 12 Nov 2024/)).toBeTruthy();
    await user.type(within(form).getByRole('textbox', { name: 'How it was checked' }), 'No burns.');
    await user.click(within(form).getByRole('button', { name: 'Verify and close' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'verifyIsoNcEffective',
        { id: INJURY.id },
        {
          version: INJURY.version,
          effectivenessNote: 'No burns.',
        },
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Not effective' }));
    form = screen.getByRole('dialog', { name: 'Not effective' });
    await user.click(within(form).getByRole('radio', { name: /^Back to the actions/ }));
    await user.type(within(form).getByRole('textbox', { name: 'Why' }), 'Burns again.');
    await user.click(within(form).getByRole('button', { name: 'Not effective' }));
    expect(actions.isoWrite).toHaveBeenCalledTimes(1);
    await user.type(
      within(form).getByRole('textbox', { name: 'New effectiveness check due on' }),
      '28 Feb 2025',
    );
    await user.tab();
    await user.click(within(form).getByRole('button', { name: 'Not effective' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenLastCalledWith(
        C,
        'verifyIsoNcNotEffective',
        { id: INJURY.id },
        {
          version: INJURY.version,
          reason: 'Burns again.',
          backTo: 'ACTIONS_PLANNED',
          effectivenessDueOn: '2025-02-28',
        },
      ),
    );
  });

  it('reopens a closed one back to its root cause', async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    const closed = withSteps(byNumber(1), ['REOPEN']);
    record(closed);
    expect(screen.getByText(/^closed /)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    const form = screen.getByRole('dialog', { name: 'Reopen' });
    await user.click(within(form).getByRole('radio', { name: /^Back to the root cause/ }));
    await user.type(within(form).getByRole('textbox', { name: 'Why' }), 'Found again.');
    await user.click(within(form).getByRole('button', { name: 'Reopen' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'reopenIsoNc',
        { id: closed.id },
        {
          version: closed.version,
          reason: 'Found again.',
          backTo: 'OPEN',
        },
      ),
    );
  });

  it('edits only what changed, on the PATCH', async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    record(COMPLAINT);
    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    let form = screen.getByRole('dialog', { name: 'Edit details' });
    const text = within(form).getByRole('textbox', { name: 'What happened or was found' });
    await user.type(text, ' More.');
    await user.click(within(form).getByRole('button', { name: 'Save details' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoNonconformity',
        { id: COMPLAINT.id },
        {
          version: COMPLAINT.version,
          description: `${COMPLAINT.description} More.`,
        },
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Edit investigation' }));
    form = screen.getByRole('dialog', { name: 'Edit investigation' });
    await user.type(within(form).getByRole('textbox', { name: 'Containment' }), 'Held.');
    await user.click(
      within(form).getByRole('combobox', {
        name: 'Disposition of nonconforming outputs (optional)',
      }),
    );
    await user.click(screen.getByRole('option', { name: 'None' }));
    expect(within(form).queryByRole('combobox', { name: 'Disposition authorised by' })).toBeNull();
    await user.click(
      within(form).getByRole('combobox', {
        name: 'Disposition of nonconforming outputs (optional)',
      }),
    );
    await user.click(screen.getByRole('option', { name: 'Segregation' }));
    expect(blocked(within(form).getByRole('button', { name: 'Save investigation' }))).toBe(
      'Name who authorised the disposition',
    );
    await user.click(within(form).getByRole('button', { name: 'Save investigation' }));
    expect(actions.isoWrite).toHaveBeenCalledTimes(1);
    await user.click(within(form).getByRole('combobox', { name: 'Disposition authorised by' }));
    await user.click(screen.getByRole('option', { name: 'Nisha Patil' }));
    await user.click(within(form).getByRole('button', { name: 'Save investigation' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenLastCalledWith(
        C,
        'updateIsoNonconformity',
        { id: COMPLAINT.id },
        {
          version: COMPLAINT.version,
          containment: `${COMPLAINT.containment ?? ''}Held.`,
          disposition: 'SEGREGATION',
          dispositionAuthorisedById: NISHA,
        },
      ),
    );
  });

  it("edits an incident's fields but not its outcome", async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    const near = byNumber(6);
    record(near);
    await user.click(screen.getByRole('button', { name: 'Edit incident' }));
    const form = screen.getByRole('dialog', { name: 'Edit near miss' });
    expect(within(form).queryByRole('combobox', { name: 'Outcome' })).toBeNull();
    expect(within(form).getByRole('textbox', { name: 'Time (HH:MM)' })).toHaveProperty(
      'value',
      '13:45',
    );
    await user.click(
      within(form).getByRole('checkbox', {
        name: 'A worker who is not a manager took part in the investigation',
      }),
    );
    await user.click(within(form).getByRole('checkbox', { name: 'Nisha Patil' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoNonconformity',
        { id: near.id },
        {
          version: near.version,
          incident: {
            investigatorIds: [...near.incident!.investigatorIds, NISHA],
            workerParticipation: true,
          },
        },
      ),
    );
  });

  it('reassigns with a reason, offering severity only on a record raised by hand', async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    const { unmount } = record(byNumber(5));
    await user.click(screen.getByRole('button', { name: 'Reassign' }));
    expect(screen.queryByRole('radiogroup', { name: 'Severity' })).toBeNull();
    expect(screen.getByText('Its severity follows the audit finding that raised it.')).toBeTruthy();
    unmount();

    record(COMPLAINT);
    await user.click(screen.getByRole('button', { name: 'Reassign' }));
    const form = screen.getByRole('dialog', { name: 'Reassign' });
    await user.click(within(form).getByRole('combobox', { name: 'Owner' }));
    await user.click(screen.getByRole('option', { name: 'Sameer Gowda' }));
    await user.click(within(form).getByRole('radio', { name: 'Minor' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await user.type(within(form).getByRole('textbox', { name: 'Why' }), 'Sameer runs packing.');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'reassignIsoNonconformity',
        { id: COMPLAINT.id },
        {
          version: COMPLAINT.version,
          reason: 'Sameer runs packing.',
          ownerId: SAMEER,
          severity: 'MINOR',
        },
      ),
    );
  });

  it("reassigns an incident's outcome with the days lost while it can change", async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    const open = { ...INJURY, state: 'OPEN', effectivenessDueOn: null } as NonconformityView;
    record(open);
    await user.click(screen.getByRole('button', { name: 'Reassign' }));
    const form = screen.getByRole('dialog', { name: 'Reassign' });
    await user.click(within(form).getByRole('combobox', { name: 'Outcome' }));
    await user.click(screen.getByRole('option', { name: 'Fatality' }));
    await user.click(within(form).getByRole('combobox', { name: 'Outcome' }));
    await user.click(screen.getByRole('option', { name: 'Lost time' }));
    expect(within(form).queryByRole('textbox', { name: 'Days lost' })).toBeNull();
    await user.click(within(form).getByRole('combobox', { name: 'Outcome' }));
    await user.click(screen.getByRole('option', { name: 'First aid' }));
    await user.type(within(form).getByRole('textbox', { name: 'Why' }), 'Doctor said first aid.');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'reassignIsoNonconformity',
        { id: open.id },
        {
          version: open.version,
          reason: 'Doctor said first aid.',
          incident: { outcome: 'FIRST_AID', lostDays: null },
        },
      ),
    );
  });
});
