import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { overviewModel } from './overview-model';
import { breakdown, CLIENT, id, instance, overview, result } from './test-data';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { OverviewView } = await import('./OverviewView');

const reg = `/c/${CLIENT}/register`;

function full() {
  return overviewModel({
    clientId: CLIENT,
    overview: overview(
      result({ UPCOMING: 3, DUE_SOON: 1, OVERDUE: 2, SUBMITTED: 1, COMPLIED: 4 }, 62.5, 75),
      [instance(1, { status: 'OVERDUE', overdueDays: 3, title: 'Fire drill record' })],
      [instance(2, { title: 'Monthly PF challan', actName: 'EPF Act' })],
    ),
    byDepartment: breakdown('department', [
      { key: id(1), label: 'EHS', result: result({ OVERDUE: 2, COMPLIED: 1 }, 40) },
      { key: id(2), label: 'IT', result: result({}, null) },
    ]),
    byAct: breakdown('act', [
      { key: id(3), label: 'Factories Act, 1948', result: result({ OVERDUE: 2, COMPLIED: 3 }) },
    ]),
    byCriticality: breakdown('criticality', []),
  });
}

describe('OverviewView', () => {
  it('shows the four KPI cards, each linking to its rows in the register', () => {
    render(<OverviewView model={full()} />);
    const score = screen.getByRole('link', { name: /Compliance score/ });
    expect(score.getAttribute('href')).toBe(`${reg}?status=COMPLIED%2CCOMPLIED_LATE`);
    expect(
      screen
        .getByRole('link', { name: '75% complied on time, open the instances complied on time' })
        .getAttribute('href'),
    ).toBe(`${reg}?status=COMPLIED`);
    expect(
      screen
        .getByRole('link', { name: '1 due soon, open the instances due soon' })
        .getAttribute('href'),
    ).toBe(`${reg}?status=DUE_SOON`);
    expect(screen.getByRole('img', { name: /Compliance score/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open these instances/ }).getAttribute('href')).toBe(
      `${reg}?status=UPCOMING%2CDUE_SOON%2COVERDUE`,
    );
    const overdue = screen.getByRole('link', { name: /^Overdue/ });
    expect(overdue.getAttribute('href')).toBe(`${reg}?status=OVERDUE`);
    expect(overdue.textContent).toContain('Needs action');
    expect(screen.getByRole('link', { name: /Awaiting approval/ }).getAttribute('href')).toBe(
      `${reg}?status=SUBMITTED`,
    );
  });

  it('lists departments with readiness, and links the overdue and complied counts', () => {
    render(<OverviewView model={full()} />);
    const table = screen.getByRole('table', { name: 'Readiness by department' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent?.trim()),
    ).toEqual(['Department', 'Overdue', 'Readiness', 'Complied']);
    expect(within(table).getByRole('link', { name: 'EHS' }).getAttribute('href')).toBe(
      `${reg}?departmentId=${id(1)}`,
    );
    expect(
      within(table)
        .getByRole('link', { name: '2 overdue in EHS, open these instances' })
        .getAttribute('href'),
    ).toBe(`${reg}?departmentId=${id(1)}&status=OVERDUE`);
    expect(
      within(table)
        .getByRole('link', { name: '1 complied in EHS, open these instances' })
        .getAttribute('href'),
    ).toBe(`${reg}?departmentId=${id(1)}&status=COMPLIED%2CCOMPLIED_LATE`);
    const it = within(table).getByRole('link', { name: 'IT' }).closest('tr')!;
    expect(within(it).getByText('No items due')).toBeTruthy();
    expect(within(it).getAllByText('0')).toHaveLength(2);
  });

  it('shows Acts, upcoming deadlines and my open items with their links', () => {
    render(<OverviewView model={full()} />);
    expect(screen.getByRole('heading', { name: 'Status by Act' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Factories Act, 1948' }).getAttribute('href')).toBe(
      `${reg}?actId=${id(3)}`,
    );
    const acts = screen.getByRole('heading', { name: 'Status by Act' }).closest('section')!;
    expect(
      within(acts)
        .getByRole('link', { name: '2 overdue under Factories Act, 1948, open these instances' })
        .getAttribute('href'),
    ).toBe(`${reg}?actId=${id(3)}&status=OVERDUE`);
    expect(
      within(acts)
        .getByRole('link', { name: '3 complied under Factories Act, 1948, open these instances' })
        .getAttribute('href'),
    ).toBe(`${reg}?actId=${id(3)}&status=COMPLIED%2CCOMPLIED_LATE`);
    // Zero counts stay plain text: pending and not applicable are 0 here.
    expect(within(acts).getAllByRole('link')).toHaveLength(3);
    expect(screen.getByRole('link', { name: /Fire drill record/ }).getAttribute('href')).toBe(
      `${reg}/${id(0x7001)}`,
    );
    expect(screen.getByRole('link', { name: /Open the calendar/ }).getAttribute('href')).toBe(
      `/c/${CLIENT}/calendar`,
    );
    const mine = screen.getByRole('heading', { name: 'My open items' }).closest('section')!;
    expect(
      within(mine)
        .getByRole('link', { name: /Monthly PF challan/ })
        .getAttribute('href'),
    ).toBe(`${reg}/${id(0x7002)}`);
  });

  it('says so when a section has nothing to show', () => {
    render(
      <OverviewView
        model={overviewModel({
          clientId: CLIENT,
          overview: overview(result({})),
          byDepartment: breakdown('department', []),
          byAct: breakdown('act', []),
        })}
      />,
    );
    expect(screen.getByText('No departments have items in this period.')).toBeTruthy();
    expect(screen.getByText('No Acts have items in this period.')).toBeTruthy();
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
