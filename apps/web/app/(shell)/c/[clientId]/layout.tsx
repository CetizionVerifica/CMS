import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { loadShell } from '../../../../lib/shell/server';

type Props = { children: ReactNode; params: Promise<{ clientId: string }> };

// Client routes: the client must be one of the user's. Any other id is a 404, never a 403, so the page doesn't
// reveal that another client exists (api-conventions.md §5, NOT_FOUND).
export default async function ClientLayout({ children, params }: Props) {
  const { clientId } = await params;
  const model = await loadShell();
  if (!model.clients.some((c) => c.id === clientId)) notFound();
  return children;
}
