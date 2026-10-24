'use client';
import { EmptyState } from '@canopy/ui';

export default function NotFound() {
  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-8">
      <h1 className="sr-only">Page not found</h1>
      <EmptyState
        variant="no-results"
        title="There is no page here"
        action={{ label: 'All accounts', href: '/accounts' }}
      />
    </main>
  );
}
