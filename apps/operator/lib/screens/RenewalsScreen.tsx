'use client';
// Trials and paid terms that end soon, soonest first, so the operator can renew or convert in time.
import { Button, EmptyState, Link, Select } from '@canopy/ui';
import NextLink from 'next/link';

import { formatDate, todayInIndia } from '../format';
import { useSession } from '../session';
import { useLoad } from '../use-load';
import { AccountStatusPill, cell, Loading, LoadError, PageHeader, Pill, Table } from '../ui/parts';

export const WINDOWS = ['30', '60', '90'] as const;

/** Whole days from today to `endsOn`, negative once it has passed. */
export function daysUntil(endsOn: string, today: string): number {
  return Math.round(
    (Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
}

export function dueText(days: number): string {
  if (days < 0) return `Ended ${-days} day${days === -1 ? '' : 's'} ago`;
  if (days === 0) return 'Ends today';
  return `In ${days} day${days === 1 ? '' : 's'}`;
}

export function RenewalsScreen({
  withinDays,
  onWindowChange,
}: {
  withinDays: string;
  onWindowChange: (days: string) => void;
}) {
  const { api } = useSession();
  const window = (WINDOWS as readonly string[]).includes(withinDays) ? withinDays : '30';
  const renewals = useLoad(
    () => api.call('listRenewals', { query: { withinDays: window } }),
    window,
  );
  const today = todayInIndia();

  const header = (
    <PageHeader
      title="Renewals"
      description="Trials and paid terms that end soon. Record a subscription on the account to renew it."
      actions={
        <Select
          label="Ending within"
          value={window}
          onValueChange={onWindowChange}
          options={WINDOWS.map((d) => ({ value: d, label: `${d} days` }))}
        />
      }
    />
  );
  if (renewals.state === 'loading')
    return (
      <>
        {header}
        <Loading label="Loading renewals" />
      </>
    );
  if (renewals.state === 'error') {
    return (
      <>
        {header}
        <LoadError message={renewals.message} onRetry={renewals.reload} />
      </>
    );
  }
  const items = [...renewals.data.items].sort((a, b) => a.endsOn.localeCompare(b.endsOn));

  return (
    <>
      {header}
      {items.length === 0 ? (
        <EmptyState
          variant="done"
          title={`Nothing ends in the next ${window} days`}
          action={{ label: 'All accounts', href: '/accounts' }}
        />
      ) : (
        <Table caption="Renewals" head={['Account', 'Status', 'Plan', 'What ends', 'Ends', '']}>
          {items.map((r) => {
            const days = daysUntil(r.endsOn, today);
            return (
              <tr key={`${r.accountId}:${r.kind}`}>
                <td className={cell}>
                  <Link asChild>
                    <NextLink href={`/accounts/${r.accountId}`} prefetch={false}>
                      {r.name}
                    </NextLink>
                  </Link>
                </td>
                <td className={cell}>
                  <AccountStatusPill status={r.status} />
                </td>
                <td className={cell}>{r.planCode}</td>
                <td className={cell}>{r.kind === 'TRIAL' ? 'Trial' : 'Subscription'}</td>
                <td className={cell}>
                  {formatDate(r.endsOn)}{' '}
                  <Pill tone={days <= 7 ? 'crit' : 'warn'}>{dueText(days)}</Pill>
                </td>
                <td className={cell}>
                  <Button asChild variant="secondary" size="sm">
                    <NextLink href={`/accounts/${r.accountId}#billing`} prefetch={false}>
                      Open billing
                    </NextLink>
                  </Button>
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
