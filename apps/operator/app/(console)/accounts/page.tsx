'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { AccountsList } from '../../../lib/screens/AccountsList';

function Accounts() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  return (
    <AccountsList
      search={new URLSearchParams(search.toString())}
      onFiltersChange={(query) => router.replace(`${pathname}${query}`)}
    />
  );
}

export default function AccountsPage() {
  return (
    <Suspense>
      <Accounts />
    </Suspense>
  );
}
