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

const { AddOns, PlanUsage, SupportAccess } = await import('./AccountView');
const { addOnRows } = await import('./account-model');

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
    expect(screen.getByText('Business')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Plan limits and usage' });
    const companies = within(table).getByRole('row', { name: /Companies/ });
    expect(companies.textContent).toContain('At the limit');
    expect(within(table).getByRole('row', { name: /Users/ }).textContent).toContain('No limit');
  });

  it('shows each add-on On or Off, read-only, with who changes it', () => {
    const { rerender } = render(<AddOns addOns={addOnRows(['isoManagement'])} />);
    const list = screen.getByRole('list', { name: 'Add-ons' });
    const iso = within(list).getByRole('listitem');
    expect(iso.textContent).toContain('ISO management systems');
    expect(iso.textContent).toContain('ISO 9001, 14001 and 45001');
    expect(iso.textContent).toMatch(/On$/);
    expect(screen.getByText('Your PlanetPulse contact turns add-ons on or off.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();

    rerender(<AddOns addOns={addOnRows(['somethingElse'])} />);
    expect(
      within(screen.getByRole('list', { name: 'Add-ons' })).getByRole('listitem').textContent,
    ).toMatch(/Off$/);
    rerender(<AddOns addOns={addOnRows([])} />);
    expect(
      within(screen.getByRole('list', { name: 'Add-ons' })).getByRole('listitem').textContent,
    ).toMatch(/Off$/);
  });

  it('lets support in read only for 7 days by default, without a confirmation', async () => {
    render(<SupportAccess grants={[]} />);
    expect(screen.queryByRole('table', { name: 'Support access history' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Let support in' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(grantSupportAction).toHaveBeenCalledWith({ level: 'READ_ONLY', days: 7 });
    expect(refresh).toHaveBeenCalled();
  });

  it('confirms admin access, naming the level and the end, before granting it', async () => {
    render(<SupportAccess grants={[]} />);
    await userEvent.click(screen.getByRole('radio', { name: /Admin/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Let support in' }));
    expect(grantSupportAction).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', {
      name: 'Give PlanetPulse support admin access?',
    });
    expect(dialog.textContent).toMatch(/Admin access for 7 days, until about /);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(grantSupportAction).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Let support in' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Give admin access' }),
    );
    expect(grantSupportAction).toHaveBeenCalledWith({ level: 'ADMIN', days: 7 });
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
    const replace = screen.getByRole('alertdialog', {
      name: 'Replace the current PlanetPulse support access?',
    });
    expect(replace.textContent).toContain('The current access ends now.');
    await userEvent.click(within(replace).getByRole('button', { name: 'Replace access' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only account admins can change support access.',
    );
  });
});
