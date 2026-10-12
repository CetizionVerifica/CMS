import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { NoPermission, ComingSoon } from '../../../lib/patterns';
import { findRoute, visibleTo } from '../../../lib/routes';
import { homeHref } from '../../../lib/shell/model';
import { loadShell } from '../../../lib/shell/server';

type Props = { params: Promise<{ stub: string[] }> };

// Firm-level routes (portfolio, library) until M13 ships their pages; any other path is a 404.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const route = findRoute('firm', (await params).stub);
  return route ? { title: route.label } : {};
}

export default async function FirmStub({ params }: Props) {
  const route = findRoute('firm', (await params).stub);
  if (!route) notFound();
  const model = await loadShell();
  if (!visibleTo(route, model.roles.firm)) {
    return (
      <NoPermission
        what={route.label.toLowerCase()}
        backHref={homeHref(model)}
        backLabel="Go to home"
      />
    );
  }
  const home = homeHref(model);
  return <ComingSoon title={route.label} homeHref={home === `/${route.path}` ? undefined : home} />;
}
