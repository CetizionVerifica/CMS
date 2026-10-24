'use client';
// While the API reads the rows or commits them in the background, the page asks again every few seconds. The batch
// on the server says when it is done, so leaving and coming back resumes the same wait.
import { LoaderCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export function Waiting({ message, intervalMs = 2000 }: { message: string; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
  return (
    <p role="status" className="flex items-center gap-2 text-body text-muted">
      <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
      {message}
    </p>
  );
}
