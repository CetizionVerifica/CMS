import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { todayInIndia, shiftDate } from '../format';
import { navigation } from '../test/navigation';

vi.mock('next/navigation', () => navigation);

const { daysUntil, dueText, RenewalsScreen } = await import('./RenewalsScreen');
const { account, apiError, fakeApi, list, renderSignedIn } = await import('../test/fake-api');
const { choose } = await import('../test/select');

describe('renewals', () => {
  it('lists what ends soonest first, with how long is left', async () => {
    const today = todayInIndia();
    const api = fakeApi({
      'GET /renewals': list([
        {
          accountId: account().id,
          name: 'Kestrel Metals Group',
          status: 'ACTIVE',
          planCode: 'BUSINESS',
          endsOn: shiftDate(today, 20),
          kind: 'SUBSCRIPTION',
        },
        {
          accountId: '01900000-0000-7000-8000-0000000000b2',
          name: 'Osprey Textiles Group',
          status: 'TRIAL',
          planCode: 'STARTER',
          endsOn: shiftDate(today, 3),
          kind: 'TRIAL',
        },
      ]),
    });
    const onWindowChange = vi.fn();
    await renderSignedIn(
      <RenewalsScreen withinDays="60" onWindowChange={onWindowChange} />,
      api.fetch,
    );
    const rows = within(await screen.findByRole('table', { name: 'Renewals' })).getAllByRole('row');
    expect(rows[1]!.textContent).toContain('Osprey Textiles Group');
    expect(rows[1]!.textContent).toContain('In 3 days');
    expect(rows[2]!.textContent).toContain('In 20 days');
    expect(within(rows[2]!).getByRole('link', { name: 'Open billing' }).getAttribute('href')).toBe(
      `/accounts/${account().id}#billing`,
    );
    expect(api.sent.find((s) => s.path === '/renewals')!.query.get('withinDays')).toBe('60');
    await choose(userEvent.setup(), 'Ending within', '90 days');
    expect(onWindowChange).toHaveBeenCalledWith('90');
  });

  it('says when nothing ends, keeps to the known windows and shows a failure', async () => {
    const api = fakeApi({ 'GET /renewals': list([]) });
    const { unmount } = await renderSignedIn(
      <RenewalsScreen withinDays="7" onWindowChange={vi.fn()} />,
      api.fetch,
    );
    expect(await screen.findByText('Nothing ends in the next 30 days')).toBeTruthy();
    unmount();
    await renderSignedIn(
      <RenewalsScreen withinDays="30" onWindowChange={vi.fn()} />,
      fakeApi({ 'GET /renewals': apiError(500, 'INTERNAL', 'Renewals are down.') }).fetch,
    );
    expect(await screen.findByText('Renewals are down.')).toBeTruthy();
  });

  it('counts days and words them', () => {
    expect(daysUntil('2026-11-03', '2026-10-24')).toBe(10);
    expect(dueText(1)).toBe('In 1 day');
    expect(dueText(0)).toBe('Ends today');
    expect(dueText(-1)).toBe('Ended 1 day ago');
    expect(dueText(-4)).toBe('Ended 4 days ago');
  });
});
