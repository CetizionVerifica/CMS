import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ComingSoon, NoPermission } from '../../../../../lib/patterns';
import { clientHref, findRoute, visibleTo } from '../../../../../lib/routes';
import { loadShell } from '../../../../../lib/shell/server';

type Props = { params: Promise<{ clientId: string; stub: string[] }> };

// Client routes until M12 or M13 ship their pages (a real page.tsx takes precedence); any other path is a 404.
// A record path such as /register/123 shows its list's placeholder.
function routeFor(stub: string[]) {
  for (let n = stub.length; n > 0; n--) {
    const route = findRoute('client', stub.slice(0, n));
    if (route) return route;
  }
  return undefined;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId, stub } = await params;
  const route = routeFor(stub);
  const client = (await loadShell()).clients.find((c) => c.id === clientId);
  return route ? { title: [route.label, client?.name].filter(Boolean).join(' · ') } : {};
}

export default async function ClientStub({ params }: Props) {
  const { clientId, stub } = await params;
  const route = routeFor(stub);
  if (!route) notFound();
  const model = await loadShell();
  const home = clientHref(clientId);
  if (!visibleTo(route, model.roles.byClient[clientId] ?? [])) {
    return (
      <NoPermission what={route.label.toLowerCase()} backHref={home} backLabel="Go to overview" />
    );
  }
  return <ComingSoon title={route.label} homeHref={route.path === 'overview' ? undefined : home} />;
}
