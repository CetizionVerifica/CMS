import { SupportGrant } from '@canopy/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.fn();
const grantSupportAction = vi.fn();
const revokeSupportAction = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('./actions', () => ({
  grantSupportAction: (...args: unknown[]) => grantSupportAction(...args),
  revokeSupportAction: (...args: unknown[]) => revokeSupportAction(...args),
}));

const { PlanUsage, SupportAccess } = await import('./AccountView');

const ID = '00000000-0000-5000-8000-0000000000a1';
const live = SupportGrant.parse({
  id: ID,
  accountId: ID,
  level: 'ADMIN',
  status: 'ACTIVE',
  startsAt: '2026-10-24T05:00:00.000Z',
  endsAt: '2026-10-31T05:00:00.000Z',
  grantedById: ID,
  revokedAt: null,
  revokedById: null,
  supportPersonId: ID,
});

beforeEach(() => {
  refresh.mockReset();
  grantSupportAction.mockReset().mockResolvedValue({ ok: true });
  revokeSupportAction.mockReset().mockResolvedValue({ ok: true });
});

describe('account page', () => {
  it('shows the plan, the trial end and each limit beside its usage', () => {
    render(
      <PlanUsage
        plan="BUSINESS"
        trialEndsOn="2026-11-23"
        usage={[
          { label: 'Companies', used: '3', limit: '3', atLimit: true },
          { label: 'Users', used: '12', limit: 'No limit', atLimit: false },
        ]}
      />,
    );
    expect(screen.getByText(/The trial ends on 23 Nov 2026/)).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Plan limits and usage' });
    const companies = within(table).getByRole('row', { name: /Companies/ });
    expect(companies.textContent).toContain('At the limit');
    expect(within(table).getByRole('row', { name: /Users/ }).textContent).toContain('No limit');
  });

  it('lets support in with the chosen access for 7 days by default', async () => {
    render(<SupportAccess grants={[]} />);
    expect(screen.queryByRole('table', { name: 'Support access history' })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: /Admin/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Let support in' }));
    expect(grantSupportAction).toHaveBeenCalledWith({ level: 'ADMIN', days: 7 });
    expect(refresh).toHaveBeenCalled();
  });

  it('shows the live access, ends it after confirming, and reports a refusal', async () => {
    render(<SupportAccess grants={[live]} />);
    expect(screen.getByText(/access until 31 Oct 2026, 10:30 IST/)).toBeTruthy();
    expect(
      within(screen.getByRole('table', { name: 'Support access history' })).getByRole('row', {
        name: /Admin Active/,
      }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'End access now' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'End access' }),
    );
    expect(revokeSupportAction).toHaveBeenCalledWith(ID);

    grantSupportAction.mockResolvedValue({
      ok: false,
      message: 'Only account admins can change support access.',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Replace the current access' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only account admins can change support access.',
    );
  });
});
