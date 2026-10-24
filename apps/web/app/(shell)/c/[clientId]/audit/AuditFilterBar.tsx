'use client';
// The audit trail's filter, kept in the URL so a filtered trail can be shared and Back works. A change restarts paging.
import { FilterBar, type FilterValue } from '@canopy/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { ACTION_FILTERS } from './audit-model';

const FILTERS = [
  {
    key: 'kind',
    label: 'Kind of change',
    kind: 'multi' as const,
    order: 'given' as const,
    options: ACTION_FILTERS.map(({ value, label }) => ({ value, label })),
  },
];

export function AuditFilterBar({
  kinds,
  resultText,
  resultCount,
}: {
  kinds: string[];
  resultText: string;
  resultCount: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const onChange = (next: Record<string, FilterValue>) => {
    const value = next.kind;
    const search = new URLSearchParams(params.toString());
    search.delete('cursor');
    if (Array.isArray(value) && value.length > 0) search.set('kind', value.join(','));
    else search.delete('kind');
    const query = search.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  };

  return (
    <FilterBar
      className="mb-3.5"
      filters={FILTERS}
      value={{ kind: kinds }}
      onChange={onChange}
      resultText={resultText}
      resultCount={resultCount}
    />
  );
}
