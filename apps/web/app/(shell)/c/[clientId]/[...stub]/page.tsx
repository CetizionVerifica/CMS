import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ComingSoon, FeatureNotEnabled, NoPermission } from '../../../../../lib/patterns';
import { clientHref, featureForPath, findRoute, visibleTo } from '../../../../../lib/routes';
import { loadShell } from '../../../../../lib/shell/server';

type Props = { params: Promise<{ clientId: string; stub: string[] }> };

// Client routes until M12, M13 or M17 ship their pages (a real page.tsx takes precedence); any other path is a 404.
// A record path such as /register/123 shows its list's placeholder. Any path under an add-on the account doesn't have
// (/iso/...) says the add-on is off here, so the URL tells nothing about its data. This stub only covers paths with no
// real page: once M17 adds iso/*/page.tsx, those pages take precedence over it, so M17's own iso/layout.tsx must render
// FeatureNotEnabled when the account lacks isoManagement (ADR M16-0001).
function routeFor(stub: string[]) {
  for (let n = stub.length; n > 0; n--) {
    const route = findRoute('client', stub.slice(0, n));
    if (route) return route;
  }
  return undefined;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId, stub } = await params;
  const model = await loadShell();
  const feature = featureForPath(stub);
  const off = feature !== undefined && !model.features.includes(feature);
  const route = off ? undefined : routeFor(stub);
  const client = model.clients.find((c) => c.id === clientId);
  if (off) return { title: ['Not turned on', client?.name].filter(Boolean).join(' · ') };
  return route ? { title: [route.label, client?.name].filter(Boolean).join(' · ') } : {};
}

export default async function ClientStub({ params }: Props) {
  const { clientId, stub } = await params;
  const model = await loadShell();
  const home = clientHref(clientId);
  const feature = featureForPath(stub);
  if (feature !== undefined && !model.features.includes(feature)) {
    return <FeatureNotEnabled feature={feature} homeHref={home} />;
  }
  const route = routeFor(stub);
  if (!route) notFound();
  if (!visibleTo(route, model.roles.byClient[clientId] ?? [])) {
    return (
      <NoPermission what={route.label.toLowerCase()} backHref={home} backLabel="Go to overview" />
    );
  }
  return <ComingSoon title={route.label} homeHref={route.path === 'overview' ? undefined : home} />;
}
