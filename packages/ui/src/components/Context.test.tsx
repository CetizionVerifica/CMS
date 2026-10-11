import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { setViewport } from '../../test/viewport';
import { DateInput } from '../primitives/DateInput';
import { ClientSwitcher, type ClientSummary } from './ClientSwitcher';
import { PeriodPicker, type Period } from './PeriodPicker';

const clients: ClientSummary[] = [
  { id: 'hb', name: 'Hindalco Belur', meta: 'Metals · 3 units', overdueCount: 12 },
  { id: 'tp', name: 'Taloja Plastics', meta: 'Chemicals · 1 unit', overdueCount: 0 },
  { id: 'ak', name: 'Aarav Knitwear', meta: 'Textiles · 2 units', overdueCount: 3 },
  { id: 'mb', name: 'Mahim Bakers', meta: 'Food · 1 unit', overdueCount: 1 },
];

function renderSwitcher(props: Partial<Parameters<typeof ClientSwitcher>[0]> = {}) {
  const onNavigate = vi.fn();
  render(
    <ClientSwitcher
      current={clients[0]}
      clients={clients}
      recentIds={['tp', 'hb']}
      hrefFor={(id) => `/c/${id}/register?status=overdue`}
      onNavigate={onNavigate}
      {...props}
    />,
  );
  return { onNavigate };
}

describe('ClientSwitcher', () => {
  it('names the trigger and opens on ArrowDown with focus in the search field', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    const trigger = screen.getByRole('button', { name: 'Client: Hindalco Belur, change client' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('title')).toBe('Hindalco Belur');
    expect(trigger.textContent).toContain('Metals · 3 units');

    await user.tab();
    await user.keyboard('{ArrowDown}');
    const dialog = screen.getByRole('dialog', { name: 'Change client' });
    const search = within(dialog).getByRole('combobox', { name: 'Find a client' });
    expect(document.activeElement).toBe(search);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    // Recent first (max 3, most recent first), then all clients alphabetically.
    const groups = within(dialog).getAllByRole('group');
    expect(groups.map((g) => g.textContent?.slice(0, 6))).toEqual(['Recent', 'All cl']);
    expect(
      within(groups[0]!)
        .getAllByRole('option')
        .map((o) => o.getAttribute('aria-label')),
    ).toEqual([
      'Taloja Plastics, Chemicals · 1 unit',
      'Hindalco Belur, Metals · 3 units, 12 overdue',
    ]);
    expect(within(groups[0]!).getAllByRole('option')[1]!.textContent).toContain('12 overdue');
    expect(
      within(groups[1]!)
        .getAllByRole('option')
        .map((o) => o.getAttribute('aria-label')),
    ).toEqual([
      'Aarav Knitwear, Textiles · 2 units, 3 overdue',
      'Hindalco Belur, Metals · 3 units, 12 overdue',
      'Mahim Bakers, Food · 1 unit, 1 overdue',
      'Taloja Plastics, Chemicals · 1 unit',
    ]);
    expect(
      within(groups[1]!)
        .getByRole('option', { name: /^Hindalco/ })
        .getAttribute('aria-selected'),
    ).toBe('true');
    await expectNoAxeViolations(dialog);
  });

  it('filters by name and meta, moves the highlight and navigates on Enter', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderSwitcher();
    await user.click(screen.getByRole('button', { name: /change client/ }));
    const search = screen.getByRole('combobox', { name: 'Find a client' });

    await user.keyboard('units');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-label')?.split(',')[0])).toEqual([
      'Aarav Knitwear',
      'Hindalco Belur',
    ]);
    expect(search.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    await user.keyboard('{ArrowDown}');
    expect(search.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    await user.keyboard('{ArrowDown}{ArrowUp}{End}{Home}');
    expect(search.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    await user.keyboard('{Enter}');
    expect(onNavigate).toHaveBeenCalledWith('/c/ak/register?status=overdue');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says when nothing matches and chooses with the mouse', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderSwitcher();
    await user.click(screen.getByRole('button', { name: /change client/ }));
    await user.keyboard('zzz');
    expect(screen.getByText('No client matches “zzz”.')).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(onNavigate).not.toHaveBeenCalled();
    await user.clear(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: /^Mahim/ }));
    expect(onNavigate).toHaveBeenCalledWith('/c/mb/register?status=overdue');
  });

  it('closes on Escape and returns focus to the trigger; Ctrl+K opens it from anywhere', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    const trigger = screen.getByRole('button', { name: /change client/ });
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard('{Meta>}K{/Meta}');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows skeleton rows while loading and a footer link to the portfolio', async () => {
    const user = userEvent.setup();
    renderSwitcher({ loading: true, overviewHref: '/portfolio' });
    await user.click(screen.getByRole('button', { name: /change client/ }));
    const list = screen.getByRole('listbox', { name: 'Clients' });
    expect(list.getAttribute('aria-busy')).toBe('true');
    expect(within(list).getByText('Loading clients')).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('combobox').getAttribute('aria-activedescendant')).toBeNull();
    await user.click(screen.getByRole('link', { name: 'All clients overview' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('can leave Ctrl+K to another switcher', async () => {
    const user = userEvent.setup();
    renderSwitcher({ shortcut: false });
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks to choose a client when none is current', () => {
    renderSwitcher({ current: undefined });
    expect(screen.getByRole('button', { name: 'Choose a client' })).toBeTruthy();
  });

  it('is static text when the user has one client', () => {
    renderSwitcher({ clients: [clients[0]!] });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Hindalco Belur')).toBeTruthy();
  });

  it('opens a full-height sheet under 640px with the name only on the trigger', async () => {
    setViewport(375);
    const user = userEvent.setup();
    renderSwitcher();
    const trigger = screen.getByRole('button', { name: /change client/ });
    expect(trigger.textContent).not.toContain('Metals');
    await user.click(trigger);
    const sheet = screen.getByRole('dialog', { name: 'Change client' });
    expect(sheet.className).toContain('inset-0');
    expect(document.activeElement).toBe(within(sheet).getByRole('combobox'));
    await expectNoAxeViolations(sheet);
    await user.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('falls back to a full page navigation', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...original, assign },
      configurable: true,
    });
    const user = userEvent.setup();
    render(<ClientSwitcher current={clients[0]} clients={clients} hrefFor={(id) => `/c/${id}`} />);
    await user.click(screen.getByRole('button', { name: /change client/ }));
    await user.keyboard('{Enter}');
    expect(assign).toHaveBeenCalledWith('/c/ak');
    Object.defineProperty(window, 'location', { value: original, configurable: true });
  });
});

function ControlledPeriod({
  initial,
  ...props
}: { initial: Period } & Partial<Parameters<typeof PeriodPicker>[0]>) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <PeriodPicker
        value={value}
        onChange={setValue}
        availableFys={['2021-22', '2022-23', '2023-24']}
        thisPeriod={{ fy: '2022-23', quarter: 3 }}
        {...props}
      />
      <output data-testid="period">{JSON.stringify(value)}</output>
    </>
  );
}

const period = () => JSON.parse(screen.getByTestId('period').textContent!) as Period;

describe('PeriodPicker', () => {
  it('names the chip and opens on the selected quarter', async () => {
    const user = userEvent.setup();
    render(<ControlledPeriod initial={{ fy: '2022-23', quarter: 2 }} />);
    const chip = screen.getByRole('button', {
      name: 'Period: FY 2022–23, quarter 2, change period',
    });
    expect(chip.textContent).toBe('FY 2022–23 · Q2');
    await user.tab();
    await user.keyboard('{Enter}');
    const popover = screen.getByRole('dialog', { name: 'Choose period' });
    const grid = within(popover).getByRole('radiogroup', { name: 'Quarter' });
    const q2 = within(grid).getByRole('radio', { name: 'Quarter 2, July 2022 to September 2022' });
    expect(document.activeElement).toBe(q2);
    expect(q2.getAttribute('aria-checked')).toBe('true');
    expect(within(grid).getByRole('radio', { name: /^Quarter 3/ }).className).toContain(
      'border-forest',
    );
    expect(
      within(grid)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Q1 Apr–Jun', 'Q2 Jul–Sep', 'Q3 Oct–Dec', 'Q4 Jan–Mar']);
    await expectNoAxeViolations(popover);
  });

  it('moves across the quarter grid with arrows and selects with Enter', async () => {
    const user = userEvent.setup();
    render(<ControlledPeriod initial={{ fy: '2022-23', quarter: 1 }} />);
    await user.click(screen.getByRole('button', { name: /change period/ }));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.textContent).toBe('Q2 Jul–Sep');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('Q4 Jan–Mar');
    await user.keyboard('{ArrowLeft}{ArrowUp}');
    expect(document.activeElement?.textContent).toBe('Q1 Apr–Jun');
    await user.keyboard('{End}');
    expect(document.activeElement?.textContent).toBe('Q4 Jan–Mar');
    await user.keyboard('{Home}{ArrowUp}{ArrowLeft}');
    expect(document.activeElement?.textContent).toBe('Q1 Apr–Jun');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(period()).toEqual({ fy: '2022-23', quarter: 3 });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /change period/ }).textContent).toBe(
      'FY 2022–23 · Q3',
    );
  });

  it('switches to months, disables months without instances and skips them', async () => {
    const user = userEvent.setup();
    render(<ControlledPeriod initial={{ fy: '2022-23', quarter: 3 }} availableUntil="2023-01" />);
    await user.click(screen.getByRole('button', { name: /change period/ }));
    await user.click(screen.getByRole('radio', { name: 'Month' }));
    const grid = screen.getByRole('radiogroup', { name: 'Month' });
    const months = within(grid).getAllByRole('radio');
    expect(months.map((m) => m.textContent)).toEqual([
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
      'Jan',
      'Feb',
      'Mar',
    ]);
    const feb = within(grid).getByRole('radio', { name: 'February 2023' });
    expect(feb.getAttribute('aria-disabled')).toBe('true');
    expect(
      within(grid).getByRole('radio', {
        description: 'No instances generated yet',
        name: 'February 2023',
      }),
    ).toBe(feb);
    // The current quarter's months are outlined.
    expect(within(grid).getByRole('radio', { name: 'November 2022' }).className).toContain(
      'border-forest',
    );

    // No selection in month view yet: focus the first current month, then walk to the last enabled one.
    const oct = within(grid).getByRole('radio', { name: 'October 2022' });
    expect(oct.tabIndex).toBe(0);
    oct.focus();
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(within(grid).getByRole('radio', { name: 'January 2023' }));
    await user.keyboard('{ArrowRight}{ArrowDown}');
    expect(document.activeElement).toBe(within(grid).getByRole('radio', { name: 'January 2023' }));
    await user.click(feb);
    expect(period()).toEqual({ fy: '2022-23', quarter: 3 });
    await user.keyboard('{Enter}');
    expect(period()).toEqual({ fy: '2022-23', month: '2023-01' });
  });

  it('applies Year, This period and FY changes', async () => {
    const user = userEvent.setup();
    render(<ControlledPeriod initial={{ fy: '2022-23', month: '2022-10' }} />);
    const chip = screen.getByRole('button', { name: /change period/ });
    expect(chip.getAttribute('aria-label')).toBe('Period: FY 2022–23, October 2022, change period');
    await user.click(chip);
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'October 2022' }));

    // FY change keeps the month position and the popover open.
    await user.click(screen.getByRole('combobox', { name: 'Financial year' }));
    await user.click(screen.getByRole('option', { name: 'FY 2023–24' }));
    expect(period()).toEqual({ fy: '2023-24', month: '2023-10' });
    expect(screen.getByRole('dialog', { name: 'Choose period' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'This period, FY 2022–23, quarter 3' }));
    expect(period()).toEqual({ fy: '2022-23', quarter: 3 });

    await user.click(chip);
    await user.click(screen.getByRole('combobox', { name: 'Financial year' }));
    await user.click(screen.getByRole('option', { name: 'FY 2021–22' }));
    expect(period()).toEqual({ fy: '2021-22', quarter: 3 });
    await user.click(screen.getByRole('radio', { name: 'Year' }));
    expect(period()).toEqual({ fy: '2021-22' });
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(chip);
    expect(screen.queryByRole('radiogroup', { name: /Quarter|Month/ })).toBeNull();
    await user.click(screen.getByRole('combobox', { name: 'Financial year' }));
    await user.click(screen.getByRole('option', { name: 'FY 2022–23' }));
    expect(period()).toEqual({ fy: '2022-23' });
  });

  it('respects a January FY start and hides the shortcut without thisPeriod', async () => {
    const user = userEvent.setup();
    render(
      <ControlledPeriod
        initial={{ fy: '2022-23', quarter: 1 }}
        fyStartMonth={1}
        thisPeriod={undefined}
      />,
    );
    await user.click(screen.getByRole('button', { name: /change period/ }));
    expect(screen.getByRole('radio', { name: /^Quarter 1/ }).textContent).toBe('Q1 Jan–Mar');
    expect(screen.queryByRole('button', { name: /This period/ })).toBeNull();
  });
});

function ControlledDate(props: Partial<Parameters<typeof DateInput>[0]>) {
  const [value, setValue] = useState<string | null>(props.value ?? null);
  return (
    <>
      <DateInput
        label="Due date"
        today="2027-03-10"
        {...props}
        value={value}
        onValueChange={setValue}
      />
      <output data-testid="date">{value ?? 'none'}</output>
    </>
  );
}

const dateValue = () => screen.getByTestId('date').textContent;

describe('DateInput', () => {
  it('reads typed dates, shows them as "31 Mar 2027" and explains bad input', async () => {
    const user = userEvent.setup();
    render(<ControlledDate />);
    const input = screen.getByRole('textbox', { name: 'Due date' });
    expect(screen.getByRole('textbox', { description: 'For example 31 Mar 2027' })).toBe(input);

    await user.type(input, '31/03/2027{Enter}');
    expect(dateValue()).toBe('2027-03-31');
    expect((input as HTMLInputElement).value).toBe('31 Mar 2027');

    await user.clear(input);
    await user.type(input, 'next week');
    await user.tab();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter a date like 31 Mar 2027.')).toBeTruthy();
    expect(dateValue()).toBe('2027-03-31');

    await user.clear(input);
    await user.tab();
    expect(dateValue()).toBe('none');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    await expectNoAxeViolations();
  });

  it('rejects dates outside min and max', async () => {
    const user = userEvent.setup();
    render(<ControlledDate min="2027-04-01" max="2028-03-31" />);
    const input = screen.getByRole('textbox', { name: 'Due date' });
    await user.type(input, '31 Mar 2027{Enter}');
    expect(screen.getByText('Choose a date between 1 Apr 2027 and 31 Mar 2028.')).toBeTruthy();
    expect(dateValue()).toBe('none');
  });

  it('words single-sided ranges', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ControlledDate min="2027-04-01" />);
    await user.type(screen.getByRole('textbox'), '1/1/2027{Enter}');
    expect(screen.getByText('Choose 1 Apr 2027 or later.')).toBeTruthy();
    unmount();
    render(<ControlledDate max="2027-04-01" />);
    await user.type(screen.getByRole('textbox'), '1/1/2028{Enter}');
    expect(screen.getByText('Choose 1 Apr 2027 or earlier.')).toBeTruthy();
  });

  it('picks a date from the calendar with the keyboard', async () => {
    const user = userEvent.setup();
    render(<ControlledDate max="2027-04-30" />);
    await user.click(screen.getByRole('button', { name: 'Choose due date from calendar' }));
    const grid = screen.getByRole('grid', { name: 'March 2027' });
    const today = within(grid).getByRole('button', { name: '10 March 2027' });
    expect(today.getAttribute('aria-current')).toBe('date');
    expect(document.activeElement).toBe(today);
    expect(within(grid).getAllByRole('columnheader')[0]!.getAttribute('abbr')).toBe('Monday');

    await user.keyboard('{ArrowRight}{ArrowDown}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('18 March 2027');
    await user.keyboard('{ArrowLeft}{ArrowUp}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('10 March 2027');
    await user.keyboard('{Home}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('8 March 2027');
    await user.keyboard('{End}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('14 March 2027');
    await user.keyboard('{PageDown}');
    expect(screen.getByRole('grid', { name: 'April 2027' })).toBeTruthy();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('14 April 2027');
    await user.keyboard('{Shift>}{PageDown}{/Shift}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('14 April 2028');
    expect(document.activeElement?.getAttribute('aria-disabled')).toBe('true');
    await user.keyboard('{Enter}');
    expect(dateValue()).toBe('none');
    await user.keyboard('{Shift>}{PageUp}{/Shift}{PageUp}');
    await user.keyboard('{Enter}');
    expect(dateValue()).toBe('2027-03-14');
    expect(screen.queryByRole('grid')).toBeNull();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('14 Mar 2027');
  });

  it('marks the selected day and pages months with the buttons', async () => {
    const user = userEvent.setup();
    render(<ControlledDate value="2027-03-31" />);
    await user.click(screen.getByRole('button', { name: /from calendar/ }));
    const selected = screen.getByRole('button', { name: '31 March 2027' });
    expect(selected.closest('td')!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(selected);
    const next = screen.getByRole('button', { name: 'Next month' });
    await user.click(next);
    expect(screen.getByRole('grid', { name: 'April 2027' })).toBeTruthy();
    expect(document.activeElement).toBe(next);
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    await user.click(screen.getByRole('button', { name: '1 March 2027' }));
    expect(dateValue()).toBe('2027-03-01');
    await expectNoAxeViolations();
  });

  it('follows value changes from the form and opens the calendar with Alt+ArrowDown', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DateInput label="Due date" value="2027-03-31" onValueChange={() => {}} />,
    );
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('31 Mar 2027');
    rerender(<DateInput label="Due date" value="2027-04-30" onValueChange={() => {}} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('30 Apr 2027');
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await act(async () => {});
    expect(screen.getByRole('grid', { name: 'April 2027' })).toBeTruthy();
  });
});
