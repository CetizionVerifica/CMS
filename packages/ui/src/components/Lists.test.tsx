import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { DeadlineList, type DeadlineItem } from './DeadlineList';
import { TaskList, type TaskItem } from './TaskList';

const deadlines: DeadlineItem[] = [
  {
    id: '1',
    dueDate: '2027-03-10',
    title: 'Monthly PF challan',
    meta: 'Belur · Priya Rane',
    status: 'DUE_SOON',
    days: 0,
    href: '/i/1',
  },
  { id: '2', dueDate: '2027-03-14', title: 'TDS return', status: 'UPCOMING', href: '/i/2' },
  {
    id: '3',
    dueDate: '2027-03-17',
    title: 'Fire safety audit',
    status: 'OVERDUE',
    days: 2,
    href: '/i/3',
  },
  { id: '4', dueDate: '2027-04-02', title: 'Consent renewal', href: '/i/4' },
  { id: '5', dueDate: '2027-04-10', title: 'Annual return', href: '/i/5' },
  { id: '6', dueDate: '2027-04-11', title: 'Half-yearly report', href: '/i/6' },
];

describe('DeadlineList', () => {
  it('names each item with its date and status and hides the date block', async () => {
    render(<DeadlineList items={deadlines} viewAllHref="/calendar" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Upcoming' })).toBeTruthy();
    const links = within(screen.getAllByRole('list')[0]!).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual([
      'Monthly PF challan, due 10 Mar 2027, Due today',
      'TDS return, due 14 Mar 2027, Upcoming',
      'Fire safety audit, due 17 Mar 2027, Overdue 2 days',
      'Consent renewal, due 2 Apr 2027',
      'Annual return, due 10 Apr 2027',
    ]);
    expect(links[0]!.querySelector('[aria-hidden]')!.textContent).toBe('10Mar');
    // Pills only for due soon and overdue.
    expect(links[0]!.textContent).toContain('Due today');
    expect(links[1]!.textContent).not.toContain('Upcoming');
    expect(links[0]!.textContent).toContain('Belur · Priya Rane');
    expect(screen.getByRole('link', { name: '+ 1 more' }).getAttribute('href')).toBe('/calendar');
    expect(screen.getByRole('link', { name: 'View calendar' })).toBeTruthy();
    await expectNoAxeViolations();
  });

  it('groups by week from the API today', () => {
    render(
      <DeadlineList
        items={deadlines}
        groupBy="week"
        today="2027-03-10"
        max={10}
        headingLevel={3}
      />,
    );
    expect(screen.getByRole('heading', { level: 3 })).toBeTruthy();
    expect(screen.getAllByText(/^(This week|Next week|Later)$/).map((e) => e.textContent)).toEqual([
      'This week',
      'Next week',
      'Later',
    ]);
    expect(screen.getAllByRole('list')).toHaveLength(3);
    expect(screen.queryByRole('link', { name: /more$/ })).toBeNull();
  });

  it('keeps one group per week when items arrive out of order', () => {
    const shuffled = [deadlines[2]!, deadlines[0]!, deadlines[4]!, deadlines[1]!];
    render(<DeadlineList items={shuffled} groupBy="week" today="2027-03-10" />);
    expect(screen.getAllByText(/^(This week|Next week|Later)$/).map((e) => e.textContent)).toEqual([
      'This week',
      'Next week',
      'Later',
    ]);
    const [thisWeek, nextWeek] = screen.getAllByRole('list');
    expect(within(thisWeek!).getAllByRole('link')).toHaveLength(2);
    expect(within(nextWeek!).getAllByRole('link')).toHaveLength(1);
  });

  it('puts items due before today under Overdue, first (audit #7)', () => {
    const late: DeadlineItem = {
      id: '0',
      dueDate: '2027-03-08',
      title: 'Shops act renewal',
      status: 'OVERDUE',
      days: 2,
      href: '/i/0',
    };
    render(<DeadlineList items={[deadlines[0]!, late]} groupBy="week" today="2027-03-10" />);
    expect(screen.getAllByText(/^(Overdue|This week)$/).map((e) => e.textContent)).toEqual([
      'Overdue',
      'This week',
    ]);
    const [overdue, thisWeek] = screen.getAllByRole('list');
    expect(within(overdue!).getByRole('link').getAttribute('aria-label')).toBe(
      'Shops act renewal, due 8 Mar 2027, Overdue 2 days',
    );
    expect(within(thisWeek!).getByRole('link').getAttribute('aria-label')).toMatch(
      /^Monthly PF challan/,
    );
  });

  it('warns once and does not group when week grouping has no today', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { rerender } = render(<DeadlineList items={deadlines} groupBy="week" />);
    rerender(<DeadlineList items={deadlines.slice(1)} groupBy="week" />);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('needs `today`');
    expect(screen.queryByText(/^(Overdue|This week|Next week|Later)$/)).toBeNull();
    expect(screen.getAllByRole('list')).toHaveLength(1);
    warn.mockRestore();
  });

  it('shows loading and empty states', () => {
    const { rerender } = render(<DeadlineList items={[]} loading />);
    expect(screen.getByText('Loading upcoming')).toBeTruthy();
    rerender(<DeadlineList items={[]} />);
    expect(screen.getByRole('heading', { name: 'Nothing due in this period.' })).toBeTruthy();
  });
});

const tasks: TaskItem[] = [
  {
    id: 'a',
    title: 'Tax collection at source return',
    meta: 'Income Tax',
    dueDate: '2026-10-18',
    status: 'OVERDUE',
    days: 3,
    href: '/i/a',
  },
  {
    id: 'b',
    title: 'Monthly PF challan',
    meta: 'EPF',
    dueDate: '2026-10-20',
    status: 'SENT_BACK',
    href: '/i/b',
  },
  {
    id: 'c',
    title: 'Fire safety audit',
    meta: 'Factories',
    dueDate: '2026-10-25',
    status: 'SUBMITTED',
    href: '/i/c',
  },
  {
    id: 'd',
    title: 'Annual return',
    meta: 'Factories',
    dueDate: '2026-11-02',
    status: 'UPCOMING',
    href: '/i/d',
  },
];

describe('TaskList', () => {
  it('shows a state marker (not a checkbox), the meta line and a tone word', async () => {
    const { container } = render(
      <TaskList label="My open items" items={tasks} max={3} viewAllHref="/mine" />,
    );
    const list = screen.getByRole('list', { name: 'My open items' });
    expect(within(list).queryAllByRole('checkbox')).toHaveLength(0);
    expect(
      [...container.querySelectorAll('[data-marker]')].map((m) => m.getAttribute('data-marker')),
    ).toEqual(['attention', 'attention', 'waiting']);
    const links = within(list).getAllByRole('link');
    expect(links[0]!.getAttribute('aria-label')).toBe(
      'Tax collection at source return, due 18 Oct 2026, Overdue 3 days',
    );
    expect(links[0]!.textContent).toContain('Income Tax · due 18 Oct · overdue');
    expect(links[1]!.textContent).toContain('sent back');
    expect(links[2]!.textContent).toContain('awaiting approval');
    expect(screen.getByRole('link', { name: 'View all 4' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    await expectNoAxeViolations();
  });

  it('moves with J/K and approves or sends back with A/S in approver mode', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const onSendBack = vi.fn();
    render(
      <TaskList
        label="Approvals"
        mode="approver"
        items={tasks}
        onApprove={onApprove}
        onSendBack={onSendBack}
      />,
    );
    const links = within(screen.getByRole('list')).getAllByRole('link');
    expect(links[2]!.textContent).toContain('awaiting your approval');
    links[0]!.focus();
    await user.keyboard('j');
    expect(document.activeElement).toBe(links[1]);
    await user.keyboard('jjj');
    expect(document.activeElement).toBe(links[3]);
    await user.keyboard('k');
    expect(document.activeElement).toBe(links[2]);
    await user.keyboard('a');
    expect(onApprove).toHaveBeenCalledWith('c');
    await user.keyboard('s');
    expect(onSendBack).toHaveBeenCalledWith('c');
    await user.keyboard('x');
    await user.click(screen.getByRole('button', { name: 'Approve Monthly PF challan' }));
    expect(onApprove).toHaveBeenLastCalledWith('b');
    await user.click(screen.getByRole('button', { name: 'Send back Annual return' }));
    expect(onSendBack).toHaveBeenLastCalledWith('d');

    links[0]!.focus();
    await user.keyboard('?');
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' }).textContent).toContain(
      'Send back',
    );
    await expectNoAxeViolations();
  });

  it('dims processing rows and moves focus to the next row when one is removed', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    function Inbox() {
      const [items, setItems] = useState(tasks);
      return (
        <TaskList
          label="Approvals"
          mode="approver"
          items={items}
          processingIds={['d']}
          onApprove={(id) => {
            onApprove(id);
            setItems((xs) => xs.filter((x) => x.id !== id));
          }}
        />
      );
    }
    render(<Inbox />);
    const row = screen.getByRole('link', { name: /^Annual return/ }).closest('li')!;
    expect(row.className).toContain('opacity-60');
    expect(screen.getByRole('button', { name: 'Approve Annual return' })).toHaveProperty(
      'disabled',
      true,
    );
    screen.getByRole('link', { name: /^Annual return/ }).focus();
    await user.keyboard('a');
    expect(onApprove).not.toHaveBeenCalled();

    screen.getByRole('link', { name: /^Monthly PF/ }).focus();
    await user.keyboard('a');
    expect(onApprove).toHaveBeenCalledWith('b');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /^Fire safety/ }));
  });

  it('shows loading and both empty states', () => {
    const { rerender } = render(<TaskList label="My open items" items={[]} loading />);
    expect(screen.getByText('Loading my open items')).toBeTruthy();
    rerender(<TaskList label="My open items" items={[]} />);
    expect(screen.getByRole('heading', { name: "You're all caught up." })).toBeTruthy();
    rerender(<TaskList label="Approvals" mode="approver" items={[]} />);
    expect(
      screen.getByRole('heading', { name: 'Nothing waiting for your approval.' }),
    ).toBeTruthy();
  });
});
