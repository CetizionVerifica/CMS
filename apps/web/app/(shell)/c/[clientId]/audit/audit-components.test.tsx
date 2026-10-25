import type { AuditEvent } from '@canopy/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ push: vi.fn() }));
const search = vi.hoisted(() => ({ value: 'kind=evidence&cursor=abc' }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/c/c1/audit',
  useSearchParams: () => new URLSearchParams(search.value),
}));

const { AuditTable } = await import('./AuditTable');
const { auditRows } = await import('./audit-model');
const { AuditFilterBar } = await import('./AuditFilterBar');

beforeEach(() => router.push.mockReset());

describe('AuditTable', () => {
  it('shows each event with its time in the client time zone, details and reason', () => {
    render(
      <AuditTable
        timeZone="Asia/Kolkata"
        empty={<p>Nothing</p>}
        rows={[
          {
            id: 'e1',
            at: '2026-10-24T05:30:00.000Z',
            who: 'Divya Hegde',
            what: 'Archived a unit',
            record: 'Pune Plant',
            details: ['Name: Pune Plant'],
            reason: 'Site closed',
          },
          {
            id: 'e2',
            at: '2026-10-24T05:00:00.000Z',
            who: 'System',
            what: 'Moved an instance',
            record: '—',
            details: [],
            reason: null,
          },
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'Audit trail' });
    const [, first, second] = within(table).getAllByRole('row');
    expect(first!.textContent).toContain('Archived a unit');
    expect(first!.textContent).toContain('Divya Hegde');
    expect(first!.textContent).toContain('11:00');
    expect(first!.textContent).toContain('Reason: Site closed');
    expect(second!.textContent).toContain('—');
  });

  it('shows an ISO event in words', () => {
    const event: AuditEvent = {
      id: 'e3',
      firmId: 'f1',
      clientId: 'c1',
      at: '2026-10-24T05:30:00.000Z',
      requestId: 'r1',
      actorId: 'p1',
      actorKind: 'PERSON',
      action: 'TRANSITION',
      // Staged outside EntityType until ISO-1b.
      entityType: 'nonconformity' as unknown as AuditEvent['entityType'],
      entityId: 'nc1',
      before: { state: 'OPEN' },
      after: {
        action: 'PLAN_ACTIONS',
        state: 'ACTIONS_PLANNED',
        title: 'Guard missing on press 4',
      },
      reason: null,
    };
    render(
      <AuditTable
        timeZone="Asia/Kolkata"
        empty={<p>Nothing</p>}
        rows={auditRows([event], { p1: 'Divya Hegde' })}
      />,
    );
    const [, row] = within(screen.getByRole('table', { name: 'Audit trail' })).getAllByRole('row');
    expect(row!.textContent).toContain('Planned actions for a nonconformity');
    expect(row!.textContent).toContain('Guard missing on press 4');
    expect(row!.textContent).toContain('State: OPEN → ACTIONS_PLANNED');
  });

  it('shows the empty message', () => {
    render(
      <AuditTable timeZone="Asia/Kolkata" rows={[]} empty={<p>Nothing has changed yet.</p>} />,
    );
    expect(screen.getByText('Nothing has changed yet.')).toBeTruthy();
  });
});

describe('AuditFilterBar', () => {
  it('keeps the kinds in the URL and restarts paging', async () => {
    search.value = 'kind=evidence&cursor=abc';
    render(<AuditFilterBar kinds={['evidence']} resultText="3 events" resultCount={3} />);
    await userEvent.click(screen.getByRole('button', { name: /Kind of change/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Setup changes' }));
    expect(router.push).toHaveBeenLastCalledWith('/c/c1/audit?kind=evidence%2Csetup');
    // The bar is controlled, so this starts again from the page's own kinds.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Evidence' }));
    expect(router.push).toHaveBeenLastCalledWith('/c/c1/audit');
  });
});
