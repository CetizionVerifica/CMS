'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { RenewalsScreen } from '../../../lib/screens/RenewalsScreen';

function Renewals() {
  const router = useRouter();
  const pathname = usePathname();
  const days = useSearchParams().get('within') ?? '30';
  return (
    <RenewalsScreen
      withinDays={days}
      onWindowChange={(d) => router.replace(d === '30' ? pathname : `${pathname}?within=${d}`)}
    />
  );
}

export default function RenewalsPage() {
  return (
    <Suspense>
      <Renewals />
    </Suspense>
  );
}
