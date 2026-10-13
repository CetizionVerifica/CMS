import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { setViewport } from '../../test/viewport';
import {
  FilterBar,
  summarise,
  type FilterBarProps,
  type FilterDef,
  type FilterValue,
} from './FilterBar';
import { StatusPill } from './StatusPill';

const filters: FilterDef[] = [
  {
    key: 'status',
    label: 'Status',
    kind: 'multi',
    display: 'status',
    options: [
      { value: 'OVERDUE', label: 'Overdue', count: 38 },
      { value: 'DUE_SOON', label: 'Due soon', count: 12 },
      { value: 'SUBMITTED', label: 'Awaiting approval', count: 4 },
      { value: 'COMPLIED', label: 'Complied', count: 1200 },
    ],
  },
  {
    key: 'criticality',
    label: 'Criticality',
    kind: 'multi',
    display: 'criticality',
    options: [
      { value: 'SUPER_CRITICAL', label: 'Super critical' },
      { value: 'CRITICAL', label: 'Critical' },
    ],
  },
  {
    key: 'department',
    label: 'Department',
    kind: 'multi',
    order: 'alpha',
    options: ['Legal', 'EHS', 'Finance', 'HR', 'IT', 'Admin', 'Security', 'Stores', 'Quality'].map(
      (d) => ({ value: d.toLowerCase(), label: d }),
    ),
  },
  {
    key: 'due',
    label: 'Due date',
    kind: 'dateRange',
    presets: [
      { value: 'overdue', label: 'Overdue', range: { to: '2027-03-09' } },
      { value: 'week', label: 'This week', range: { from: '2027-03-08', to: '2027-03-14' } },
    ],
  },
  {
    key: 'unit',
    label: 'Unit',
    kind: 'multi',
    options: [{ value: 'riverbend', label: 'Riverbend' }],
  },
];

function Harness(props: Partial<FilterBarProps> & { initial?: Record<string, FilterValue> }) {
  const { initial = {}, ...rest } = props;
  const [value, setValue] = useState<Record<string, FilterValue>>(initial);
  return (
    <>
      <FilterBar
        filters={filters}
        value={value}
        onChange={setValue}
        primaryKeys={['status', 'criticality', 'department', 'due']}
        resultText="38 instances match"
        resultCount={38}
        {...rest}
      />
      <pre data-testid="value">{JSON.stringify(value)}</pre>
    </>
  );
}

const current = () =>
  JSON.parse(screen.getByTestId('value').textContent!) as Record<string, FilterValue>;

afterEach(() => vi.useRealTimers());

describe('FilterBar', () => {
  it('summarises values', () => {
    expect(summarise(filters[0]!, ['OVERDUE'])).toBe('Overdue');
    expect(summarise(filters[0]!, ['OVERDUE', 'DUE_SOON'])).toBe('Overdue, Due soon');
    expect(summarise(filters[0]!, ['OVERDUE', 'DUE_SOON', 'COMPLIED'])).toBe('Overdue +2');
    expect(summarise(filters[1]!, ['CRITICAL'])).toBe('Critical');
    expect(summarise(filters[2]!, ['hr', 'x'])).toBe('HR, x');
    expect(summarise(filters[3]!, { preset: 'week' })).toBe('This week');
    expect(summarise(filters[3]!, { preset: 'gone' })).toBe('gone');
    expect(summarise(filters[3]!, { from: '2027-03-01', to: '2027-03-31' })).toBe(
      '1 Mar 2027 – 31 Mar 2027',
    );
    expect(summarise(filters[3]!, { from: '2027-03-01' })).toBe('From 1 Mar 2027');
    expect(summarise(filters[3]!, { to: '2027-03-31' })).toBe('Until 31 Mar 2027');
  });

  it('shows chips in a labelled group and applies values as they are ticked', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const group = screen.getByRole('group', { name: 'Filters' });
    expect(
      within(group).getByRole('button', { name: 'Status' }).getAttribute('aria-haspopup'),
    ).toBe('dialog');
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();

    screen.getByRole('button', { name: 'Status' }).focus();
    await user.keyboard('{ArrowDown}');
    const popover = screen.getByRole('dialog', { name: 'Status filter' });
    expect(within(popover).getByText('1,200')).toBeTruthy();
    const overdue = within(popover).getByRole('checkbox', { name: 'Overdue' });
    overdue.focus();
    await user.keyboard(' ');
    expect(current()).toEqual({ status: ['OVERDUE'] });
    await user.keyboard('{ArrowDown} ');
    expect(current()).toEqual({ status: ['OVERDUE', 'DUE_SOON'] });
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(overdue);
    await expectNoAxeViolations(popover);
    await user.keyboard('{Escape}');

    const chip = screen.getByRole('button', { name: 'Status filter: Overdue, Due soon. Change' });
    expect(document.activeElement).toBe(chip);
    expect(screen.getByRole('status').textContent).toBe('38 instances match');
    expect(chip.parentElement!.className).toContain('bg-sage');
  });

  it('removes a filter with the X, Backspace or Clear, and clears all', async () => {
    const user = userEvent.setup();
    render(
      <Harness initial={{ status: ['OVERDUE'], criticality: ['CRITICAL'], department: ['hr'] }} />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove status filter' }));
    expect(current()).toEqual({ criticality: ['CRITICAL'], department: ['hr'] });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Status' }));

    screen.getByRole('button', { name: /^Criticality filter/ }).focus();
    await user.keyboard('{Backspace}');
    expect(current()).toEqual({ department: ['hr'] });

    await user.click(screen.getByRole('button', { name: /^Department filter/ }));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(current()).toEqual({});

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Status' }));
    await user.click(screen.getByRole('checkbox', { name: 'Overdue' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(current()).toEqual({});
  });

  it('searches long option lists, sorts them and says when nothing matches', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Department' }));
    const list = screen.getByRole('list', { name: 'Department' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Admin', 'EHS', 'Finance', 'HR', 'IT', 'Legal', 'Quality', 'Security', 'Stores']);
    const search = screen.getByRole('textbox', { name: 'Search department' });
    await user.type(search, 's');
    expect(within(list).getAllByRole('checkbox')).toHaveLength(3);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(within(list).getAllByRole('checkbox')[0]);
    await user.click(search);
    await user.keyboard('zz');
    expect(screen.getByText('No department matches “szz”.')).toBeTruthy();
  });

  it('picks a date preset or a custom range', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Due date' }));
    await user.click(screen.getByRole('checkbox', { name: 'This week' }));
    expect(current()).toEqual({ due: { from: '2027-03-08', to: '2027-03-14', preset: 'week' } });
    expect(screen.getByRole('button', { name: 'Due date filter: This week. Change' })).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'This week' }));
    expect(current()).toEqual({});

    await user.type(screen.getByRole('textbox', { name: 'From' }), '1/3/2027{Enter}');
    expect(current()).toEqual({ due: { from: '2027-03-01' } });
    await user.type(screen.getByRole('textbox', { name: 'To' }), '31/3/2027{Enter}');
    expect(current()).toEqual({ due: { from: '2027-03-01', to: '2027-03-31' } });
    await user.click(screen.getByRole('checkbox', { name: 'Overdue' }));
    expect(current()).toEqual({ due: { to: '2027-03-09', preset: 'overdue' } });
    await user.type(screen.getByRole('textbox', { name: 'To' }), '31/3/2027{Enter}');
    expect(current()).toEqual({ due: { to: '2027-03-31' } });
  });

  it('reveals less common filters from More', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Unit' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: 'Unit' }));
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(screen.getByRole('dialog', { name: 'Unit filter' })).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Riverbend' }));
    expect(current()).toEqual({ unit: ['riverbend'] });
  });

  it('keeps three chips inline under 1100px', () => {
    setViewport(900);
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Due date' })).toBeNull();
    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy();
  });

  it('debounces search by 250ms and clears it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onSearch = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { rerender } = render(<Harness search={{ value: '', onChange: onSearch }} />);
    const box = screen.getByRole('searchbox', { name: 'Search title, ID or Act' });
    await user.type(box, 'tcs');
    expect(onSearch).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(260));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('tcs');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onSearch).toHaveBeenLastCalledWith('');
    rerender(<Harness search={{ value: 'from url', onChange: onSearch }} />);
    expect((box as HTMLInputElement).value).toBe('from url');
  });

  it('disables the chips while the table is in error', () => {
    render(<Harness disabled initial={{ status: ['OVERDUE'] }} />);
    expect(screen.getByRole('button', { name: /^Status filter/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Remove status filter' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('becomes search plus a Filters sheet under 640px', async () => {
    setViewport(375);
    const user = userEvent.setup();
    render(
      <Harness initial={{ status: ['OVERDUE'] }} search={{ value: '', onChange: () => {} }} />,
    );
    expect(screen.queryByRole('button', { name: /^Status/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Filters (1)' }));
    const sheet = screen.getByRole('dialog', { name: 'Filters' });
    const statusSection = within(sheet).getByRole('button', { name: /^Status/ });
    expect(statusSection.textContent).toContain('Overdue');
    await user.click(within(sheet).getByRole('button', { name: /^Criticality/ }));
    await user.click(within(sheet).getByRole('checkbox', { name: 'Critical' }));
    expect(current()).toEqual({ status: ['OVERDUE'], criticality: ['CRITICAL'] });
    await expectNoAxeViolations(sheet);
    await user.click(within(sheet).getByRole('button', { name: 'Clear all' }));
    expect(current()).toEqual({});
    await user.click(within(sheet).getByRole('button', { name: 'Show 38 results' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Filters' })).toBeTruthy();
  });

  it('names a status option as a category, without a day count', () => {
    render(<StatusPill status="OVERDUE" category />);
    expect(screen.getByText('Overdue')).toBeTruthy();
    render(<StatusPill status="DUE_SOON" category />);
    expect(screen.getByText('Due soon')).toBeTruthy();
    render(<StatusPill status="COMPLIED" category />);
    expect(screen.getByText('Complied')).toBeTruthy();
  });
});
