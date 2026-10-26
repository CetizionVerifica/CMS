import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CLIENT_ID, makeRow } from '../../register/_test/rows';
import type { MonthDue } from '../_lib/calendar-api';

const PATH = `/c/${CLIENT_ID}/calendar`;
const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/c/00000000-0000-5000-8000-000000000101/calendar',
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { CalendarView, dayLabel } = await import('./CalendarView');
type Props = Parameters<typeof CalendarView>[0];

const due: MonthDue = {
  '2024-11-07': [
    makeRow(1, { dueDate: '2024-11-07' as never, status: 'OVERDUE', overdueDays: 8 }),
    makeRow(2, { dueDate: '2024-11-07' as never, status: 'COMPLIED' }),
    makeRow(3, {
      dueDate: '2024-11-07' as never,
      workflowState: 'SENT_BACK',
      status: 'OVERDUE',
      overdueDays: 8,
    }),
  ],
  '2024-11-15': [makeRow(4, { dueDate: '2024-11-15' as never, status: 'UPCOMING' })],
};

function renderCalendar(props: Partial<Props> = {}) {
  return render(
    <CalendarView
      clientId={CLIENT_ID}
      month="2024-11"
      today="2024-11-15"
      due={due}
      fyStartMonth={4}
      view="month"
      query="fy=2024-25&q=Q3"
      {...props}
    />,
  );
}

beforeEach(() => nav.push.mockReset());

describe('dayLabel', () => {
  it('names the day, how many fall due and how many are overdue', () => {
    expect(dayLabel('2024-11-07', due['2024-11-07']!)).toBe('7 November 2024, 3 due, 2 overdue');
    expect(dayLabel('2024-11-15', due['2024-11-15']!)).toBe('15 November 2024, 1 due');
  });
});

describe('CalendarView', () => {
  it('lays the month out Monday first, with buttons on the days that have due dates', () => {
    renderCalendar();
    expect(screen.getByRole('heading', { name: 'November 2024' })).toBeTruthy();
    expect(screen.getByText('4 instances due')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Due dates in November 2024' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    const days = within(table).getAllByRole('button');
    expect(days.map((b) => b.getAttribute('aria-label'))).toEqual([
      '7 November 2024, 3 due, 2 overdue',
      '15 November 2024, 1 due',
    ]);
    // Today is marked; at most two titles show in a cell, then "+1 more".
    expect(table.querySelector('[aria-current="date"]')!.textContent).toContain('15');
    expect(days[0]!.textContent).toContain('Obligation 1');
    expect(days[0]!.textContent).not.toContain('Obligation 3');
    expect(days[0]!.textContent).toContain('+1 more');
  });

  it('shows a chosen day’s instances, each linked to its drawer, and hides them again', async () => {
    renderCalendar();
    expect(screen.getByText('Choose a day to see what falls due.')).toBeTruthy();
    const day = screen.getByRole('button', { name: /^7 November 2024/ });
    await userEvent.click(day);
    expect(day.getAttribute('aria-pressed')).toBe('true');
    const panel = screen.getByRole('region', { name: 'Due 7 Nov 2024' });
    const links = within(panel).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'Obligation 1',
      'Obligation 2',
      'Obligation 3',
    ]);
    expect(links[0]!.getAttribute('href')).toBe(`/c/${CLIENT_ID}/register/${makeRow(1).id}`);
    expect(panel.textContent).toContain('Overdue 8 days');
    expect(panel.textContent).toContain('Complied');
    expect(panel.textContent).toContain('Sent back');
    await userEvent.click(day);
    expect(screen.queryByRole('region', { name: 'Due 7 Nov 2024' })).toBeNull();
  });

  it('moves between months through the period in the URL, across the FY boundary', async () => {
    renderCalendar({ month: '2025-03', due: {} });
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(nav.push).toHaveBeenLastCalledWith(`${PATH}?fy=2025-26&m=2025-04`, { scroll: false });
    await userEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(nav.push).toHaveBeenLastCalledWith(`${PATH}?fy=2024-25&m=2025-02`, { scroll: false });
  });

  it('switches to the list view and back, keeping the period', async () => {
    const { rerender } = renderCalendar();
    await userEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(nav.push).toHaveBeenLastCalledWith(`${PATH}?fy=2024-25&q=Q3&view=list`, {
      scroll: false,
    });
    rerender(
      <CalendarView
        clientId={CLIENT_ID}
        month="2024-11"
        today="2024-11-15"
        due={due}
        fyStartMonth={4}
        view="list"
        query="fy=2024-25&q=Q3&view=list"
      />,
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true');
    const sections = screen.getAllByRole('region');
    expect(sections.map((s) => s.querySelector('h3')!.textContent)).toEqual([
      '7 Nov 2024',
      '15 Nov 2024 · Today',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Month' }));
    expect(nav.push).toHaveBeenLastCalledWith(`${PATH}?fy=2024-25&q=Q3`, { scroll: false });
  });

  it('says when nothing falls due in the month', () => {
    renderCalendar({ due: {} });
    expect(screen.getByText('Nothing due in November 2024')).toBeTruthy();
    expect(screen.getByText('0 instances due')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('CalendarView’s Source filter (ISO add-on)', () => {
  it('is absent without the add-on', () => {
    renderCalendar();
    expect(screen.queryByRole('group', { name: 'Source' })).toBeNull();
  });

  it('writes the chosen source into the URL, keeping the period and the view', async () => {
    renderCalendar({ iso: true, query: 'fy=2024-25&m=2024-11&view=list' });
    const group = screen.getByRole('group', { name: 'Source' });
    expect(
      within(group).getByRole('button', { name: 'Law and ISO' }).getAttribute('aria-pressed'),
    ).toBe('true');
    await userEvent.click(within(group).getByRole('button', { name: 'Law' }));
    expect(nav.push).toHaveBeenLastCalledWith(`${PATH}?fy=2024-25&m=2024-11&view=list&source=LAW`, {
      scroll: false,
    });
  });

  it('keeps the source when moving months, and clears it with Law and ISO', async () => {
    renderCalendar({ iso: true, source: 'ISO', query: 'fy=2024-25&m=2024-11&source=ISO' });
    const group = screen.getByRole('group', { name: 'Source' });
    expect(within(group).getByRole('button', { name: 'ISO' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(nav.push).toHaveBeenLastCalledWith(`${PATH}?fy=2024-25&source=ISO&m=2024-12`, {
      scroll: false,
    });
    await userEvent.click(within(group).getByRole('button', { name: 'Law and ISO' }));
    expect(nav.push).toHaveBeenLastCalledWith(`${PATH}?fy=2024-25&m=2024-11`, { scroll: false });
  });
});
