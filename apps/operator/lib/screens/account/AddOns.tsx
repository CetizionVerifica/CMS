'use client';
// The add-ons an account has (ADR M16-0001 decision 2): one switch per known feature. A switch asks for a reason and
// writes the account override; the limits, the other flags and the note stay as they are.
import { KNOWN_FEATURES, type Account, type Plan } from '@canopy/contracts';
import { Switch, Textarea, toast } from '@canopy/ui';
import { useState } from 'react';

import { featureSource, overrideFrom, withFeature } from '../../account-actions';
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
          const parts = withFeature(current, plan, change.code, change.on);
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
