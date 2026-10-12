import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { ComingSoon, NoPermission, NotFoundState, PageEmpty, PageError, PageHeader, PageLoading } =
  await import('.');

describe('page patterns', () => {
  it('header has the one h1 and actions', () => {
    render(
      <PageHeader
        title="Register"
        description="All obligations"
        actions={<button>Export</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Register' })).toBeTruthy();
    expect(screen.getByText('All obligations')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
  });

  it('loading announces once and is busy', () => {
    const { container } = render(<PageLoading label="Loading register" />);
    expect(screen.getByRole('status').textContent).toBe('Loading register');
    expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('true');
  });

  it('empty, no-permission and not-found say what to do next', () => {
    render(
      <PageEmpty
        title="No clients yet"
        body="Add one."
        action={{ label: 'Add client', href: '/x' }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Add client' }).getAttribute('href')).toBe('/x');
    render(<NoPermission what="approvals" backHref="/c/1/overview" />);
    expect(
      screen.getByRole('heading', { name: 'You don’t have access to approvals' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go back' })).toBeTruthy();
    render(<NoPermission />);
    expect(screen.getByText('You don’t have access to this page')).toBeTruthy();
    render(<NotFoundState />);
    expect(screen.getByRole('heading', { name: 'We couldn’t find that page' })).toBeTruthy();
  });

  it('error offers a retry and shows the reference', async () => {
    const retry = vi.fn();
    render(<PageError reference="abc123" onRetry={retry} homeHref="/" />);
    expect(screen.getByText('abc123')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
    render(<PageError />);
  });

  it('coming soon names the page', () => {
    render(<ComingSoon title="Calendar" homeHref="/c/1/overview" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Calendar' })).toBeTruthy();
    expect(screen.getByText('Calendar is coming soon')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to home' }).getAttribute('href')).toBe(
      '/c/1/overview',
    );
  });
});
