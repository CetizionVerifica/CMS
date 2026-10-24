'use client';
import { useParams } from 'next/navigation';

import { AccountDetail } from '../../../../lib/screens/account/AccountDetail';

export default function AccountPage() {
  const { id } = useParams<{ id: string }>();
  return <AccountDetail id={id} />;
}
