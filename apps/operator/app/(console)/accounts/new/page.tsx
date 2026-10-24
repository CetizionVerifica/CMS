'use client';
import { useRouter } from 'next/navigation';

import { NewAccountForm } from '../../../../lib/screens/NewAccountForm';

export default function NewAccountPage() {
  const router = useRouter();
  return <NewAccountForm navigate={(href) => router.push(href)} />;
}
