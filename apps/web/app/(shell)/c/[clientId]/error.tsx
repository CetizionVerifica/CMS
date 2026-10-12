'use client';
import { PageError } from '../../../../lib/patterns';

export default function ShellError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError reference={error.digest} onRetry={reset} homeHref="/" />;
}
