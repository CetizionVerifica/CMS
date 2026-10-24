import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getMe, mfaPending, usingMockApi } from '../../../lib/api/server';
import { DemoAccounts } from '../../../lib/auth/DemoAccounts';
import { LoginForm } from '../../../lib/auth/forms';
import { safeNextPath } from '../../../lib/routes';

export const metadata: Metadata = { title: 'Sign in' };

type Props = { searchParams: Promise<{ next?: string | string[] }> };

export default async function LoginPage({ searchParams }: Props) {
  const raw = (await searchParams).next;
  const next = safeNextPath(Array.isArray(raw) ? raw[0] : raw);
  const me = await getMe();
  if (me && !mfaPending(me)) redirect(next ?? '/');
  return (
    <>
      <h1 className="mb-1 text-page text-ink">Sign in</h1>
      <p className="mb-4 text-body text-muted">Use the work email your consultant invited.</p>
      <LoginForm next={next} />
      {(await usingMockApi()) ? <DemoAccounts /> : null}
    </>
  );
}
