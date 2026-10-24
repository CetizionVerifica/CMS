import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { navigation } from '../test/navigation';

vi.mock('next/navigation', () => navigation);

const { AccountsList, filtersFrom, filtersQuery } = await import('./AccountsList');
const { account, apiError, fakeApi, page, renderSignedIn } = await import('../test/fake-api');
const { choose } = await import('../test/select');

const osprey = account({
  id: '01900000-0000-7000-8000-0000000000b2',
  name: 'Osprey Textiles Group',
  kind: 'CONSULTANCY',
  status: 'ACTIVE',
  trialEndsOn: null,
});

describe('the accounts list', () => {
  it('lists accounts with status, plan, users against the limit and trial end', async () => {
    const api = fakeApi({ 'GET /accounts': page([account(), osprey]) });
    await renderSignedIn(
      <AccountsList search={new URLSearchParams()} onFiltersChange={vi.fn()} />,
      api.fetch,
    );
    const table = await screen.findByRole('table', { name: 'Accounts' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(
      within(rows[1]!).getByRole('link', { name: 'Kestrel Metals Group' }).getAttribute('href'),
    ).toBe(`/accounts/${account().id}`);
    expect(rows[1]!.textContent).toContain('Trial');
    expect(rows[1]!.textContent).toContain('150 of 150');
    expect(rows[1]!.textContent).toContain('Trial ends 23 Nov 2026');
    expect(rows[2]!.textContent).toContain('Consultancy');
    expect(rows[2]!.textContent).toContain('—');
    expect(api.sent.find((s) => s.path === '/accounts')!.query.get('limit')).toBe('50');
  });

  it('sends the filters from the URL and writes new ones back', async () => {
    const api = fakeApi({ 'GET /accounts': page([]) });
    const onFiltersChange = vi.fn();
    await renderSignedIn(
      <AccountsList
        search={new URLSearchParams('status=SUSPENDED&kind=ENTERPRISE&q=ke')}
        onFiltersChange={onFiltersChange}
      />,
      api.fetch,
    );
    expect(await screen.findByText('No account matches these filters')).toBeTruthy();
    const query = api.sent.find((s) => s.path === '/accounts')!.query;
    expect([query.get('status'), query.get('kind'), query.get('q')]).toEqual([
      'SUSPENDED',
      'ENTERPRISE',
      'ke',
    ]);
    const user = userEvent.setup();
    await choose(user, 'Status', 'Trial');
    expect(onFiltersChange).toHaveBeenLastCalledWith('?status=TRIAL&kind=ENTERPRISE&q=ke');
    await choose(user, 'Kind', 'Any kind');
    expect(onFiltersChange).toHaveBeenLastCalledWith('?status=SUSPENDED&q=ke');
    await user.clear(screen.getByRole('searchbox', { name: 'Name' }));
    await user.type(screen.getByRole('searchbox', { name: 'Name' }), 'osprey{Enter}');
    expect(onFiltersChange).toHaveBeenLastCalledWith('?status=SUSPENDED&kind=ENTERPRISE&q=osprey');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onFiltersChange).toHaveBeenLastCalledWith('');
  });

  it('pages on with the cursor and shows a failed page', async () => {
    const api = fakeApi({
      'GET /accounts': (s) =>
        s.query.get('cursor') === 'c1'
          ? page([osprey], 'c2')
          : s.query.get('cursor') === 'c2'
            ? apiError(500, 'INTERNAL', 'The list did not load.')
            : page([account()], 'c1'),
    });
    await renderSignedIn(
      <AccountsList search={new URLSearchParams()} onFiltersChange={vi.fn()} />,
      api.fetch,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show more accounts' }));
    expect(await screen.findByRole('link', { name: 'Osprey Textiles Group' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show more accounts' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The list did not load.');
  });

  it('invites the first account, and offers a retry when the list fails', async () => {
    const empty = fakeApi({ 'GET /accounts': page([]) });
    const { unmount } = await renderSignedIn(
      <AccountsList search={new URLSearchParams()} onFiltersChange={vi.fn()} />,
      empty.fetch,
    );
    expect(await screen.findByText('No accounts yet')).toBeTruthy();
    unmount();
    let fail = true;
    const broken = fakeApi({
      'GET /accounts': () => (fail ? apiError(503, 'INTERNAL', 'Try later.') : page([account()])),
    });
    await renderSignedIn(
      <AccountsList search={new URLSearchParams()} onFiltersChange={vi.fn()} />,
      broken.fetch,
    );
    expect(await screen.findByText('Try later.')).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Kestrel Metals Group' })).toBeTruthy();
  });

  it('reads only known filters from the URL', () => {
    expect(filtersFrom(new URLSearchParams('status=NOPE&kind=CONSULTANCY&q=a'))).toEqual({
      kind: 'CONSULTANCY',
    });
    expect(filtersQuery({})).toBe('');
  });
});
