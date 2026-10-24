'use client';
// The account page: the plan's limits beside what the account uses (read-only: PlanetPulse changes plans), and
// PlanetPulse support access, which only account admins grant and end (ADR M15-0001 decision 11).
import type { SupportGrant } from '@canopy/contracts';
import { Button, ConfirmDialog, formatDate, Select } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { grantSupportAction, revokeSupportAction } from './actions';
import {
  DAY_OPTIONS,
  formatInstant,
  grantRows,
  grantSummary,
  planName,
  SUPPORT_LEVEL,
  type UsageRow,
} from './account-model';

function Alert({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-body text-crit-ink">
      {message}
    </p>
  ) : null;
}

const th = 'px-4 py-2 font-semibold';

export function PlanUsage({
  plan,
  trialEndsOn,
  usage,
}: {
  plan: string;
  trialEndsOn: string | null;
  usage: UsageRow[];
}) {
  return (
    <section aria-labelledby="plan-heading" className="flex flex-col gap-3">
      <h2 id="plan-heading" className="text-section text-ink">
        Plan and usage
      </h2>
      <p className="text-body text-muted">
        Plan: <span className="font-semibold text-ink">{planName(plan)}</span>.
        {trialEndsOn ? ` The trial ends on ${formatDate(trialEndsOn)}.` : ''} To change the plan,
        contact PlanetPulse.
      </p>
      <div
        role="region"
        aria-label="Plan limits and usage"
        tabIndex={0}
        className="overflow-x-auto rounded-card border border-line bg-surface"
      >
        <table className="w-full text-body">
          <caption className="sr-only">Plan limits and usage</caption>
          <thead>
            <tr className="border-b border-line text-left text-meta text-muted">
              <th scope="col" className={th}>
                Limit
              </th>
              <th scope="col" className={th}>
                In use
              </th>
              <th scope="col" className={th}>
                Plan allows
              </th>
            </tr>
          </thead>
          <tbody>
            {usage.map((row) => (
              <tr key={row.label} className="border-b border-line last:border-b-0">
                <th scope="row" className="px-4 py-2 text-left font-semibold text-ink">
                  {row.label}
                </th>
                <td className="px-4 py-2 text-ink">
                  {row.used}
                  {row.atLimit ? (
                    <span className="ml-2 text-meta text-crit-ink">At the limit</span>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-muted">{row.limit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function SupportAccess({ grants }: { grants: SupportGrant[] }) {
  const router = useRouter();
  const live = grants.find((g) => g.status === 'ACTIVE');
  const [level, setLevel] = useState<SupportGrant['level']>('READ_ONLY');
  const [days, setDays] = useState('7');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const rows = grantRows(grants);

  // Admin access, or replacing a live grant, changes what PlanetPulse can do here, so it is confirmed first.
  const needsConfirm = level === 'ADMIN' || live !== undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (needsConfirm) setConfirming(true);
    else void grant();
  }

  async function grant() {
    setBusy(true);
    setMessage(null);
    const result = await grantSupportAction({ level, days: Number(days) });
    setBusy(false);
    if (!result.ok) setMessage(result.message);
    router.refresh();
  }

  return (
    <section aria-labelledby="support-heading" className="flex flex-col gap-3">
      <h2 id="support-heading" className="text-section text-ink">
        PlanetPulse support access
      </h2>
      <p className="text-body text-muted">
        PlanetPulse can only see this account while you let it in. Everything support does is
        recorded in the audit trail, and you can end the access at any time.
      </p>
      <Alert message={message} />
      {live ? (
        <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-body text-ink">
            <span className="font-semibold">{SUPPORT_LEVEL[live.level].label}</span> access until{' '}
            {formatInstant(live.endsAt)}.
          </p>
          <Button variant="secondary" onClick={() => setRevoking(true)}>
            End access now
          </Button>
        </div>
      ) : null}
      <form
        onSubmit={submit}
        aria-label="Let support in"
        className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4"
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-body font-semibold text-ink">Access</legend>
          {(['READ_ONLY', 'ADMIN'] as const).map((value) => (
            <label key={value} className="flex items-start gap-2 text-body text-ink">
              <input
                type="radio"
                name="level"
                value={value}
                checked={level === value}
                onChange={() => setLevel(value)}
                className="mt-1"
              />
              <span>
                <span className="font-semibold">{SUPPORT_LEVEL[value].label}</span>.{' '}
                <span className="text-muted">{SUPPORT_LEVEL[value].detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="max-w-[240px]">
          <Select label="For" options={DAY_OPTIONS} value={days} onValueChange={setDays} />
        </div>
        <div>
          <Button type="submit" variant="primary" loading={busy}>
            {live ? 'Replace the current access' : 'Let support in'}
          </Button>
        </div>
      </form>
      {rows.length > 0 ? (
        <div
          role="region"
          aria-label="Support access history"
          tabIndex={0}
          className="overflow-x-auto rounded-card border border-line bg-surface"
        >
          <table className="w-full text-body">
            <caption className="sr-only">Support access history</caption>
            <thead>
              <tr className="border-b border-line text-left text-meta text-muted">
                <th scope="col" className={th}>
                  Access
                </th>
                <th scope="col" className={th}>
                  Status
                </th>
                <th scope="col" className={th}>
                  From
                </th>
                <th scope="col" className={th}>
                  Until
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-b-0">
                  <th scope="row" className="px-4 py-2 text-left font-semibold text-ink">
                    {row.level}
                  </th>
                  <td className="px-4 py-2 text-ink">{row.status}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-muted">{row.from}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-muted">{row.until}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={
          live
            ? 'Replace the current PlanetPulse support access?'
            : 'Give PlanetPulse support admin access?'
        }
        body={grantSummary(level, Number(days), new Date(), live !== undefined)}
        confirmLabel={live ? 'Replace access' : 'Give admin access'}
        onConfirm={grant}
      />
      {live ? (
        <ConfirmDialog
          open={revoking}
          onOpenChange={setRevoking}
          title="End PlanetPulse support access now?"
          body="Support is signed out straight away and can't come back unless you let it in again."
          confirmLabel="End access"
          tone="danger"
          onConfirm={async () => {
            const result = await revokeSupportAction(live.id);
            router.refresh();
            if (!result.ok) {
              setMessage(result.message);
              throw new Error(result.message);
            }
          }}
        />
      ) : null}
    </section>
  );
}
