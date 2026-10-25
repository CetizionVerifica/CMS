import { AccountView, ENDPOINTS, type SupportGrant } from '@canopy/contracts';
import type { Metadata } from 'next';

import { isApiError } from '../../../lib/api/client';
import { serverApi } from '../../../lib/api/server';
import { NoPermission, PageHeader } from '../../../lib/patterns';
import { routeByPath, visibleTo } from '../../../lib/routes';
import { homeHref } from '../../../lib/shell/model';
import { loadShell } from '../../../lib/shell/server';
import { redirectIfSignedOut } from '../c/[clientId]/overview/signed-out';
import { ACCOUNT_STATUS, isClosingRefusal, usageRows } from './account-model';
import { PlanUsage, SupportAccess } from './AccountView';
import { ClientArchives } from './ClientArchives';

export const metadata: Metadata = { title: 'Account' };

// The account's plan and usage, PlanetPulse support access and each client's data, for account admins (ADR M15-0001
// decisions 5, 11). A closing account answers only exports, so its page is the downloads alone.
export default async function AccountPage() {
  const model = await loadShell();
  if (!visibleTo(routeByPath('account'), model.roles.firm)) {
    return <NoPermission what="account" backHref={homeHref(model)} backLabel="Go to home" />;
  }
  const clients = model.clients.map(({ id, name }) => ({ id, name }));
  const closingPage = (
    <>
      <PageHeader title="Account" description="Closing" />
      <ClientArchives clients={clients} closing />
    </>
  );
  if (model.notice?.kind === 'closing') return closingPage;
  const api = await serverApi();
  let view: AccountView;
  let grants: SupportGrant[];
  try {
    const [account, support] = await Promise.all([
      api.call('getAccount'),
      api.call('listSupportGrants'),
    ]);
    view = account.data;
    grants = ENDPOINTS.listSupportGrants.response.parse(support.data).items;
  } catch (error) {
    await redirectIfSignedOut(error);
    if (isClosingRefusal(error)) return closingPage;
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
      return <NoPermission what="account" backHref={homeHref(model)} backLabel="Go to home" />;
    }
    throw error;
  }
  return (
    <>
      <PageHeader title="Account" description={`${view.name} · ${ACCOUNT_STATUS[view.status]}`} />
      <div className="flex flex-col gap-8">
        <PlanUsage
          plan={view.entitlements.planCode}
          trialEndsOn={view.status === 'TRIAL' ? view.trialEndsOn : null}
          usage={usageRows(view)}
        />
        {/* Support is refused a copy of the client's files (ADR M10-0002 §3), so it doesn't see the offer. */}
        {model.notice?.kind === 'support' ? null : (
          <ClientArchives clients={clients} closing={false} />
        )}
        <SupportAccess grants={grants} />
      </div>
    </>
  );
}
