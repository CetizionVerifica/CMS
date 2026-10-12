import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { KpiCard } from './KpiCard';
import { ProgressBar } from './ProgressBar';
import { ScoreRing } from './ScoreRing';

afterEach(() => vi.restoreAllMocks());

describe('ScoreRing', () => {
  it('names the score and draws the arc', async () => {
    const { container } = render(<ScoreRing value={78} label="Compliance score" />);
    expect(screen.getByRole('img', { name: 'Compliance score: 78%' })).toBeTruthy();
    const fill = container.querySelector('[data-part="fill"]')!;
    expect(fill.getAttribute('class')).toContain('stroke-forest');
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    const r = (58 - 7) / 2;
    expect(Number(fill.getAttribute('stroke-dashoffset'))).toBeCloseTo(2 * Math.PI * r * 0.22, 3);
    await expectNoAxeViolations();
  });

  it('shows "no score yet" with a dashed track and centre dash when null', () => {
    const { container } = render(<ScoreRing value={null} size="lg" label="Compliance score" />);
    expect(screen.getByRole('img', { name: 'Compliance score: no score yet' })).toBeTruthy();
    expect(container.querySelector('circle')!.getAttribute('stroke-dasharray')).toBe('4 4');
    expect(container.textContent).toBe('—');
  });

  it('uses the band in status tone, shows the centre value at lg and clamps out-of-range values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = render(
      <ScoreRing value={140} size="lg" tone="status" band="crit" label="Score" />,
    );
    expect(screen.getByRole('img', { name: 'Score: 100%' })).toBeTruthy();
    expect(container.querySelector('[data-part="fill"]')!.getAttribute('class')).toContain(
      'stroke-crit',
    );
    expect(container.textContent).toBe('100%');
    expect(warn).toHaveBeenCalled();
  });

  it('draws no fill at zero', () => {
    const { container } = render(<ScoreRing value={0} size="sm" label="Score" />);
    expect(container.querySelector('[data-part="fill"]')).toBeNull();
  });
});

describe('ProgressBar', () => {
  it('single: a named progressbar with percent text', async () => {
    render(<ProgressBar label="Human resources" value={82} showLabel />);
    const bar = screen.getByRole('progressbar', { name: 'Human resources' });
    expect(bar.getAttribute('aria-valuenow')).toBe('82');
    expect(bar.getAttribute('aria-valuetext')).toBe('82%');
    expect(screen.getByText('82%')).toBeTruthy();
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('82%');
    await expectNoAxeViolations();
  });

  it('tone: band fill and count text; clamps above max', () => {
    render(
      <ProgressBar
        variant="tone"
        band="warn"
        label="EHS"
        value={250}
        max={208}
        valueFormat="count"
        width="table"
      />,
    );
    const bar = screen.getByRole('progressbar', { name: 'EHS' });
    expect(bar.getAttribute('aria-valuetext')).toBe('250 of 208');
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.className).toContain('bg-warn');
    expect(fill.style.width).toBe('100%');
    // aria-valuenow stays inside min and max (audit #8c); the text keeps the real count.
    expect(bar.getAttribute('aria-valuenow')).toBe('208');
  });

  it('clamps a negative value and a negative max for assistive tech (audit #8c)', () => {
    render(<ProgressBar label="Tax" value={-4} max={-1} />);
    const bar = screen.getByRole('progressbar', { name: 'Tax' });
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('0');
  });

  it('zero max shows 0% and an empty track; value can be hidden', () => {
    render(<ProgressBar label="Legal" value={0} max={0} showValue={false} />);
    const bar = screen.getByRole('progressbar', { name: 'Legal' });
    expect(bar.getAttribute('aria-valuetext')).toBe('0%');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('0%');
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('stacked: segments in ok, warn, crit, neutral order with a full sentence and a text legend', async () => {
    const { container } = render(
      <ProgressBar
        variant="stacked"
        label="Human resources"
        segments={[
          { key: 'neutral', label: 'Not applicable', count: 2 },
          { key: 'crit', label: 'Overdue', count: 8 },
          { key: 'ok', label: 'Complied', count: 120 },
          { key: 'warn', label: 'Due soon', count: 30 },
        ]}
      />,
    );
    expect(
      screen.getByRole('img', {
        name: 'Human resources: 120 complied, 30 due soon, 8 overdue, 2 not applicable',
      }),
    ).toBeTruthy();
    expect(
      [...container.querySelectorAll('[data-segment]')].map((s) => s.getAttribute('data-segment')),
    ).toEqual(['ok', 'warn', 'crit', 'neutral']);
    expect(container.querySelectorAll('li')).toHaveLength(4);
    await expectNoAxeViolations();
  });

  it('stacked: hides zero segments, can drop the legend, and renders an empty track for no data', () => {
    const { container, rerender } = render(
      <ProgressBar
        variant="stacked"
        label="Tax"
        legend="none"
        segments={[
          { key: 'ok', label: 'Complied', count: 3 },
          { key: 'crit', label: 'Overdue', count: 0 },
        ]}
      />,
    );
    expect(container.querySelectorAll('[data-segment]')).toHaveLength(1);
    expect(container.querySelector('li')).toBeNull();
    rerender(
      <ProgressBar
        variant="stacked"
        label="Tax"
        legend="none"
        segments={[{ key: 'ok', label: 'Complied', count: 0 }]}
      />,
    );
    expect(container.querySelectorAll('[data-segment]')).toHaveLength(0);
  });

  it('loading shows a pulsing track', () => {
    render(<ProgressBar label="EHS" value={10} loading showLabel />);
    expect(screen.getByRole('progressbar', { name: 'EHS: loading' })).toBeTruthy();
  });
});

describe('KpiCard', () => {
  it('as a link reads label, value and context in order and is reachable by Tab', async () => {
    const user = userEvent.setup();
    render(
      <KpiCard
        label="Overdue"
        value={5}
        context={{ text: '2 super critical', tone: 'crit' }}
        href="/c/1/register?status=OVERDUE"
      />,
    );
    await user.tab();
    const link = screen.getByRole('link', {
      name: 'Overdue, 5, 2 super critical. View in register',
    });
    expect(document.activeElement).toBe(link);
    expect(link.getAttribute('href')).toBe('/c/1/register?status=OVERDUE');
    expect(screen.getByText('2 super critical').className).toContain('text-crit-ink');
    await expectNoAxeViolations();
  });

  it('formats numbers, shows a unit and a trend that is spoken in words', () => {
    render(
      <KpiCard
        label="Open"
        value={100000}
        unit="of 424"
        context={{ text: '6 pts this month', tone: 'ok', trend: 'up' }}
        href="/x"
        linkHint="Open register"
      />,
    );
    expect(
      screen.getByRole('link', {
        name: 'Open, 1,00,000 of 424, up 6 pts this month. Open register',
      }),
    ).toBeTruthy();
    expect(screen.getByText('1,00,000').className).toContain('text-[22px]');
  });

  it('without href it is not a link; a down trend and a string value render as given', () => {
    render(
      <KpiCard
        label="Awaiting approval"
        value="7"
        context={{ text: '3 fewer than last week', trend: 'down' }}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('7').className).toContain('text-kpi');
    expect(screen.getByText('down', { exact: false }).className).toBe('sr-only');
  });

  it('shows a skeleton while loading and an error with Retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(<KpiCard label="Open" value={0} loading />);
    expect(screen.getByRole('status').textContent).toBe('Loading Open');
    rerender(<KpiCard label="Open" value={0} error="Couldn't load" onRetry={onRetry} href="/x" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(<KpiCard label="Open" value={0} error="Couldn't load" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('accepts a visual and a custom link renderer', () => {
    render(
      <KpiCard
        label="Compliance score"
        value="78%"
        visual={<ScoreRing value={78} label="Compliance score" />}
        href="/score"
        renderLink={({ children, ...p }) => (
          <a data-router="1" {...p}>
            {children}
          </a>
        )}
      />,
    );
    expect(screen.getByRole('link').getAttribute('data-router')).toBe('1');
  });
});
