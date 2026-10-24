'use client';
// The account's name and profile, with an edit drawer. Only the fields that changed are sent.
import type { Account, AccountUpdateBody } from '@canopy/contracts';
import { Button, Input, Select, toast } from '@canopy/ui';
import { useState } from 'react';

import { formatDate, formatInstant, KIND, monthName, MONTH_OPTIONS } from '../../format';
import { useSession } from '../../session';
import { FormDrawer } from '../../ui/FormDrawer';
import { Card, Facts } from '../../ui/parts';

type Draft = {
  name: string;
  legalName: string;
  gstin: string;
  timeZone: string;
  fyStartMonth: string;
};

const draftOf = (a: Account): Draft => ({
  name: a.name,
  legalName: a.profile.legalName,
  gstin: a.profile.gstin ?? '',
  timeZone: a.profile.timeZone,
  fyStartMonth: String(a.profile.fyStartMonth),
});

/** The PATCH body for what changed, or null when nothing did. */
export function updateBody(account: Account, draft: Draft): AccountUpdateBody | null {
  const profile: NonNullable<AccountUpdateBody['profile']> = {};
  const gstin = draft.gstin.trim() ? draft.gstin.trim().toUpperCase() : null;
  if (draft.legalName.trim() !== account.profile.legalName)
    profile.legalName = draft.legalName.trim();
  if (gstin !== account.profile.gstin) profile.gstin = gstin;
  if (draft.timeZone.trim() !== account.profile.timeZone) profile.timeZone = draft.timeZone.trim();
  if (Number(draft.fyStartMonth) !== account.profile.fyStartMonth) {
    profile.fyStartMonth = Number(draft.fyStartMonth);
  }
  const name = draft.name.trim() !== account.name ? draft.name.trim() : undefined;
  if (name === undefined && Object.keys(profile).length === 0) return null;
  return {
    version: account.version,
    ...(name === undefined ? {} : { name }),
    ...(Object.keys(profile).length === 0 ? {} : { profile }),
  };
}

export function Details({
  account,
  onChanged,
}: {
  account: Account;
  onChanged: (account: Account) => void;
}) {
  const { api } = useSession();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => draftOf(account));
  const [fields, setFields] = useState<Record<string, string>>({});
  const set = (key: keyof Draft, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <Card
      id="details"
      title="Details"
      actions={
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setDraft(draftOf(account));
            setFields({});
            setOpen(true);
          }}
        >
          Edit details
        </Button>
      }
    >
      <Facts
        items={[
          { label: 'Kind', value: KIND[account.kind] },
          { label: 'Legal name', value: account.profile.legalName },
          { label: 'GSTIN', value: account.profile.gstin ?? 'Not given' },
          { label: 'Time zone', value: account.profile.timeZone },
          { label: 'Financial year starts', value: monthName(account.profile.fyStartMonth) },
          { label: 'Created', value: formatInstant(account.createdAt) },
          {
            label: 'Master library',
            value: account.libraryCopiedAt
              ? `Copied ${formatInstant(account.libraryCopiedAt)}`
              : 'Not copied yet: the owner can accept once it is',
          },
          {
            label: 'Onboarded',
            value: account.onboardedAt ? formatInstant(account.onboardedAt) : 'Not yet',
          },
          ...(account.trialEndsOn
            ? [{ label: 'Trial ends', value: formatDate(account.trialEndsOn) }]
            : []),
          ...(account.purgeAfter
            ? [{ label: 'Deleted for good after', value: formatInstant(account.purgeAfter) }]
            : []),
        ]}
      />
      <FormDrawer
        open={open}
        onOpenChange={setOpen}
        title="Edit details"
        submitLabel="Save details"
        onFieldErrors={setFields}
        onSubmit={async () => {
          const body = updateBody(account, draft);
          if (!body) throw 'Nothing has changed.';
          onChanged(await api.call('updateAccount', { params: { id: account.id }, body }));
          toast({ tone: 'success', message: 'Details saved.' });
        }}
      >
        <Input
          label="Display name"
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
          error={fields.name}
        />
        <Input
          label="Legal name"
          value={draft.legalName}
          onChange={(e) => set('legalName', e.target.value)}
          error={fields['profile.legalName']}
        />
        <Input
          label="GSTIN"
          value={draft.gstin}
          onChange={(e) => set('gstin', e.target.value)}
          helper="Leave blank to remove it."
          error={fields['profile.gstin']}
        />
        <Input
          label="Time zone"
          value={draft.timeZone}
          onChange={(e) => set('timeZone', e.target.value)}
          error={fields['profile.timeZone']}
        />
        <Select
          label="Financial year starts in"
          value={draft.fyStartMonth}
          onValueChange={(v) => set('fyStartMonth', v)}
          options={MONTH_OPTIONS}
        />
      </FormDrawer>
    </Card>
  );
}
