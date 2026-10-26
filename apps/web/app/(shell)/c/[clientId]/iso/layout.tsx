import type { ReactNode } from 'react';

import { FeatureNotEnabled } from '../../../../../lib/patterns';
import { isoGate } from './_lib/gate';

type Props = { children: ReactNode; params: Promise<{ clientId: string }> };

// Every ISO page sits under this layout (packages.md ISO-6a). Without the add-on it shows the shell's off page and none
// of the pages' content; each page also checks the gate itself before it loads anything, because Next renders a page
// alongside its layout.
export default async function IsoLayout({ children, params }: Props) {
  const { clientId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return <FeatureNotEnabled feature="isoManagement" homeHref={gate.homeHref} />;
  return children;
}
