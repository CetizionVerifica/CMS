import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { CRITICALITY_ORDER, CriticalityTag } from './CriticalityTag';
import { DERIVED_STATUSES, StatusPill, statusLabel } from './StatusPill';

describe('statusLabel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the fixed vocabulary', () => {
    expect(DERIVED_STATUSES.map((s) => statusLabel(s, 3).visible)).toEqual([
      'Upcoming',
      'Due in 3 days',
      'Overdue 3 days',
      'Awaiting approval',
      'Sent back',
      'Complied',
      'Complied late',
      'Not applicable',
    ]);
  });
  it('words day counts for today, tomorrow, singular and above 99', () => {
    expect(statusLabel('DUE_SOON', 0).visible).toBe('Due today');
    expect(statusLabel('DUE_SOON', 1).visible).toBe('Due tomorrow');
    expect(statusLabel('OVERDUE', 1).visible).toBe('Overdue 1 day');
    expect(statusLabel('OVERDUE', 120)).toEqual({
      visible: 'Overdue 99+ days',
      full: 'Overdue 120 days',
    });
  });
  it('falls back and warns when days are missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(statusLabel('DUE_SOON').visible).toBe('Due soon');
    expect(statusLabel('OVERDUE').visible).toBe('Overdue');
    expect(warn).toHaveBeenCalledTimes(2);
  });
  it('falls back and warns when an overdue count is zero or negative (audit #8d)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(statusLabel('OVERDUE', 0).full).toBe('Overdue');
    expect(statusLabel('OVERDUE', -2).visible).toBe('Overdue');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toContain('days=0');
  });
});

describe('StatusPill', () => {
  it('renders every status as text, with tone classes and an aria-hidden dot', async () => {
    render(
      <div>
        {DERIVED_STATUSES.map((s) => (
          <StatusPill key={s} status={s} days={12} />
        ))}
      </div>,
    );
    const overdue = screen.getByText('Overdue 12 days');
    expect(overdue.className).toContain('bg-crit-soft');
    expect(overdue.className).toContain('text-crit-ink');
    expect(overdue.querySelector('[aria-hidden]')?.className).toContain('bg-crit');
    // Complied late: ok pill, warn dot.
    const late = screen.getByText('Complied late');
    expect(late.className).toContain('bg-ok-soft');
    expect(late.querySelector('[aria-hidden]')?.className).toContain('bg-warn');
    // Not applicable: hollow ring.
    expect(screen.getByText('Not applicable').querySelector('[aria-hidden]')?.className).toContain(
      'border-line-strong',
    );
    await expectNoAxeViolations();
  });

  it('abbreviates 120 days visibly but reads the exact count, with a due-date title', () => {
    render(<StatusPill status="OVERDUE" days={120} dueDate="2027-03-31" />);
    const pill = screen.getByTitle('Overdue 120 days · Due 31 Mar 2027');
    expect(pill.textContent).toBe('Overdue 99+ daysOverdue 120 days');
    expect(screen.getByText('Overdue 120 days').className).toBe('sr-only');
  });

  it('shows an icon in md with withIcon, a dot in sm', () => {
    const { container, rerender } = render(<StatusPill status="COMPLIED" withIcon />);
    expect(container.querySelector('svg')).not.toBeNull();
    rerender(<StatusPill status="COMPLIED" withIcon size="sm" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.firstElementChild?.className).toContain('h-5');
  });
});

describe('CriticalityTag', () => {
  it('labels every level in enum order, with the icon only on super critical', async () => {
    render(
      <div>
        {CRITICALITY_ORDER.map((l) => (
          <CriticalityTag key={l} level={l} size={l === 'LOW' ? 'sm' : 'md'} />
        ))}
      </div>,
    );
    const tags = CRITICALITY_ORDER.map((_, i) => document.body.querySelectorAll('div > span')[i]!);
    expect(tags.map((t) => t.textContent)).toEqual([
      'Super critical',
      'Critical',
      'High',
      'Medium',
      'Low',
    ]);
    expect(tags[0]!.querySelector('svg')).not.toBeNull();
    expect(tags[1]!.querySelector('svg')).toBeNull();
    expect(tags[0]!.className).toContain('rounded-tag');
    expect(tags[1]!.className).toContain('border-crit');
    expect(tags[2]!.className).toContain('text-warn-ink');
    await expectNoAxeViolations();
  });

  it('can announce a prefix in free text', () => {
    render(<CriticalityTag level="HIGH" announcePrefix />);
    expect(screen.getByText('Criticality:', { exact: false }).className).toBe('sr-only');
  });
});
