'use client';
// Provision an account (ADR M15-0001 decision 10): the firm waits in PROVISIONING until its owner accepts the invite
// the API sends. One Idempotency-Key per form, so a retry after a dropped answer cannot create a second account.
import { DEFAULT_TRIAL_DAYS, type AccountCreateBody, type AccountKind } from '@canopy/contracts';
import { Button, DateInput, Input, RadioGroup, Select, toast } from '@canopy/ui';
import { useState, type FormEvent } from 'react';

import { errorMessage, fieldErrors } from '../api';
import { MONTH_OPTIONS, todayInIndia } from '../format';
import { useSession } from '../session';
import { useLoad } from '../use-load';
import { Card, FormError, Loading, LoadError, PageHeader } from '../ui/parts';

type Term = 'trial' | 'trialUntil' | 'activeNow';

export type NewAccountValues = {
  name: string;
  kind: AccountKind;
  planCode: string;
  legalName: string;
  gstin: string;
  timeZone: string;
  fyStartMonth: string;
  term: Term;
  trialEndsOn: string;
  clientName: string;
  ownerName: string;
  ownerEmail: string;
};

/** The request body for the form's values; blanks become the API's defaults. */
export function createBody(v: NewAccountValues): AccountCreateBody {
  const trimmed = (s: string) => s.trim();
  return {
    name: trimmed(v.name),
    kind: v.kind,
    planCode: v.planCode,
    legalName: trimmed(v.legalName) || trimmed(v.name),
    gstin: trimmed(v.gstin) ? trimmed(v.gstin).toUpperCase() : null,
    timeZone: trimmed(v.timeZone) || 'Asia/Kolkata',
    fyStartMonth: Number(v.fyStartMonth),
    activeNow: v.term === 'activeNow',
    ...(v.term === 'trialUntil' && v.trialEndsOn
      ? { trialEndsOn: v.trialEndsOn as AccountCreateBody['trialEndsOn'] }
      : {}),
    ...(v.kind === 'ENTERPRISE' && trimmed(v.clientName)
      ? { clientName: trimmed(v.clientName) }
      : {}),
    owner: { displayName: trimmed(v.ownerName), email: trimmed(v.ownerEmail) },
  };
}

const EMPTY: NewAccountValues = {
  name: '',
  kind: 'ENTERPRISE',
  planCode: '',
  legalName: '',
  gstin: '',
  timeZone: 'Asia/Kolkata',
  fyStartMonth: '4',
  term: 'trial',
  trialEndsOn: '',
  clientName: '',
  ownerName: '',
  ownerEmail: '',
};

export function NewAccountForm({ navigate }: { navigate: (href: string) => void }) {
  const { api } = useSession();
  const plans = useLoad(() => api.call('listPlans'), 'plans');
  const [values, setValues] = useState(EMPTY);
  const [key] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const set = <K extends keyof NewAccountValues>(name: K, value: NewAccountValues[K]) =>
    setValues((v) => ({ ...v, [name]: value }));

  if (plans.state === 'loading') return <Loading label="Loading plans" />;
  if (plans.state === 'error') return <LoadError message={plans.message} onRetry={plans.reload} />;
  const choosable = plans.data.items.filter((p) => p.retiredAt === null);
  const planCode = values.planCode || choosable[0]?.code || '';

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setFields({});
    try {
      const account = await api.call('createAccount', {
        body: createBody({ ...values, planCode }),
        idempotencyKey: key,
      });
      toast({
        tone: 'success',
        message: `${account.name} is created. Its owner has an invite to sign in.`,
      });
      navigate(`/accounts/${account.id}`);
    } catch (e) {
      setFields(fieldErrors(e));
      setError(errorMessage(e));
      setPending(false);
    }
  }

  const err = (name: string) => fields[name];

  return (
    <>
      <PageHeader
        title="New account"
        description="The account waits for its owner: they get an email invite and the account opens when they accept."
      />
      <form onSubmit={onSubmit} noValidate className="max-w-3xl">
        <FormError message={error} />
        <Card title="Account">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label="Display name"
              value={values.name}
              onChange={(e) => set('name', e.target.value)}
              error={err('name')}
              required
            />
            <Input
              label="Legal name"
              value={values.legalName}
              onChange={(e) => set('legalName', e.target.value)}
              helper="Leave blank to use the display name."
              error={err('legalName')}
            />
            <RadioGroup
              label="Kind"
              value={values.kind}
              onValueChange={(v) => set('kind', v as AccountKind)}
              options={[
                { value: 'ENTERPRISE', label: 'Company: manages its own compliance' },
                { value: 'CONSULTANCY', label: 'Consultancy: manages many clients' },
              ]}
            />
            <Select
              label="Plan"
              value={planCode}
              onValueChange={(v) => set('planCode', v)}
              options={choosable.map((p) => ({ value: p.code, label: `${p.name} (${p.code})` }))}
              error={err('planCode')}
            />
            <Input
              label="GSTIN"
              value={values.gstin}
              onChange={(e) => set('gstin', e.target.value)}
              helper="Optional, 15 characters."
              error={err('gstin')}
            />
            {values.kind === 'ENTERPRISE' ? (
              <Input
                label="Company name in the register"
                value={values.clientName}
                onChange={(e) => set('clientName', e.target.value)}
                helper="Leave blank to use the display name."
                error={err('clientName')}
              />
            ) : null}
            <Input
              label="Time zone"
              value={values.timeZone}
              onChange={(e) => set('timeZone', e.target.value)}
              error={err('timeZone')}
            />
            <Select
              label="Financial year starts in"
              value={values.fyStartMonth}
              onValueChange={(v) => set('fyStartMonth', v)}
              options={MONTH_OPTIONS}
            />
          </div>
        </Card>
        <Card title="Trial or paid">
          <RadioGroup
            label="When the owner accepts"
            value={values.term}
            onValueChange={(v) => set('term', v as Term)}
            options={[
              { value: 'trial', label: `Start a ${DEFAULT_TRIAL_DAYS}-day trial` },
              { value: 'trialUntil', label: 'Start a trial that ends on a date' },
              { value: 'activeNow', label: 'Open as a paid account, no trial' },
            ]}
          />
          {values.term === 'trialUntil' ? (
            <div className="mt-3 max-w-xs">
              <DateInput
                label="Trial ends on"
                value={values.trialEndsOn || null}
                onValueChange={(v) => set('trialEndsOn', v ?? '')}
                min={todayInIndia()}
                today={todayInIndia()}
                error={err('trialEndsOn')}
              />
            </div>
          ) : null}
        </Card>
        <Card title="Owner">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label="Owner's name"
              value={values.ownerName}
              onChange={(e) => set('ownerName', e.target.value)}
              error={err('owner.displayName')}
              required
            />
            <Input
              label="Owner's email"
              type="email"
              value={values.ownerEmail}
              onChange={(e) => set('ownerEmail', e.target.value)}
              error={err('owner.email')}
              helper="The invite goes here; the link works for 72 hours."
              required
            />
          </div>
        </Card>
        <div className="flex gap-2">
          <Button type="submit" loading={pending}>
            Create account
          </Button>
          <Button type="button" variant="secondary" onClick={() => navigate('/accounts')}>
            Cancel
          </Button>
        </div>
      </form>
    </>
  );
}
