'use client';
// Support access the account's admins granted (ADR M15-0001 decision 11). The console sees only the grant's dates
// and level; opening a session starts the customer app in a new tab, signed in as the support person.
import type { Account } from '@canopy/contracts';
import { Button, EmptyState, toast } from '@canopy/ui';
import { useState } from 'react';

import { errorMessage } from '../../api';
import { formatInstant, GRANT_STATUS } from '../../format';
import { useSession } from '../../session';
import { useLoad } from '../../use-load';
import { Card, cell, Loading, LoadError, Pill, Table } from '../../ui/parts';

const LEVEL = { READ_ONLY: 'Read only', ADMIN: 'Admin' } as const;

export function Support({
  account,
  openWindow = (url) => window.open(url, '_blank', 'noopener,noreferrer'),
}: {
  account: Account;
  /** Opens the support session (a new tab in the browser). */
  openWindow?: (url: string) => void;
}) {
  const { api } = useSession();
  const grants = useLoad(
    () => api.call('listAccountSupportGrants', { params: { id: account.id } }),
    `grants:${account.id}`,
  );
  const [opening, setOpening] = useState<string | null>(null);
  const working = account.status === 'TRIAL' || account.status === 'ACTIVE';

  async function open(id: string) {
    setOpening(id);
    try {
      const session = await api.call('openSupportSession', { params: { id } });
      openWindow(session.url);
    } catch (error) {
      toast({ tone: 'error', message: errorMessage(error) });
      grants.reload();
    } finally {
      setOpening(null);
    }
  }

  return (
    <Card id="support" title="Support access">
      {grants.state === 'loading' ? (
        <Loading label="Loading support access" />
      ) : grants.state === 'error' ? (
        <LoadError message={grants.message} onRetry={grants.reload} />
      ) : grants.data.items.length === 0 ? (
        <EmptyState
          variant="no-permission"
          size="card"
          headingLevel={3}
          title="No support access granted"
          body="The account's admins can grant PlanetPulse support access from their account settings. Until they do, the console cannot see their data."
        />
      ) : (
        <Table caption="Support grants" head={['Level', 'Status', 'From', 'Until', '']}>
          {grants.data.items.map((g) => (
            <tr key={g.id}>
              <td className={cell}>{LEVEL[g.level]}</td>
              <td className={cell}>
                <Pill tone={g.status === 'ACTIVE' ? 'ok' : 'neutral'}>
                  {GRANT_STATUS[g.status]}
                </Pill>
              </td>
              <td className={cell}>{formatInstant(g.startsAt)}</td>
              <td className={cell}>{formatInstant(g.revokedAt ?? g.endsAt)}</td>
              <td className={cell}>
                {g.status === 'ACTIVE' ? (
                  <Button
                    size="sm"
                    loading={opening === g.id}
                    disabledReason={
                      working ? undefined : 'Support sessions work only while the account is open.'
                    }
                    onClick={() => void open(g.id)}
                  >
                    Open support session
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
