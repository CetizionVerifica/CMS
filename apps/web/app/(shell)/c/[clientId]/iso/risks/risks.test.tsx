import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RiskItemView } from '@canopy/contracts';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ISO } from '../_test/fixture';
import { kindTabs, riskFilterDefs, riskFilters, riskRows } from './risks-model';

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/c/c1/iso/risks',
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

const { RisksView } = await import('./RisksView');
const { RiskRecord } = await import('./[riskId]/RiskRecord');

const C = 'c1';
const PATH = `/c/${C}/iso/risks`;
const ok = <T,>(data: T) => ({ ok: true as const, data });
const person = (name: string) => ISO.people.find((p) => p.name === name)!.id;
const ROHAN = person('Rohan Joshi');
const risk = (activity: string, over: Partial<RiskItemView> = {}): RiskItemView => ({
  ...ISO.risks.find((r) => r.activity === activity)!,
  ...over,
});
const OVEN = risk('Changing oven trays on line 2');
const units = ISO.units.map((u) => ({ id: u.id, name: u.name }));
const create = (ownerOnly: string | null = null) => ({
  systems: [{ id: ISO.system.id, name: ISO.system.name, unitIds: ISO.system.unitIds }],
  units,
  people: ISO.people,
  ownerOnly,
  today: '2024-11-15',
});

beforeEach(() => {
  actions.isoWrite.mockReset();
  actions.isoWrite.mockResolvedValue(ok({ id: 'new-risk' }));
  exports.startIsoExport.mockReset();
  exports.isoExportProgress.mockReset();
  nav.push.mockReset();
  nav.refresh.mockReset();
});

function list(search: Record<string, string> = {}, withCreate = false) {
  const f = riskFilters(search, [ISO.system.id]);
  return render(
    <RisksView
      clientId={C}
      rows={riskRows(ISO.risks, ISO.units, ISO.people)}
      tabs={kindTabs(PATH, f)}
      kind={f.kind}
      filters={riskFilterDefs()}
      filterValue={{}}
      fromOverview={f.ids.length > 0}
      clearHref={PATH}
      exportFilters="significant=true"
      create={withCreate ? create(ROHAN) : null}
    />,
  );
}

describe('RisksView', () => {
  it('lists the register with kind tabs, each row linking to its item', () => {
    list({ kind: 'HAZARD', ids: 'x' });
    const table = screen.getByRole('table', { name: 'Risk register' });
    expect(within(table).getByRole('link', { name: OVEN.description }).getAttribute('href')).toBe(
      `${PATH}/${OVEN.id}`,
    );
    const tabs = within(screen.getByRole('navigation', { name: 'Kinds' })).getAllByRole('link');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'All',
      'Risks',
      'Opportunities',
      'Aspects',
      'Hazards',
    ]);
    expect(tabs[4]!.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Show the whole register' }).getAttribute('href')).toBe(
      PATH,
    );
    expect(screen.getByText(/without the overview’s selection/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add to the register' })).toBeNull();
  });

  it('downloads the register with its filters, without ids', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    exports.startIsoExport.mockResolvedValue({ ok: true, id: 'exp-1' });
    exports.isoExportProgress.mockResolvedValue({
      status: 'ready',
      url: 'https://storage.invalid/x',
    });
    list();
    expect(screen.queryByText(/overview’s selection/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Download risk register (Excel)' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://storage.invalid/x'));
    expect(exports.startIsoExport).toHaveBeenCalledWith(
      C,
      'ISO_RISK_REGISTER_XLSX',
      'significant=true',
    );
    expect(exports.isoExportProgress).toHaveBeenCalledWith('exp-1');
    expect(screen.getByText('The download has started.').getAttribute('role')).toBe('status');
    vi.unstubAllGlobals();
  });

  it('says why a download did not start or failed', async () => {
    exports.startIsoExport.mockResolvedValueOnce({
      ok: false,
      message: 'You can’t download this.',
    });
    list();
    const button = screen.getByRole('button', { name: 'Download risk register (Excel)' });
    await userEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toBe('You can’t download this.');
    exports.startIsoExport.mockResolvedValueOnce({ ok: true, id: 'exp-2' });
    exports.isoExportProgress.mockResolvedValueOnce({
      status: 'failed',
      message: 'The download couldn’t be prepared. Try again.',
    });
    await userEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'The download couldn’t be prepared. Try again.',
      ),
    );
  });

  it('adds a hazard with its own fields, then opens it', async () => {
    list({ kind: 'HAZARD' }, true);
    await userEvent.click(screen.getByRole('button', { name: 'Add to the register' }));
    const drawer = screen.getByRole('dialog', { name: 'Add to the risk register' });
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Activity, product or service' }),
      'Cleaning the mixer',
    );
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'The hazard' }),
      'Moving blades during cleaning.',
    );
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Harm it can cause' }),
      'Cuts to hands.',
    );
    await userEvent.click(within(drawer).getByRole('radio', { name: 'Non-routine' }));
    await userEvent.click(within(drawer).getByRole('checkbox', { name: 'Worker' }));
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Operating condition' }));
    await userEvent.click(screen.getByRole('option', { name: 'Abnormal' }));
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Likelihood' }));
    await userEvent.click(screen.getByRole('option', { name: '2' }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Add' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Severity' }));
    await userEvent.click(screen.getByRole('option', { name: '5' }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'createIsoRisk',
        {},
        expect.objectContaining({
          managementSystemId: ISO.system.id,
          kind: 'HAZARD',
          activity: 'Cleaning the mixer',
          description: 'Moving blades during cleaning.',
          impact: 'Cuts to hands.',
          routine: false,
          personsExposed: ['WORKER'],
          condition: 'ABNORMAL',
          lifeCycleStages: [],
          controlType: null,
          likelihood: 2,
          severity: 5,
          ownerId: ROHAN,
        }),
      ),
    );
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`${PATH}/new-risk`));
  });
});

function record(over: Partial<Parameters<typeof RiskRecord>[0]> = {}) {
  return render(
    <RiskRecord
      clientId={C}
      risk={OVEN}
      controls={ISO.controls[OVEN.id]!}
      actions={ISO.actions.filter((a) => a.subject.id === OVEN.id)}
      people={ISO.people}
      units={units}
      unitName="Line 2"
      systemName={ISO.system.name}
      canEdit
      canReassign
      canOverride
      canAddAction
      actionEditing={{ all: true, personId: ROHAN }}
      today="2024-11-15"
      {...over}
    />,
  );
}

describe('RiskRecord', () => {
  it("shows a hazard's fields, rating, controls and treatment actions", () => {
    record();
    expect(screen.getByText(OVEN.impact!)).toBeTruthy();
    expect(screen.getByText('Worker, Contractor')).toBeTruthy();
    expect(screen.getByText('12 (3 × 4)')).toBeTruthy();
    expect(screen.getByText('Significant')).toBeTruthy();
    const controls = screen.getAllByRole('listitem', { name: /^Control: / });
    expect(controls).toHaveLength(2);
    expect(
      within(controls[1]!).getByText(/Engineering · from a treatment action done/),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Treatment actions' })).toBeTruthy();
    expect(
      screen.getByRole('listitem', { name: /^Treatment action: Make every line 2 tray change/ }),
    ).toBeTruthy();
  });

  it('offers no change to a reader or on an archived item', () => {
    record({ canEdit: false, canOverride: false, canAddAction: false });
    expect(screen.queryByRole('button', { name: 'Edit or re-rate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add control' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Override significance' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add treatment action' })).toBeNull();
  });

  it('adds a control to a hazard only with its kind', async () => {
    actions.isoWrite.mockResolvedValue(ok({ id: 'ctl' }));
    record();
    await userEvent.click(screen.getByRole('button', { name: 'Add control' }));
    const drawer = screen.getByRole('dialog', { name: 'Add control in place' });
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'The control' }),
      'Tray lifter',
    );
    await userEvent.click(within(drawer).getByRole('button', { name: 'Add control' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await userEvent.click(within(drawer).getByRole('combobox', { name: 'Kind of control' }));
    await userEvent.click(screen.getByRole('option', { name: 'Engineering' }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Add control' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'createIsoRiskControl',
        { id: OVEN.id },
        { text: 'Tray lifter', hierarchy: 'ENGINEERING' },
      ),
    );
  });

  it('removes a control with a reason', async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    record();
    const gloves = screen.getByRole('listitem', { name: /^Control: Heat-resistant gloves/ });
    await userEvent.click(within(gloves).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Replaced by the guard rails');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'archiveIsoRiskControl',
        { id: OVEN.id, controlId: ISO.controls[OVEN.id]![0]!.id },
        { version: 1, reason: 'Replaced by the guard rails' },
      ),
    );
  });

  it('overrides the significance with a reason', async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    record();
    await userEvent.click(screen.getByRole('button', { name: 'Override significance' }));
    const drawer = screen.getByRole('dialog', { name: 'Override significance' });
    await userEvent.click(within(drawer).getByRole('radio', { name: 'Not significant' }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Why' }), 'Line 2 is closed');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'setIsoRiskSignificance',
        { id: OVEN.id },
        { version: OVEN.version, significantOverride: false, reason: 'Line 2 is closed' },
      ),
    );
  });

  it('records a review with its next date', async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    record();
    await userEvent.click(screen.getByRole('button', { name: 'Record review' }));
    const drawer = screen.getByRole('dialog', { name: 'Record review' });
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Next review' }),
      '20 Sep 2025',
    );
    await userEvent.tab();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Record review' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'reviewIsoRisk',
        { id: OVEN.id },
        { version: OVEN.version, nextReviewDueOn: '2025-09-20' },
      ),
    );
  });

  it('asks why when an edit moves the review date', async () => {
    actions.isoWrite.mockResolvedValue(ok(null));
    record();
    await userEvent.click(screen.getByRole('button', { name: 'Edit or re-rate' }));
    const drawer = screen.getByRole('dialog', { name: 'Edit hazard' });
    const date = within(drawer).getByRole('textbox', { name: 'Next review' });
    await userEvent.clear(date);
    await userEvent.type(date, '1 Oct 2025');
    await userEvent.tab();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Why the owner or review date changes' }),
      'Waiting for the new oven',
    );
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoRisk',
        { id: OVEN.id },
        { version: OVEN.version, reviewDueOn: '2025-10-01', reason: 'Waiting for the new oven' },
      ),
    );
  });
});
