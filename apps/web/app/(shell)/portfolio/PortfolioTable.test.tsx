import { DerivedStatus, LocalDate, type PortfolioRow } from '@canopy/contracts';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { portfolioItems } from './portfolio-model';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { PortfolioTable } = await import('./PortfolioTable');

const id = (n: number) => `00000000-0000-5000-8000-${n.toString(16).padStart(12, '0')}`;

function row(
  n: number,
  name: string,
  overdue: number,
  score: number | null,
  lastActivityAt: string | null,
): PortfolioRow {
  const counts = Object.fromEntries(
    DerivedStatus.options.map((s) => [s, 0]),
  ) as PortfolioRow['result']['counts'];
  const instanceIds = Object.fromEntries(
    DerivedStatus.options.map((s) => [s, [] as string[]]),
  ) as PortfolioRow['result']['instanceIds'];
  counts.OVERDUE = overdue;
  instanceIds.OVERDUE = Array.from({ length: overdue }, (_, i) => id(0x9000 + n * 100 + i));
  return {
    clientId: id(n),
    clientName: name,
    result: {
      engineVersion: 't',
      asOf: LocalDate.parse('2023-03-15'),
      score,
      onTimeRate: null,
      counts,
      instanceIds,
    },
    dueThisWeek: n + 1,
    lastActivityAt,
  };
}

function renderTable() {
  const items = portfolioItems(
    [
      row(1, 'Alpha Metals', 0, null, null),
      row(2, 'Beta Foods', 4, 72.4, '2023-03-14T10:00:00.000Z'),
    ],
    { [id(2)]: 'Asia/Kolkata' },
  );
  render(<PortfolioTable items={items} />);
  return screen.getByRole('table', { name: 'Clients' });
}

describe('PortfolioTable', () => {
  it('has the columns in the order a phone needs them', () => {
    const table = renderTable();
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent?.trim()),
    ).toEqual(['Client', 'Overdue', 'Due this week', 'Score', 'Last activity']);
  });

  it('links each client to its overview and the overdue count to the filtered register', () => {
    const table = renderTable();
    expect(within(table).getByRole('link', { name: 'Beta Foods' }).getAttribute('href')).toBe(
      `/c/${id(2)}/overview`,
    );
    const overdue = within(table).getByRole('link', {
      name: '4 overdue at Beta Foods, view in register',
    });
    expect(overdue.getAttribute('href')).toBe(`/c/${id(2)}/register?status=OVERDUE`);
    expect(overdue.textContent).toBe('4');
  });

  it('shows zero overdue as plain text, not a link', () => {
    const table = renderTable();
    expect(within(table).queryByRole('link', { name: /overdue at Alpha Metals/ })).toBeNull();
    const alpha = within(table).getByRole('link', { name: 'Alpha Metals' }).closest('tr')!;
    expect(within(alpha).getByText('0')).toBeTruthy();
  });

  it('shows the score from the API, or that nothing is due', () => {
    const table = renderTable();
    const beta = within(table).getByRole('link', { name: 'Beta Foods' }).closest('tr')!;
    expect(within(beta).getByText('72%')).toBeTruthy();
    expect(within(beta).getByRole('img', { name: /Beta Foods compliance score/ })).toBeTruthy();
    const alpha = within(table).getByRole('link', { name: 'Alpha Metals' }).closest('tr')!;
    expect(within(alpha).getByText('No items due')).toBeTruthy();
  });

  it('shows last activity in the client time zone, or that there is none', () => {
    const table = renderTable();
    const beta = within(table).getByRole('link', { name: 'Beta Foods' }).closest('tr')!;
    expect(within(beta).getByText('14 Mar 2023, 15:30 IST')).toBeTruthy();
    const alpha = within(table).getByRole('link', { name: 'Alpha Metals' }).closest('tr')!;
    expect(within(alpha).getByText('No activity yet')).toBeTruthy();
  });

  it('shows due this week as a number when the API does not say which rows it counted', () => {
    const table = renderTable();
    const beta = within(table).getByRole('link', { name: 'Beta Foods' }).closest('tr')!;
    expect(within(beta).getByText('3')).toBeTruthy();
    expect(within(table).queryByRole('link', { name: /due this week/ })).toBeNull();
  });

  it('links due this week to the register filtered to those rows, saying Law with the ISO add-on', () => {
    const filter = {
      dueFrom: LocalDate.parse('2023-03-15'),
      dueTo: LocalDate.parse('2023-03-21'),
      workflowState: ['OPEN' as const, 'SENT_BACK' as const],
    };
    const items = portfolioItems(
      [
        { ...row(1, 'Alpha Metals', 0, null, null), dueThisWeek: 0, dueThisWeekFilter: filter },
        { ...row(2, 'Beta Foods', 4, 72.4, null), dueThisWeekFilter: filter },
      ],
      {},
      ['isoManagement'],
    );
    render(<PortfolioTable items={items} />);
    const table = screen.getByRole('table', { name: 'Clients' });
    const due = within(table).getByRole('link', {
      name: '3 due this week at Beta Foods, view in register',
    });
    expect(due.getAttribute('href')).toBe(
      `/c/${id(2)}/register?workflowState=OPEN%2CSENT_BACK&dueFrom=2023-03-15&dueTo=2023-03-21&source=LAW`,
    );
    expect(due.textContent).toBe('3');
    expect(within(table).queryByRole('link', { name: /due this week at Alpha Metals/ })).toBeNull();
  });
});
