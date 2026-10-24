import type { InvitePreview } from '@canopy/contracts';
import type { Metadata } from 'next';

import { isApiError } from '../../../../lib/api/client';
import { serverApi } from '../../../../lib/api/server';
import { InviteForm } from '../../../../lib/auth/forms';

export const metadata: Metadata = { title: 'Accept invite' };

type Props = { params: Promise<{ token: string }> };

export default async function InvitePage({ params }: Props) {
  const { token } = await params;
  let invite: InvitePreview | undefined;
  try {
    invite = (await (await serverApi()).invite(token)).data;
  } catch (error) {
    // A malformed token is rejected as VALIDATION before the lookup; both mean the link is no good.
    if (!isApiError(error, 'NOT_FOUND', 'VALIDATION')) throw error;
  }

  if (!invite) {
    return (
      <>
        <h1 className="mb-1 text-page text-ink">This invite isn’t valid</h1>
        <p className="text-body text-muted">
          It may have expired or already been used. Ask your consultant to send a new one.
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="mb-1 text-page text-ink">Welcome, {invite.displayName}</h1>
      <p className="mb-4 text-body text-muted">
        {invite.firmName} invited you
        {invite.clientName ? ` to work on ${invite.clientName}` : ''}. Set a password to finish.
      </p>
      <InviteForm
        token={token}
        email={invite.email}
        displayName={invite.displayName}
        mfaRequired={invite.mfaRequired === true}
      />
    </>
  );
}
