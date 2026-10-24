'use client';
// Plans are data: the operator names them and sets their limits without a release (ADR M15-0001 decision 5). A
// retired plan stays on the accounts that have it but cannot be chosen again.
import { PlanCode, type Plan } from '@canopy/contracts';
import { Button, Checkbox, EmptyState, Input, toast } from '@canopy/ui';
import { useState } from 'react';

import { featuresFrom, LIMIT_KEYS, LIMIT_LABEL, limitFrom } from '../account-actions';
import { formatBytes } from '../format';
import { useSession } from '../session';
import { useLoad } from '../use-load';
import { FormDrawer } from '../ui/FormDrawer';
import { cell, Loading, LoadError, PageHeader, Pill, Table } from '../ui/parts';

type Draft = {
  code: string;
  name: string;
  limits: Record<(typeof LIMIT_KEYS)[number], string>;
  features: string;
  retired: boolean;
};

const text = (v: number | null) => (v === null ? 'unlimited' : String(v));

const draftOf = (plan: Plan | null): Draft => ({
  code: plan?.code ?? '',
  name: plan?.name ?? '',
  limits: {
    companies: plan ? text(plan.limits.companies) : '',
    units: plan ? text(plan.limits.units) : '',
    users: plan ? text(plan.limits.users) : '',
    storageBytes: plan ? text(plan.limits.storageBytes) : 'unlimited',
  },
  features: plan?.features.join(', ') ?? '',
  retired: plan?.retiredAt != null,
});

/** The PUT body for a draft, or the field that is wrong. A plan sets every limit, so blank is an error here. */
export function planBody(draft: Draft):
  | {
      code: string;
      body: { name: string; limits: Plan['limits']; features: string[]; retired: boolean };
    }
  | { field: string; error: string } {
  const code = draft.code.trim().toUpperCase();
  if (!PlanCode.safeParse(code).success) {
    return { field: 'code', error: 'Capital letters, digits and underscores, for example GROWTH' };
  }
  const limits = {} as Plan['limits'];
  for (const key of LIMIT_KEYS) {
    const parsed = limitFrom(draft.limits[key]);
    if ('error' in parsed || parsed.value === undefined) {
      return { field: key, error: 'A whole number, or "unlimited"' };
    }
    limits[key] = parsed.value;
  }
  return {
    code,
    body: {
      name: draft.name.trim(),
      limits,
      features: featuresFrom(draft.features),
      retired: draft.retired,
    },
  };
}

export function PlansScreen() {
  const { api } = useSession();
  const plans = useLoad(() => api.call('listPlans'), 'plans');
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [fields, setFields] = useState<Record<string, string>>({});

  const edit = (plan: Plan | null) => {
    setDraft(draftOf(plan));
    setFields({});
    setEditing(plan ?? 'new');
  };

  const header = (
    <PageHeader
      title="Plans"
      description="Names, limits and features of each plan. Changes apply to every account on the plan at once."
      actions={<Button onClick={() => edit(null)}>New plan</Button>}
    />
  );
  if (plans.state === 'loading')
    return (
      <>
        {header}
        <Loading label="Loading plans" />
      </>
    );
  if (plans.state === 'error') {
    return (
      <>
        {header}
        <LoadError message={plans.message} onRetry={plans.reload} />
      </>
    );
  }

  return (
    <>
      {header}
      {plans.data.items.length === 0 ? (
        <EmptyState
          variant="first-use"
          title="No plans yet"
          action={{ label: 'New plan', onClick: () => edit(null) }}
        />
      ) : (
        <Table
          caption="Plans"
          head={['Plan', 'Companies', 'Units', 'Users', 'Storage', 'Features', '']}
        >
          {plans.data.items.map((p) => (
            <tr key={p.code}>
              <th scope="row" className={`${cell} font-semibold`}>
                {p.name} <span className="text-meta text-muted">{p.code}</span>{' '}
                {p.retiredAt ? <Pill tone="neutral">Retired</Pill> : null}
              </th>
              <td className={cell}>{text(p.limits.companies)}</td>
              <td className={cell}>{text(p.limits.units)}</td>
              <td className={cell}>{text(p.limits.users)}</td>
              <td className={cell}>
                {p.limits.storageBytes === null ? 'unlimited' : formatBytes(p.limits.storageBytes)}
              </td>
              <td className={cell}>{p.features.join(', ') || '—'}</td>
              <td className={cell}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => edit(p)}
                  aria-label={`Edit ${p.name}`}
                >
                  Edit
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <FormDrawer
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing === 'new' ? 'New plan' : `Edit ${draft.name}`}
        submitLabel="Save plan"
        onFieldErrors={setFields}
        onSubmit={async () => {
          const parsed = planBody(draft);
          if ('error' in parsed) {
            setFields({ [parsed.field]: parsed.error });
            throw 'Check the plan.';
          }
          await api.call('upsertPlan', { params: { code: parsed.code }, body: parsed.body });
          toast({ tone: 'success', message: `${parsed.body.name} saved.` });
          plans.reload();
        }}
      >
        <Input
          label="Code"
          value={draft.code}
          disabled={editing !== 'new'}
          onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))}
          helper="Fixed once the plan exists."
          error={fields.code}
        />
        <Input
          label="Name"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          error={fields.name}
        />
        {LIMIT_KEYS.map((key) => (
          <Input
            key={key}
            label={LIMIT_LABEL[key]}
            value={draft.limits[key]}
            onChange={(e) =>
              setDraft((d) => ({ ...d, limits: { ...d.limits, [key]: e.target.value } }))
            }
            error={fields[key] ?? fields[`limits.${key}`]}
          />
        ))}
        <Input
          label="Features"
          value={draft.features}
          onChange={(e) => setDraft((d) => ({ ...d, features: e.target.value }))}
          helper="Feature names, separated by commas."
          error={fields.features}
        />
        <Checkbox
          label="Retired: no new account can choose it"
          checked={draft.retired}
          onCheckedChange={(checked) => setDraft((d) => ({ ...d, retired: checked === true }))}
        />
      </FormDrawer>
    </>
  );
}
