'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { AuditScreen } from '../../../lib/screens/AuditScreen';

function Audit() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  return (
    <AuditScreen
      search={new URLSearchParams(search.toString())}
      onFiltersChange={(query) => router.replace(`${pathname}${query}`)}
    />
  );
}

export default function AuditPage() {
  return (
    <Suspense>
      <Audit />
    </Suspense>
  );
}
