'use client';
// The add-ons an account has (ADR M16-0001 decision 2): one switch per known feature. A switch asks for a reason and
// writes the account override; the limits, the other flags and the note stay as they are.
import { KNOWN_FEATURES, type Account, type Plan } from '@canopy/contracts';
import { Switch, Textarea, toast } from '@canopy/ui';
import { useEffect, useState } from 'react';

import {
  featureSource,
  isoSetup,
  overrideFrom,
  withFeature,
  type IsoSetup,
} from '../../account-actions';
import { formatInstant } from '../../format';
import { useSession } from '../../session';
import { FormDrawer } from '../../ui/FormDrawer';
import { Card, Pill } from '../../ui/parts';
import { overrideNote } from './override-note';

const SOURCE = {
  plan: 'The plan includes it.',
  added: 'Added for this account.',
  removed: 'Turned off for this account, although the plan includes it.',
  off: 'Not in the plan.',
} as const;

export function AddOns({
  account,
  plans,
  onChanged,
}: {
  account: Account;
  plans: Plan[];
  onChanged: (account: Account) => void;
}) {
  const { api } = useSession();
  const plan = plans.find((p) => p.code === account.planCode);
  const current = overrideFrom(account.entitlements, plan);
  const [change, setChange] = useState<{ code: string; label: string; on: boolean } | null>(null);
  const [reason, setReason] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const setup = useIsoSetup(account);

  return (
    <Card id="add-ons" title="Add-ons">
      <ul className="divide-y divide-line">
        {KNOWN_FEATURES.map((feature) => {
          const on = account.entitlements.features.includes(feature.code);
          const source = featureSource(feature.code, plan, current);
          return (
            <li
              key={feature.code}
              className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0 flex-1 basis-64">
                <p className="text-body font-semibold text-ink">
                  {feature.label} {on ? <Pill tone="ok">On</Pill> : <Pill tone="neutral">Off</Pill>}
                </p>
                <p className="mt-1 text-body text-muted">{feature.description}</p>
                <p className="mt-1 text-meta text-muted">{SOURCE[source]}</p>
                {feature.code === 'isoManagement' && on && setup ? (
                  <IsoSetupLine setup={setup} />
                ) : null}
              </div>
              <Switch
                label={`${feature.label} for ${account.name}`}
                hideLabel
                checked={on}
                // Without the plan the console cannot tell the plan's features from the account's own.
                disabled={!plan}
                onCheckedChange={(next) => {
                  setReason('');
                  setFields({});
                  setChange({ code: feature.code, label: feature.label, on: next });
                }}
              />
            </li>
          );
        })}
      </ul>

      <FormDrawer
        open={change !== null}
        onOpenChange={(open) => {
          if (!open) setChange(null);
        }}
        title={change ? `Turn ${change.on ? 'on' : 'off'} ${change.label}` : 'Add-on'}
        submitLabel={change?.on ? 'Turn on' : 'Turn off'}
        tone={change?.on ? 'primary' : 'danger'}
        onFieldErrors={setFields}
        onSubmit={async () => {
          if (!change || !plan) return;
          const parts = withFeature(current, change.code, change.on);
          const note = await overrideNote(api, account.id);
          onChanged(
            await api.call('setAccountOverride', {
              params: { id: account.id },
              body: { version: account.version, override: { ...parts, note }, reason },
            }),
          );
          toast({
            tone: 'success',
            message: `${change.label} is ${change.on ? 'on' : 'off'} for ${account.name}.`,
          });
        }}
      >
        <p className="text-body text-muted">
          {change?.on
            ? 'The account’s people see the add-on at once.'
            : 'The account’s people lose the add-on at once. Nothing they recorded in it is deleted; turning it back on shows it again.'}
        </p>
        <Textarea
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={fields.reason}
          required
        />
      </FormDrawer>
    </Card>
  );
}

/**
 * The ISO catalogue copy for an account with the add-on on (plan §4.3). Null until known. Reads the account's operator
 * audit (its latest 100 entries) for the switch-on and the move into TRIAL or ACTIVE only when the copy is missing.
 */
function useIsoSetup(account: Account): IsoSetup | null {
  const { api } = useSession();
  const on = account.entitlements.features.includes('isoManagement');
  const copiedAt = account.isoCatalogueCopiedAt ?? null;
  const [setup, setSetup] = useState<IsoSetup | null>(null);
  useEffect(() => {
    if (!on) return setSetup(null);
    if (copiedAt) return setSetup({ state: 'copied', at: copiedAt });
    let live = true;
    void api
      .call('listOperatorAudit', { query: { accountId: account.id, limit: '100' } })
      .then(({ items }) => {
        if (live) setSetup(isoSetup({ ...account, isoCatalogueCopiedAt: null }, items, Date.now()));
      })
      .catch(() => {
        if (live) setSetup(null);
      });
    return () => {
      live = false;
    };
  }, [api, account, on, copiedAt]);
  return setup;
}

function IsoSetupLine({ setup }: { setup: IsoSetup }) {
  switch (setup.state) {
    case 'copied':
      return (
        <p className="mt-1 text-meta text-muted">
          <Pill tone="ok">ISO set up</Pill> {formatInstant(setup.at)}
        </p>
      );
    case 'late':
      return (
        <p className="mt-1 text-meta text-ink" role="status">
          <Pill tone="crit">ISO set-up has not finished</Pill> Waiting since{' '}
          {formatInstant(setup.since)}. The copy runs every 10 minutes; check the jobs if this
          stays.
        </p>
      );
    case 'waiting':
      return <p className="mt-1 text-meta text-muted">ISO set-up is in progress.</p>;
    case 'notYet':
      return (
        <p className="mt-1 text-meta text-muted">
          ISO set-up starts when the account is in trial or active.
        </p>
      );
  }
}
