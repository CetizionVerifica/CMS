import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Building2 } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { EmptyState } from './EmptyState';
import { dismissToast, durationFor, resetToasts, toast, Toaster } from './Toast';

describe('EmptyState', () => {
  it('shows the icon, heading, body and a primary action', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { container } = render(
      <EmptyState
        variant="no-results"
        title="No instances match these filters"
        body="Try removing a filter or widening the period."
        action={{ label: 'Clear filters', onClick }}
      />,
    );
    expect(
      screen.getByRole('heading', { level: 3, name: 'No instances match these filters' }),
    ).toBeTruthy();
    expect(container.querySelector('.lucide-search-x')).toBeTruthy();
    expect(container.firstElementChild!.className).toContain('p-5.5');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClick).toHaveBeenCalled();
    await expectNoAxeViolations();
  });

  it('uses an h2 and page padding at page size, with link actions', () => {
    const { container } = render(
      <EmptyState
        variant="first-use"
        size="page"
        icon={Building2}
        title="No obligations yet"
        body="Import your compliance register to get started."
        action={{ label: 'Import register', href: '/import' }}
        secondary={{ label: 'Read the guide', href: '/help/import' }}
      />,
    );
    expect(screen.getByRole('heading', { level: 2 })).toBeTruthy();
    expect(container.firstElementChild!.className).toContain('p-12');
    expect(container.querySelector('.lucide-building-2')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Import register' }).getAttribute('href')).toBe(
      '/import',
    );
    expect(screen.getByRole('link', { name: 'Read the guide' }).className).toContain('text-forest');
  });

  it('announces an error only after a user action and shows the reference', () => {
    const { rerender, container } = render(
      <EmptyState
        variant="error"
        title="Couldn't load the register"
        body="Check your connection and try again."
        errorId="7f3a9c"
        headingLevel={4}
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { level: 4 })).toBeTruthy();
    expect(screen.getByText('7f3a9c').parentElement!.textContent).toBe('Reference: 7f3a9c');
    expect(container.querySelector('[aria-hidden]')!.className).toContain('bg-crit-soft');
    rerender(<EmptyState variant="error" title="Couldn't load the register" announce />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load the register");
  });

  it('uses the ok tone for done and the sage tone otherwise', () => {
    const { container, rerender } = render(
      <EmptyState variant="done" title="You're all caught up" />,
    );
    expect(container.querySelector('[aria-hidden]')!.className).toContain('bg-ok-soft');
    rerender(<EmptyState variant="no-permission" title="You don't have access to this" />);
    expect(container.querySelector('[aria-hidden]')!.className).toContain('bg-sage');
    expect(container.querySelector('.lucide-lock')).toBeTruthy();
  });
});

describe('Toast', () => {
  afterEach(() => {
    act(() => resetToasts());
    vi.useRealTimers();
  });

  it('times toasts by tone, with at least 6s when there is an action', () => {
    expect(durationFor({ tone: 'success', message: '' })).toBe(5000);
    expect(durationFor({ tone: 'info', message: '' })).toBe(3000);
    expect(durationFor({ tone: 'warn', message: '' })).toBe(8000);
    expect(durationFor({ tone: 'error', message: '' })).toBe(Infinity);
    expect(
      durationFor({ tone: 'info', message: '', action: { label: 'Undo', onClick: () => {} } }),
    ).toBe(6000);
    expect(durationFor({ tone: 'info', message: '', duration: 1000 })).toBe(1000);
  });

  it('shows a toast with an action and a dismiss button', async () => {
    const user = userEvent.setup();
    const undo = vi.fn();
    render(<Toaster />);
    act(() => {
      toast({
        tone: 'success',
        message: 'Approved. 3 left in your queue.',
        action: { label: 'Undo', onClick: undo },
      });
    });
    expect(screen.getByText('Approved. 3 left in your queue.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalled();
    expect(screen.queryByText('Approved. 3 left in your queue.')).toBeNull();

    act(() => {
      toast({ tone: 'error', message: "Couldn't approve. Try again." });
    });
    const region = screen.getByRole('region', { name: /Notifications/ });
    expect(region.textContent).toContain("Couldn't approve. Try again.");
    await expectNoAxeViolations();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText("Couldn't approve. Try again.")).toBeNull();
  });

  it('shows the newest three and dismisses by id', () => {
    render(<Toaster />);
    let first = 0;
    act(() => {
      first = toast({ tone: 'error', message: 'One' });
      toast({ tone: 'error', message: 'Two' });
      toast({ tone: 'error', message: 'Three' });
      toast({ tone: 'error', message: 'Four' });
    });
    expect(screen.queryByText('One')).toBeNull();
    expect(screen.getByText('Four')).toBeTruthy();
    act(() => dismissToast(first + 3));
    expect(screen.getByText('One')).toBeTruthy();
    expect(screen.queryByText('Four')).toBeNull();
  });

  it('closes info toasts after their time', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast({ tone: 'info', message: 'Copied ID' });
    });
    expect(screen.getByText('Copied ID')).toBeTruthy();
    act(() => vi.advanceTimersByTime(3100));
    expect(screen.queryByText('Copied ID')).toBeNull();
  });
});
