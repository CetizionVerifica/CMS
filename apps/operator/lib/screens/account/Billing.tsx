'use client';
// Offline billing (ADR M15-0001 decision 6): the subscriptions the operator recorded, a form to record one, and the
// nightly usage counts for the last 30 days.
import { LocalDate, type Account, type Plan } from '@canopy/contracts';
import { Button, DateInput, EmptyState, Input, Select, toast } from '@canopy/ui';
import { useState } from 'react';

import { formatDate, formatRupees, paiseFrom, shiftDate, todayInIndia } from '../../format';
import { useSession } from '../../session';
import { useLoad } from '../../use-load';
import { FormDrawer } from '../../ui/FormDrawer';
import { Card, cell, Loading, LoadError, Table } from '../../ui/parts';

type Draft = {
  planCode: string;
  startsOn: string | null;
  endsOn: string | null;
  amount: string;
  invoiceNumber: string;
  paidOn: string | null;
};

export function Billing({ account, plans }: { account: Account; plans: Plan[] }) {
  const { api } = useSession();
  const params = { id: account.id };
  const subscriptions = useLoad(
    () => api.call('listSubscriptions', { params }),
    `subs:${account.id}`,
  );
  const today = todayInIndia();
  const from = shiftDate(today, -30);
  const usage = useLoad(
    () =>
      api.call('listUsage', {
        params,
        query: { from: LocalDate.parse(from), to: LocalDate.parse(today) },
      }),
    `usage:${account.id}`,
  );
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState<Draft>({
    planCode: account.planCode,
    startsOn: null,
    endsOn: null,
    amount: '',
    invoiceNumber: '',
    paidOn: null,
  });
  const [fields, setFields] = useState<Record<string, string>>({});
  const set = <K extends keyof Draft>(name: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [name]: value }));

  return (
    <>
      <Card
        id="billing"
        title="Billing"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setDraft({
                planCode: account.planCode,
                startsOn: today,
                endsOn: shiftDate(today, 364),
                amount: '',
                invoiceNumber: '',
                paidOn: null,
              });
              setKey(crypto.randomUUID());
              setFields({});
              setOpen(true);
            }}
          >
            Record subscription
          </Button>
        }
      >
        {subscriptions.state === 'loading' ? (
          <Loading label="Loading subscriptions" />
        ) : subscriptions.state === 'error' ? (
          <LoadError message={subscriptions.message} onRetry={subscriptions.reload} />
        ) : subscriptions.data.items.length === 0 ? (
          <EmptyState
            variant="first-use"
            size="card"
            headingLevel={3}
            title="No subscription recorded"
            body="Record one when the customer pays, so renewals can remind you."
          />
        ) : (
          <Table caption="Subscriptions" head={['Plan', 'From', 'To', 'Amount', 'Invoice', 'Paid']}>
            {subscriptions.data.items.map((s) => (
              <tr key={s.id}>
                <td className={cell}>{s.planCode}</td>
                <td className={cell}>{formatDate(s.startsOn)}</td>
                <td className={cell}>{formatDate(s.endsOn)}</td>
                <td className={cell}>{formatRupees(s.amountPaise)}</td>
                <td className={cell}>{s.invoiceNumber ?? '—'}</td>
                <td className={cell}>{s.paidOn ? formatDate(s.paidOn) : 'Not yet'}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card id="usage" title="Usage, last 30 days">
        {usage.state === 'loading' ? (
          <Loading label="Loading usage" />
        ) : usage.state === 'error' ? (
          <LoadError message={usage.message} onRetry={usage.reload} />
        ) : usage.data.items.length === 0 ? (
          <p className="text-body text-muted">No nightly counts yet. The first one runs tonight.</p>
        ) : (
          <Table
            caption="Nightly usage"
            head={['Day', 'Companies', 'Units', 'Users', 'Active users (30 days)', 'Instances']}
          >
            {usage.data.items.map((u) => (
              <tr key={u.takenOn}>
                <td className={cell}>{formatDate(u.takenOn)}</td>
                <td className={cell}>{u.usage.companies}</td>
                <td className={cell}>{u.usage.units}</td>
                <td className={cell}>{u.usage.users}</td>
                <td className={cell}>{u.activeUsers30d}</td>
                <td className={cell}>{u.instances}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <FormDrawer
        open={open}
        onOpenChange={setOpen}
        title="Record subscription"
        submitLabel="Record subscription"
        onFieldErrors={setFields}
        onSubmit={async () => {
          const amountPaise = paiseFrom(draft.amount);
          if (amountPaise === null) {
            setFields({ amountPaise: 'An amount in rupees, for example 120000 or 1,20,000.50' });
            throw 'Check the amount.';
          }
          if (!draft.startsOn || !draft.endsOn) throw 'Give the first and last day of the term.';
          await api.call('recordSubscription', {
            params,
            idempotencyKey: key,
            body: {
              planCode: draft.planCode,
              startsOn: LocalDate.parse(draft.startsOn),
              endsOn: LocalDate.parse(draft.endsOn),
              amountPaise,
              invoiceNumber: draft.invoiceNumber.trim() || null,
              paidOn: draft.paidOn ? LocalDate.parse(draft.paidOn) : null,
            },
          });
          toast({ tone: 'success', message: 'Subscription recorded.' });
          subscriptions.reload();
        }}
      >
        <Select
          label="Plan"
          value={draft.planCode}
          onValueChange={(v) => set('planCode', v)}
          options={plans.map((p) => ({ value: p.code, label: `${p.name} (${p.code})` }))}
          error={fields.planCode}
        />
        <DateInput
          label="First day"
          value={draft.startsOn}
          onValueChange={(v) => set('startsOn', v)}
          today={today}
          error={fields.startsOn}
        />
        <DateInput
          label="Last day"
          value={draft.endsOn}
          onValueChange={(v) => set('endsOn', v)}
          today={today}
          error={fields.endsOn}
        />
        <Input
          label="Amount (₹)"
          value={draft.amount}
          inputMode="decimal"
          onChange={(e) => set('amount', e.target.value)}
          error={fields.amountPaise}
        />
        <Input
          label="Invoice number (optional)"
          value={draft.invoiceNumber}
          onChange={(e) => set('invoiceNumber', e.target.value)}
          error={fields.invoiceNumber}
        />
        <DateInput
          label="Paid on (optional)"
          value={draft.paidOn}
          onValueChange={(v) => set('paidOn', v)}
          today={today}
          error={fields.paidOn}
        />
      </FormDrawer>
    </>
  );
}
