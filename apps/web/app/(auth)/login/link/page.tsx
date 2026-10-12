import type { Metadata } from 'next';

import { MagicLinkForm } from '../../../../lib/auth/forms';

export const metadata: Metadata = { title: 'Sign in' };

type Props = { searchParams: Promise<{ token?: string | string[] }> };

// Opened from the emailed sign-in link.
export default async function MagicLinkPage({ searchParams }: Props) {
  const raw = (await searchParams).token;
  const token = Array.isArray(raw) ? raw[0] : raw;
  return (
    <>
      <h1 className="mb-1 text-page text-ink">Sign in</h1>
      {token ? (
        <>
          <p className="mb-4 text-body text-muted">
            Continue to sign in with the link from your email.
          </p>
          <MagicLinkForm token={token} />
        </>
      ) : (
        <p className="text-body text-muted">
          This link is incomplete. Open it again from the email, or request a new one from the
          sign-in page.
        </p>
      )}
    </>
  );
}
