import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getMe, mfaPending, mfaStepPath } from '../../../../lib/api/server';
import { MfaForm } from '../../../../lib/auth/forms';
import { safeNextPath } from '../../../../lib/routes';

export const metadata: Metadata = { title: 'Verify sign-in' };

type Props = { searchParams: Promise<{ next?: string | string[] }> };

// Second step for firm roles (MFA is required for firm admins and consultants).
export default async function VerifyPage({ searchParams }: Props) {
  const raw = (await searchParams).next;
  const next = safeNextPath(Array.isArray(raw) ? raw[0] : raw);
  const me = await getMe();
  if (!me) redirect(`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  if (!mfaPending(me)) redirect(next ?? '/');
  // No authenticator yet, so no code to enter: set one up first.
  if (!me.mfa.enrolled) redirect(mfaStepPath(me, next));
  return (
    <>
      <h1 className="mb-1 text-page text-ink">Verify it’s you</h1>
      <p className="mb-4 text-body text-muted">Enter the code from your authenticator app.</p>
      <MfaForm next={next} />
    </>
  );
}
