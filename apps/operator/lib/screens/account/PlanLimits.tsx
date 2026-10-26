'use client';
// The plan, the limits in force and what the account uses of them; change the plan or override single limits.
import type { Account, AccountOverride, Plan, PlanLimits as Limits } from '@canopy/contracts';
import { Button, Input, Select, Textarea, toast } from '@canopy/ui';
import { useState } from 'react';

import {
  featuresFrom,
  isKnownFeature,
  LIMIT_KEYS,
  LIMIT_LABEL,
  limitFrom,
  overrideFrom,
  type OverrideParts,
} from '../../account-actions';
import { errorMessage } from '../../api';
import { atLimit, formatBytes, usageOf } from '../../format';
import { useSession } from '../../session';
import { FormDrawer } from '../../ui/FormDrawer';
import { Card, cell, Pill, Table } from '../../ui/parts';
import { overrideNote } from './override-note';

const limitText = (value: number | null | undefined) =>
  value === undefined ? '' : value === null ? 'unlimited' : String(value);

/** A limit for reading: storage in KB, MB or GB, everything else as a number. */
const shown = (key: (typeof LIMIT_KEYS)[number], value: number | null | undefined) =>
  key === 'storageBytes' && typeof value === 'number' ? formatBytes(value) : limitText(value);

/**
 * The override body for the form, or the first field error. The form holds the limits, the extra flags that are not
 * add-ons, and the note; the add-ons the Add-ons card switched on or off (`current`) stay as they are.
 */
export function overrideBody(
  form: {
    limits: Record<(typeof LIMIT_KEYS)[number], string>;
    features: string;
    note: string;
  },
  current: OverrideParts,
): { override: AccountOverride } | { field: string; error: string } {
  const limits: Partial<Limits> = {};
  for (const key of LIMIT_KEYS) {
    const parsed = limitFrom(form.limits[key]);
    if ('error' in parsed) return { field: key, error: parsed.error };
    if (parsed.value !== undefined) limits[key] = parsed.value;
  }
  const typed = featuresFrom(form.features);
  const addOn = typed.find(isKnownFeature);
  if (addOn) {
    return { field: 'features', error: `Turn ${addOn} on or off in the Add-ons card.` };
  }
  return {
    override: {
      limits,
      // Add-ons are left out of both lists: the API keeps a known flag named in neither as it is (ISO-5b).
      features: typed,
      removedFeatures: current.removedFeatures.filter(
        (f) => !isKnownFeature(f) && !typed.includes(f),
      ),
      note: form.note.trim() || null,
    },
  };
}

export function PlanLimits({
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
  const [openPlan, setOpenPlan] = useState(false);
  const [openOverride, setOpenOverride] = useState(false);
  const [planCode, setPlanCode] = useState('');
  const [planReason, setPlanReason] = useState('');
  const [form, setForm] = useState({
    limits: { companies: '', units: '', users: '', storageBytes: '' },
    features: '',
    note: '',
  });
  const [overrideReason, setOverrideReason] = useState('');
  const [opening, setOpening] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const params = { id: account.id };
  const choosable = plans.filter((p) => p.retiredAt === null && p.code !== account.planCode);
  const { limits } = account.entitlements;
  const rows: { key: (typeof LIMIT_KEYS)[number]; used: number }[] = [
    { key: 'companies', used: account.usage.companies },
    { key: 'units', used: account.usage.units },
    { key: 'users', used: account.usage.users },
    { key: 'storageBytes', used: account.usage.storageBytes },
  ];

  return (
    <Card
      id="plan"
      title={`Plan: ${plan?.name ?? account.planCode}`}
      actions={
        <>
          <Button
            variant="secondary"
            size="sm"
            disabledReason={
              choosable.length === 0 ? 'There is no other plan to move to.' : undefined
            }
            onClick={() => {
              setPlanCode(choosable[0]?.code ?? '');
              setPlanReason('');
              setFields({});
              setOpenPlan(true);
            }}
          >
            Change plan
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={opening}
            onClick={async () => {
              const current = overrideFrom(account.entitlements, plan);
              setOpening(true);
              let note: string | null;
              try {
                note = await overrideNote(api, account.id);
              } catch (e) {
                toast({ tone: 'error', message: errorMessage(e) });
                return;
              } finally {
                setOpening(false);
              }
              setForm({
                limits: {
                  companies: limitText(current.limits.companies),
                  units: limitText(current.limits.units),
                  users: limitText(current.limits.users),
                  storageBytes: limitText(current.limits.storageBytes),
                },
                features: current.features.filter((f) => !isKnownFeature(f)).join(', '),
                note: note ?? '',
              });
              setOverrideReason('');
              setFields({});
              setOpenOverride(true);
            }}
          >
            Override limits
          </Button>
        </>
      }
    >
      <Table caption="Limits and usage" head={['Limit', 'Used', 'Plan', 'In force']}>
        {rows.map(({ key, used }) => (
          <tr key={key}>
            <th scope="row" className={`${cell} font-semibold`}>
              {LIMIT_LABEL[key].replace(' (bytes)', '')}
            </th>
            <td className={cell}>
              {usageOf(used, limits[key], key === 'storageBytes')}{' '}
              {atLimit(used, limits[key]) ? <Pill tone="warn">At limit</Pill> : null}
            </td>
            <td className={cell}>{shown(key, plan?.limits[key]) || '—'}</td>
            <td className={cell}>
              {shown(key, limits[key])}
              {plan && plan.limits[key] !== limits[key] ? (
                <span className="ml-2 text-meta text-muted">overridden</span>
              ) : null}
            </td>
          </tr>
        ))}
      </Table>
      <p className="mt-3 text-body text-muted">
        Features:{' '}
        {account.entitlements.features.length ? account.entitlements.features.join(', ') : 'none'}
      </p>

      <FormDrawer
        open={openPlan}
        onOpenChange={setOpenPlan}
        title="Change plan"
        submitLabel="Change plan"
        onFieldErrors={setFields}
        onSubmit={async () => {
          onChanged(
            await api.call('setAccountPlan', {
              params,
              body: { version: account.version, planCode, reason: planReason },
            }),
          );
          toast({ tone: 'success', message: `${account.name} is on ${planCode} now.` });
        }}
      >
        <Select
          label="New plan"
          value={planCode}
          onValueChange={setPlanCode}
          options={choosable.map((p) => ({ value: p.code, label: `${p.name} (${p.code})` }))}
          error={fields.planCode}
        />
        <Textarea
          label="Reason"
          value={planReason}
          onChange={(e) => setPlanReason(e.target.value)}
          error={fields.reason}
          required
        />
      </FormDrawer>

      <FormDrawer
        open={openOverride}
        onOpenChange={setOpenOverride}
        title="Override limits"
        submitLabel="Save override"
        onFieldErrors={setFields}
        onSubmit={async () => {
          const body = overrideBody(form, overrideFrom(account.entitlements, plan));
          if ('error' in body) {
            setFields({ [body.field]: body.error });
            throw 'Check the limits.';
          }
          onChanged(
            await api.call('setAccountOverride', {
              params,
              body: { version: account.version, override: body.override, reason: overrideReason },
            }),
          );
          toast({ tone: 'success', message: 'Limits saved.' });
        }}
      >
        <p className="text-body text-muted">
          Blank keeps the plan&apos;s limit. Type &quot;unlimited&quot; to lift one.
        </p>
        {LIMIT_KEYS.map((key) => (
          <Input
            key={key}
            label={LIMIT_LABEL[key]}
            value={form.limits[key]}
            inputMode="numeric"
            placeholder={limitText(plan?.limits[key])}
            onChange={(e) =>
              setForm((f) => ({ ...f, limits: { ...f.limits, [key]: e.target.value } }))
            }
            error={fields[key] ?? fields[`override.limits.${key}`]}
          />
        ))}
        <Input
          label="Extra features"
          value={form.features}
          onChange={(e) => setForm((f) => ({ ...f, features: e.target.value }))}
          helper="Feature names, separated by commas. Add-ons have their own switches."
          error={fields.features ?? fields['override.features'] ?? fields['override.features.0']}
        />
        <Textarea
          label="Note (optional)"
          value={form.note}
          onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
        />
        <Textarea
          label="Reason"
          value={overrideReason}
          onChange={(e) => setOverrideReason(e.target.value)}
          error={fields.reason}
          required
        />
      </FormDrawer>
    </Card>
  );
}
