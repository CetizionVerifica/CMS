import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../test/axe';
import { Avatar, AvatarGroup, initials } from './Avatar';
import { Badge, formatCount } from './Badge';
import { Link } from './Link';
import { LoadingRegion, Skeleton } from './Skeleton';

describe('Avatar', () => {
  it('derives initials', () => {
    expect(initials('Priya Rane')).toBe('PR');
    expect(initials('  rohit  kumar agarwal ')).toBe('RA');
    expect(initials('Shyam')).toBe('S');
    expect(initials('   ')).toBe('?');
  });

  it('is an image named after the person, or hidden when decorative', async () => {
    render(
      <div>
        <Avatar name="Priya Rane" size={24} />
        <Avatar name="Rohit Agarwal" size={40} src="data:image/png;base64,iVBORw0KGgo=" />
        <span>
          <Avatar name="Asha Iyer" decorative /> Asha Iyer
        </span>
      </div>,
    );
    expect(screen.getByRole('img', { name: 'Priya Rane' }).textContent).toBe('PR');
    expect(screen.getByRole('img', { name: 'Rohit Agarwal' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Asha Iyer' })).toBeNull();
    await expectNoAxeViolations();
  });

  it('groups show at most three then +N, and name everyone', async () => {
    render(
      <AvatarGroup
        people={[
          { name: 'Priya Rane' },
          { name: 'Rohit Agarwal' },
          { name: 'Asha Iyer' },
          { name: 'Vik Rao' },
          { name: 'Neha Shah' },
        ]}
      />,
    );
    const group = screen.getByRole('img', {
      name: 'Priya Rane, Rohit Agarwal, Asha Iyer, Vik Rao, Neha Shah',
    });
    expect(group.textContent).toContain('+2');
    await expectNoAxeViolations();
  });
});

describe('Badge', () => {
  it('caps at 99+ and carries the noun for screen readers', async () => {
    expect(formatCount(4)).toBe('4');
    expect(formatCount(120)).toBe('99+');
    render(
      <a href="/approvals">
        Approvals <Badge count={120} label="120 waiting" on="forest" />
      </a>,
    );
    expect(screen.getByRole('link', { name: /^Approvals ?, 120 waiting$/ })).toBeTruthy();
    await expectNoAxeViolations();
  });
});

describe('Skeleton and LoadingRegion', () => {
  it('announces one message per region and sets aria-busy', async () => {
    const { rerender } = render(
      <LoadingRegion loading label="Loading overview" skeleton={<Skeleton className="h-6 w-40" />}>
        <p>Loaded</p>
      </LoadingRegion>,
    );
    expect(screen.getByRole('status').textContent).toBe('Loading overview');
    expect(screen.getByRole('status').parentElement?.getAttribute('aria-busy')).toBe('true');
    await expectNoAxeViolations();
    rerender(
      <LoadingRegion loading={false} label="Loading overview" skeleton={<Skeleton />}>
        <p>Loaded</p>
      </LoadingRegion>,
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Loaded').parentElement?.hasAttribute('aria-busy')).toBe(false);
  });
});

describe('Link', () => {
  it('external links open safely and say so', async () => {
    const user = userEvent.setup();
    render(
      <p>
        Read the{' '}
        <Link href="https://labour.gov.in" external>
          Act
        </Link>{' '}
        and the{' '}
        <Link href="/library" inline>
          library
        </Link>
        .
      </p>,
    );
    const act = screen.getByRole('link', { name: /^Act ?\(opens in a new tab\)$/ });
    expect(act.getAttribute('target')).toBe('_blank');
    expect(act.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('link', { name: 'library' }).className).toContain('underline');
    await user.tab();
    expect(document.activeElement).toBe(act);
    await expectNoAxeViolations();
  });

  it('styles a child link with asChild', () => {
    render(
      <Link asChild>
        <a href="/register">Register</a>
      </Link>,
    );
    expect(screen.getByRole('link', { name: 'Register' }).className).toContain('text-forest');
  });
});
