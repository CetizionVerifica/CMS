'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { LoginForm } from '../../lib/screens/LoginForm';

function Login() {
  const router = useRouter();
  const next = useSearchParams().get('next');
  return <LoginForm next={next} navigate={(href) => router.replace(href)} />;
}

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}
