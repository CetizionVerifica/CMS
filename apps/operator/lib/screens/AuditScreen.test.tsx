import type { OperatorAuditEvent } from '@canopy/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { navigation } from '../test/navigation';

vi.mock('next/navigation', () => navigation);

const { auditApiQuery, auditFiltersFrom, auditFiltersQuery, AuditScreen } =
  await import('./AuditScreen');
const { account, apiError, fakeApi, ME, page, renderSignedIn } = await import('../test/fake-api');
const { choose } = await import('../test/select');

const event = (n: number, over: Partial<OperatorAuditEvent> = {}): OperatorAuditEvent => ({
  id: `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  at: '2026-10-24T09:35:00.000Z',
  operatorId: ME.operator.id,
  action: 'ACCOUNT_SUSPEND',
  accountId: account().id,
  before: { status: 'ACTIVE' },
  after: { status: 'SUSPENDED' },
  reason: 'Unpaid invoice',
  requestId: `req-${n}`,
  ip: '203.0.113.4',
  ...over,
});

describe('the operator audit', () => {
  it('lists entries with account and operator names, and pages on', async () => {
    const api = fakeApi({
      'GET /accounts': page([account()]),
      'GET /audit': (s) =>
        s.query.get('cursor') === 'c1'
          ? page([
              event(3, {
                operatorId: null,
                accountId: null,
                action: 'ACCOUNT_PURGE',
                reason: null,
              }),
            ])
          : page(
              [event(1), event(2, { operatorId: '01900000-0000-7000-8000-0000000000a9' })],
              'c1',
            ),
    });
    await renderSignedIn(
      <AuditScreen search={new URLSearchParams()} onFiltersChange={vi.fn()} />,
      api.fetch,
    );
    const table = await screen.findByRole('table', { name: 'Operator audit' });
    await within(table).findAllByRole('link', { name: 'Kestrel Metals Group' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]!.textContent).toContain('24 Oct 2026, 15:05 IST');
    expect(rows[1]!.textContent).toContain('Suspended account');
    expect(rows[1]!.textContent).toContain('Meera Iyer');
    expect(rows[2]!.textContent).toContain('Another operator');
    await userEvent.click(screen.getByRole('button', { name: 'Show older entries' }));
    expect(await screen.findByText('Purged account')).toBeTruthy();
    expect(screen.getByText('System')).toBeTruthy();
  });

  it('filters by action and account in the URL, with India days as instants', async () => {
    const api = fakeApi({ 'GET /accounts': page([account()]), 'GET /audit': page([]) });
    const onFiltersChange = vi.fn();
    await renderSignedIn(
      <AuditScreen
        search={new URLSearchParams('action=PLAN_CHANGE&from=2026-10-01&to=2026-10-24')}
        onFiltersChange={onFiltersChange}
      />,
      api.fetch,
    );
    expect(await screen.findByText('Nothing matches these filters')).toBeTruthy();
    const query = api.sent.find((s) => s.path === '/audit')!.query;
    expect([query.get('action'), query.get('from'), query.get('to')]).toEqual([
      'PLAN_CHANGE',
      '2026-09-30T18:30:00.000Z',
      '2026-10-24T18:30:00.000Z',
    ]);
    const user = userEvent.setup();
    await vi.waitFor(() => expect(api.sent.some((s) => s.path === '/accounts')).toBe(true));
    await choose(user, 'Account', 'Kestrel Metals Group');
    expect(onFiltersChange).toHaveBeenLastCalledWith(
      `?action=PLAN_CHANGE&account=${account().id}&from=2026-10-01&to=2026-10-24`,
    );
    await choose(user, 'Action', 'Any action');
    expect(onFiltersChange).toHaveBeenLastCalledWith('?from=2026-10-01&to=2026-10-24');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onFiltersChange).toHaveBeenLastCalledWith('');
  });

  it('downloads every matching entry for Excel, and reports a failed download', async () => {
    let fail = false;
    const api = fakeApi({
      'GET /accounts': page([account()]),
      'GET /audit': (s) =>
        fail && s.query.get('limit') === '200'
          ? apiError(500, 'INTERNAL', 'Export failed.')
          : s.query.get('cursor') === 'e1'
            ? page([event(2)])
            : s.query.get('limit') === '200'
              ? page([event(1)], 'e1')
              : page([event(1)]),
    });
    const save = vi.fn();
    await renderSignedIn(
      <AuditScreen search={new URLSearchParams()} onFiltersChange={vi.fn()} save={save} />,
      api.fetch,
    );
    await screen.findByRole('table', { name: 'Operator audit' });
    await vi.waitFor(() => expect(api.sent.some((s) => s.path === '/accounts')).toBe(true));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Download for Excel' }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [name, text] = save.mock.calls[0] as [string, string];
    expect(name).toMatch(/^operator-audit-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(text.trim().split('\r\n')).toHaveLength(3);
    expect(text).toContain('"Kestrel Metals Group","Meera Iyer"');
    fail = true;
    await user.click(screen.getByRole('button', { name: 'Download for Excel' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Export failed.');
  });

  it('reads only valid filters from the URL and reports a failed page', async () => {
    expect(
      auditFiltersFrom(new URLSearchParams('action=NOPE&account=x&from=yesterday&to=2026-10-24')),
    ).toEqual({ to: '2026-10-24' });
    expect(auditFiltersQuery({})).toBe('');
    expect(auditApiQuery({})).toEqual({});
    await renderSignedIn(
      <AuditScreen search={new URLSearchParams()} onFiltersChange={vi.fn()} />,
      fakeApi({
        'GET /accounts': page([]),
        'GET /audit': apiError(500, 'INTERNAL', 'Audit is down.'),
      }).fetch,
    );
    expect(await screen.findByText('Audit is down.')).toBeTruthy();
  });
});
