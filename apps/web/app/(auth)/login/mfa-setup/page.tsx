import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getMe, mfaPending, mfaStepPath } from '../../../../lib/api/server';
import { MfaSetupForm } from '../../../../lib/auth/forms';
import { safeNextPath } from '../../../../lib/routes';

export const metadata: Metadata = { title: 'Set up sign-in codes' };

type Props = { searchParams: Promise<{ next?: string | string[] }> };

// Second step for a firm admin or consultant who has no authenticator yet: MFA is required for firm roles, so they
// set one up before their first code.
export default async function MfaSetupPage({ searchParams }: Props) {
  const raw = (await searchParams).next;
  const next = safeNextPath(Array.isArray(raw) ? raw[0] : raw);
  const me = await getMe();
  if (!me) redirect(`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  if (!mfaPending(me)) redirect(next ?? '/');
  if (me.mfa.enrolled) redirect(mfaStepPath(me, next));
  return (
    <>
      <h1 className="mb-1 text-page text-ink">Set up sign-in codes</h1>
      <p className="mb-4 text-body text-muted">
        Your role signs in with a code from an authenticator app as well as your password. Set one
        up once, on your phone.
      </p>
      <MfaSetupForm next={next} />
    </>
  );
}
