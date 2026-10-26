import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LocalDate, ObjectiveView } from '@canopy/contracts';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ISO } from '../_test/fixture';
import { objectiveFilterDefs, objectiveSystems } from './objectives-model';

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/c/c1/iso/objectives',
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

const { ObjectivesView } = await import('./ObjectivesView');
const { ObjectiveRecord } = await import('./[objectiveId]/ObjectiveRecord');

const C = 'c1';
const PATH = `/c/${C}/iso/objectives`;
const ok = <T,>(data: T) => ({ ok: true as const, data });
const day = (d: string) => d as LocalDate;
const ROHAN = ISO.people.find((p) => p.name === 'Rohan Joshi')!.id;
const objective = (start: string, over: Partial<ObjectiveView> = {}): ObjectiveView => ({
  ...ISO.objectives.find((o) => o.text.startsWith(start))!,
  ...over,
});
const ENERGY = objective('Cut grid');
const systems = objectiveSystems(ISO.systems, ISO.standards, ISO.risks);

beforeEach(() => {
  actions.isoWrite.mockReset();
  actions.isoWrite.mockResolvedValue(ok({ id: 'new-objective' }));
  nav.push.mockReset();
  nav.refresh.mockReset();
});

describe('ObjectivesView', () => {
  it('lists objectives with their target, progress and standing', () => {
    render(
      <ObjectivesView
        clientId={C}
        objectives={ISO.objectives}
        standards={ISO.standards}
        people={ISO.people}
        filters={objectiveFilterDefs(ISO.standards)}
        filterValue={{}}
        fromOverview
        clearHref={PATH}
        create={null}
      />,
    );
    const table = screen.getByRole('table', { name: 'Objectives' });
    expect(within(table).getByRole('link', { name: ENERGY.text }).getAttribute('href')).toBe(
      `${PATH}/${ENERGY.id}`,
    );
    expect(within(table).getByText(/Decrease to 380 kWh per tonne by 31 Mar 2025/)).toBeTruthy();
    expect(within(table).getAllByText('On track').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Show all objectives' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add objective' })).toBeNull();
  });

  it('adds an objective for the standards chosen, then opens it', async () => {
    render(
      <ObjectivesView
        clientId={C}
        objectives={[]}
        standards={ISO.standards}
        people={ISO.people}
        filters={[]}
        filterValue={{}}
        fromOverview={false}
        clearHref=""
        create={{ systems, people: ISO.people, ownerOnly: ROHAN, today: '2024-11-15' }}
      />,
    );
    expect(screen.getByText(/No objective matches/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add objective' }));
    const drawer = screen.getByRole('dialog', { name: 'Add objective' });
    await userEvent.click(within(drawer).getByRole('checkbox', { name: 'ISO 14001' }));
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Objective' }),
      'Cut water per tonne',
    );
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Baseline (optional)' }), '3');
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Target' }), '4');
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Unit' }), 'kL per tonne');
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Due on' }), '31 Mar 2026');
    await userEvent.tab();
    expect(
      within(drawer).getByRole('button', { name: 'Add objective' }).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      within(drawer).getByText(/To decrease, the target is at or below the baseline/),
    ).toBeTruthy();
    const target = within(drawer).getByRole('textbox', { name: 'Target' });
    await userEvent.clear(target);
    await userEvent.type(target, '2.5');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Add objective' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'createIsoObjective',
        {},
        {
          managementSystemId: ISO.system.id,
          standards: ['ISO_14001'],
          text: 'Cut water per tonne',
          target: 2.5,
          unitOfMeasure: 'kL per tonne',
          baseline: 3,
          direction: 'DECREASE',
          readingRule: { kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 0 },
          riskItemIds: [],
          ownerId: ROHAN,
          dueOn: '2026-03-31',
        },
      ),
    );
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`${PATH}/new-objective`));
  });
});

function record(over: Partial<Parameters<typeof ObjectiveRecord>[0]> = {}) {
  return render(
    <ObjectiveRecord
      clientId={C}
      objective={ENERGY}
      readings={ISO.readings[ENERGY.id]!}
      actions={ISO.actions.filter((a) => a.subject.id === ENERGY.id)}
      standards={ISO.standards}
      system={systems[0]}
      linkedRisks={[
        { id: 'r1', label: 'Energy: grid supply', href: `/c/${C}/iso/risks/r1` },
        { id: 'r2', label: 'A risk item you cannot see', href: null },
      ]}
      people={ISO.people}
      canEdit
      canReassign
      canAddAction
      actionEditing={{ all: true, personId: ROHAN }}
      today="2024-11-15"
      {...over}
    />,
  );
}

describe('ObjectiveRecord', () => {
  it('shows the target, progress, linked risks, readings and plan', () => {
    record({
      objective: {
        ...ENERGY,
        progress: {
          ...ENERGY.progress,
          missedReadings: [{ periodStart: day('2024-01-01'), periodEnd: day('2024-03-31') }],
        },
      },
    });
    expect(screen.getByText('Decrease to 380 kWh per tonne by 31 Mar 2025')).toBeTruthy();
    expect(screen.getByText('420 kWh per tonne')).toBeTruthy();
    expect(screen.getByText('Every quarter')).toBeTruthy();
    expect(
      screen.getByText(/^Latest 395 kWh per tonne \(to 30 Sep 2024\), 63% of the way$/),
    ).toBeTruthy();
    expect(screen.getByText('One period has no reading:')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Energy: grid supply' }).getAttribute('href')).toBe(
      `/c/${C}/iso/risks/r1`,
    );
    expect(screen.getByText('A risk item you cannot see').closest('a')).toBeNull();
    expect(screen.getAllByRole('listitem', { name: /^Reading for / })).toHaveLength(2);
    expect(screen.getByText('Line 1 heat recovery came on in August.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Objective plans' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add objective plan' })).toBeTruthy();
  });

  it('takes no reading, plan or change once closed', () => {
    record({ objective: { ...ENERGY, closedOn: day('2025-03-31'), outcome: 'ACHIEVED' } });
    expect(screen.getByText('Achieved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record reading' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Correct reading' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close objective' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add objective plan' })).toBeNull();
  });

  it('records a reading for a period', async () => {
    record();
    await userEvent.click(screen.getByRole('button', { name: 'Record reading' }));
    const drawer = screen.getByRole('dialog', { name: 'Record reading' });
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Period from' }),
      '1 Oct 2024',
    );
    await userEvent.tab();
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'Period to' }), '31 Dec 2024');
    await userEvent.tab();
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Reading (kWh per tonne)' }),
      '388.5',
    );
    await userEvent.click(within(drawer).getByRole('button', { name: 'Record reading' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'createIsoReading',
        { id: ENERGY.id },
        { periodStart: '2024-10-01', periodEnd: '2024-12-31', value: 388.5, note: null },
      ),
    );
  });

  it('corrects a reading’s value, keeping its period', async () => {
    record();
    const first = screen.getAllByRole('listitem', { name: /^Reading for / })[0]!;
    await userEvent.click(within(first).getByRole('button', { name: 'Correct reading' }));
    const drawer = screen.getByRole('dialog', { name: 'Correct reading' });
    const value = within(drawer).getByRole('textbox', { name: 'Reading (kWh per tonne)' });
    await userEvent.clear(value);
    await userEvent.type(value, '410');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save reading' }));
    const reading = ISO.readings[ENERGY.id]![0]!;
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoReading',
        { id: ENERGY.id, readingId: reading.id },
        { version: reading.version, value: 410 },
      ),
    );
  });

  it('closes the objective with its outcome', async () => {
    record();
    await userEvent.click(screen.getByRole('button', { name: 'Close objective' }));
    const drawer = screen.getByRole('dialog', { name: 'Close objective' });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Close objective' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await userEvent.click(within(drawer).getByRole('radio', { name: 'Not achieved' }));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Close objective' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'closeIsoObjective',
        { id: ENERGY.id },
        { version: ENERGY.version, closedOn: '2024-11-15', outcome: 'NOT_ACHIEVED' },
      ),
    );
  });

  it('asks why when an edit moves the due date', async () => {
    record();
    await userEvent.click(screen.getByRole('button', { name: 'Edit objective' }));
    const drawer = screen.getByRole('dialog', { name: 'Edit objective' });
    const due = within(drawer).getByRole('textbox', { name: 'Due on' });
    await userEvent.clear(due);
    await userEvent.type(due, '30 Jun 2025');
    await userEvent.tab();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save objective' }));
    expect(actions.isoWrite).not.toHaveBeenCalled();
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: 'Why the owner or due date changes' }),
      'Solar arrives late',
    );
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save objective' }));
    await waitFor(() =>
      expect(actions.isoWrite).toHaveBeenCalledWith(
        C,
        'updateIsoObjective',
        { id: ENERGY.id },
        { version: ENERGY.version, dueOn: '2025-06-30', reason: 'Solar arrives late' },
      ),
    );
  });
});
