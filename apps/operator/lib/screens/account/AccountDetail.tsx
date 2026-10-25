'use client';
// One account: its status and actions on top, then details, plan and limits, add-ons, billing and usage, and support access.
import type { Account } from '@canopy/contracts';
import { EmptyState, Link } from '@canopy/ui';
import NextLink from 'next/link';
import { useEffect, useState } from 'react';

import { isOperatorApiError } from '../../api';
import { KIND } from '../../format';
import { useSession } from '../../session';
import { useLoad } from '../../use-load';
import { AccountStatusPill, Loading, LoadError, PageHeader } from '../../ui/parts';
import { AddOns } from './AddOns';
import { Billing } from './Billing';
import { Details } from './Details';
import { Lifecycle } from './Lifecycle';
import { PlanLimits } from './PlanLimits';
import { Support } from './Support';

export function AccountDetail({ id }: { id: string }) {
  const { api } = useSession();
  const loaded = useLoad(async () => {
    try {
      const [account, plans] = await Promise.all([
        api.call('getAccount', { params: { id } }),
        api.call('listPlans'),
      ]);
      return { account, plans: plans.items };
    } catch (error) {
      if (isOperatorApiError(error, 'NOT_FOUND', 'VALIDATION')) return null;
      throw error;
    }
  }, id);
  const [account, setAccount] = useState<Account | null>(null);

  // Each load (the first, or a retry) replaces what the page shows; changes in between come from onChanged.
  const fresh = loaded.state === 'ready' ? loaded.data : undefined;
  useEffect(() => {
    if (fresh !== undefined) setAccount(fresh?.account ?? null);
  }, [fresh]);

  if (loaded.state === 'loading') return <Loading label="Loading the account" />;
  if (loaded.state === 'error')
    return <LoadError message={loaded.message} onRetry={loaded.reload} />;
  if (loaded.data === null) {
    return (
      <EmptyState
        variant="no-results"
        title="No such account"
        body="It may have been purged, or the link is wrong."
        action={{ label: 'All accounts', href: '/accounts' }}
      />
    );
  }
  const current = account ?? loaded.data.account;
  const { plans } = loaded.data;

  return (
    <>
      <p className="mb-2 text-meta">
        <Link asChild>
          <NextLink href="/accounts" prefetch={false}>
            All accounts
          </NextLink>
        </Link>
      </p>
      <PageHeader
        title={current.name}
        description={`${KIND[current.kind]} · ${current.planCode} plan · version ${current.version}`}
        actions={<AccountStatusPill status={current.status} />}
      />
      <div className="mb-4">
        <Lifecycle
          key={`${current.id}:${current.version}`}
          account={current}
          onChanged={setAccount}
        />
      </div>
      <Details key={`d:${current.version}`} account={current} onChanged={setAccount} />
      <PlanLimits account={current} plans={plans} onChanged={setAccount} />
      <AddOns account={current} plans={plans} onChanged={setAccount} />
      <Billing account={current} plans={plans} />
      <Support account={current} />
    </>
  );
}
