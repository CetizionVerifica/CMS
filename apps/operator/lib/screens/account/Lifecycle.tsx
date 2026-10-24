'use client';
// The account's lifecycle buttons: convert, suspend, resume, trial end, owner invite, onboarding and deletion. Each
// consequential one asks for a typed reason, which goes into both audit trails.
import type { Account } from '@canopy/contracts';
import { Button, ConfirmDialog, DateInput, Input, Textarea, toast } from '@canopy/ui';
import { useState } from 'react';

import { accountActions, type AccountAction } from '../../account-actions';
import { errorMessage } from '../../api';
import { formatDate, todayInIndia } from '../../format';
import { useSession } from '../../session';
import { FormDrawer } from '../../ui/FormDrawer';

type Open = AccountAction | null;

const REASON = { label: 'Reason', required: true, minLength: 1, maxLength: 2000 } as const;

export function Lifecycle({
  account,
  onChanged,
}: {
  account: Account;
  onChanged: (account: Account) => void;
}) {
  const { api } = useSession();
  const [open, setOpen] = useState<Open>(null);
  const [trialEnd, setTrialEnd] = useState<string | null>(account.trialEndsOn);
  const [trialReason, setTrialReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const actions = accountActions(account);
  const params = { id: account.id };
  const { version } = account;

  // The dialog says only that it failed; the toast says why (a stale version, a refused move).
  const guard =
    (fn: (reason?: string) => Promise<void>) =>
    async (reason?: string): Promise<void> => {
      try {
        await fn(reason);
      } catch (error) {
        toast({ tone: 'error', message: errorMessage(error) });
        throw error;
      }
    };
  const close = (next: boolean) => {
    if (!next) setOpen(null);
  };
  const done = (changed: Account, message: string) => {
    onChanged(changed);
    toast({ tone: 'success', message });
  };

  const status = (to: 'ACTIVE' | 'SUSPENDED', message: string) => async (reason?: string) =>
    done(
      await api.call('setAccountStatus', { params, body: { version, to, reason: reason ?? '' } }),
      message,
    );

  const buttons: { action: AccountAction; label: string; danger?: boolean }[] = [
    { action: 'resendInvite', label: 'Resend owner invite' },
    { action: 'convert', label: 'Convert to paid' },
    { action: 'extendTrial', label: 'Change trial end' },
    { action: 'resume', label: 'Resume account' },
    { action: 'markOnboarded', label: 'Mark onboarded' },
    { action: 'suspend', label: 'Suspend account', danger: true },
    { action: 'requestDeletion', label: 'Delete account', danger: true },
    { action: 'cancelDeletion', label: 'Cancel deletion' },
  ];

  return (
    <>
      <div className="flex flex-wrap gap-2" aria-label="Account actions" role="group">
        {buttons
          .filter((b) => actions.includes(b.action))
          .map((b) => (
            <Button
              key={b.action}
              variant={b.danger ? 'danger' : 'secondary'}
              size="sm"
              onClick={() => {
                setFields({});
                if (b.action === 'extendTrial') {
                  setTrialEnd(account.trialEndsOn);
                  setTrialReason('');
                }
                if (b.action === 'requestDeletion') {
                  setConfirmName('');
                  setDeleteReason('');
                }
                setOpen(b.action);
              }}
            >
              {b.label}
            </Button>
          ))}
      </div>

      <ConfirmDialog
        open={open === 'convert'}
        onOpenChange={close}
        title={`Convert ${account.name} to a paid account?`}
        body="The trial ends now and the account stays open. Record the subscription under Billing."
        confirmLabel="Convert to paid"
        reason={REASON}
        onConfirm={guard(status('ACTIVE', `${account.name} is now a paid account.`))}
      />
      <ConfirmDialog
        open={open === 'suspend'}
        onOpenChange={close}
        title={`Suspend ${account.name}?`}
        body="Nobody in the account can sign in until you resume it. Their data stays as it is."
        confirmLabel="Suspend account"
        tone="danger"
        reason={{ ...REASON, helper: 'The customer sees this reason in their audit trail.' }}
        onConfirm={guard(status('SUSPENDED', `${account.name} is suspended.`))}
      />
      <ConfirmDialog
        open={open === 'resume'}
        onOpenChange={close}
        title={`Resume ${account.name}?`}
        body="Everyone in the account can sign in again."
        confirmLabel="Resume account"
        reason={REASON}
        onConfirm={guard(status('ACTIVE', `${account.name} is open again.`))}
      />
      <ConfirmDialog
        open={open === 'resendInvite'}
        onOpenChange={close}
        title="Send the owner a new invite?"
        body="The owner gets a fresh link, valid for 72 hours. Earlier links stop working."
        confirmLabel="Resend invite"
        onConfirm={guard(async () => {
          await api.call('resendOwnerInvite', { params });
          toast({ tone: 'success', message: 'The owner has a new invite.' });
        })}
      />
      <ConfirmDialog
        open={open === 'markOnboarded'}
        onOpenChange={close}
        title={`Mark ${account.name} as onboarded?`}
        body="Records that setup with the customer is finished. It is shown on the account and in reports."
        confirmLabel="Mark onboarded"
        onConfirm={guard(async () =>
          done(
            await api.call('markOnboarded', { params, body: { version } }),
            `${account.name} is marked as onboarded.`,
          ),
        )}
      />
      <ConfirmDialog
        open={open === 'cancelDeletion'}
        onOpenChange={close}
        title={`Cancel the deletion of ${account.name}?`}
        body="The account goes back to the status it had before the request."
        confirmLabel="Cancel deletion"
        reason={REASON}
        onConfirm={guard(async (reason) =>
          done(
            await api.call('cancelAccountDeletion', {
              params,
              body: { version, reason: reason ?? '' },
            }),
            `${account.name} will not be deleted.`,
          ),
        )}
      />

      <FormDrawer
        open={open === 'extendTrial'}
        onOpenChange={close}
        title="Change the trial end"
        submitLabel="Save trial end"
        onFieldErrors={setFields}
        onSubmit={async () => {
          if (!trialEnd) throw 'Choose the day the trial ends.';
          done(
            await api.call('extendTrial', {
              params,
              body: {
                version,
                trialEndsOn: trialEnd as Account['trialEndsOn'] & string,
                ...(trialReason.trim() ? { reason: trialReason.trim() } : {}),
              },
            }),
            `The trial now ends on ${formatDate(trialEnd)}.`,
          );
        }}
      >
        <DateInput
          label="Trial ends on"
          value={trialEnd}
          onValueChange={setTrialEnd}
          min={todayInIndia()}
          today={todayInIndia()}
          error={fields.trialEndsOn}
        />
        <Textarea
          label="Reason (optional)"
          value={trialReason}
          onChange={(e) => setTrialReason(e.target.value)}
          error={fields.reason}
        />
      </FormDrawer>

      <FormDrawer
        open={open === 'requestDeletion'}
        onOpenChange={close}
        title={`Delete ${account.name}`}
        submitLabel="Request deletion"
        tone="danger"
        onFieldErrors={setFields}
        onSubmit={async () => {
          if (confirmName !== account.name) throw 'Type the account name exactly as shown.';
          done(
            await api.call('requestAccountDeletion', {
              params,
              body: { version, confirmName, reason: deleteReason },
            }),
            `${account.name} will be deleted after 30 days unless you cancel.`,
          );
        }}
      >
        <p className="text-body text-ink">
          Only the account&apos;s admins can sign in, to download their data. After 30 days
          everything in the account is deleted for good. You can cancel until then.
        </p>
        <Input
          label={`Type “${account.name}” to confirm`}
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
          error={fields.confirmName}
          autoComplete="off"
        />
        <Textarea
          label="Reason"
          value={deleteReason}
          onChange={(e) => setDeleteReason(e.target.value)}
          error={fields.reason}
          required
        />
      </FormDrawer>
    </>
  );
}
