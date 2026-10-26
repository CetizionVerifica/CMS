// The ISO add-on's gate for every page under iso/ (docs/iso/plan.md §4.4, packages.md ISO-6a). Next renders a page
// alongside its layout, so the layout showing FeatureNotEnabled is not enough: each page and each generateMetadata asks
// here first and loads nothing while the account lacks `isoManagement`.
import 'server-only';

import type { Role } from '@canopy/contracts';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { isApiError } from '../../../../../../lib/api/client';
import { requireMe } from '../../../../../../lib/api/server';
import { clientHref } from '../../../../../../lib/routes';
import type { ShellClient } from '../../../../../../lib/shell/model';
import { loadShell, requestPath } from '../../../../../../lib/shell/server';
import { refusalFor, type Refusal } from './refusal';

export const ISO_FEATURE = 'isoManagement';

export type IsoOff = { on: false; client: ShellClient; homeHref: string };
export type IsoOn = {
  on: true;
  client: ShellClient;
  homeHref: string;
  /** The person's roles in this client, firm roles included. */
  roles: Role[];
  personId: string;
};

/** The client (404 when it isn't one of the user's) and whether its account has the add-on. */
export async function isoGate(clientId: string): Promise<IsoOff | IsoOn> {
  const model = await loadShell();
  const client = model.clients.find((c) => c.id === clientId);
  if (!client) notFound();
  const homeHref = clientHref(clientId);
  if (!model.features.includes(ISO_FEATURE)) return { on: false, client, homeHref };
  const me = await requireMe(await requestPath());
  return {
    on: true,
    client,
    homeHref,
    roles: model.roles.byClient[clientId] ?? [],
    personId: me.person.id,
  };
}

/** `<label> · <client>`, or `Not turned on · <client>` without the add-on (M11's shell test reads both). */
export async function isoMetadata(clientId: string, label: string): Promise<Metadata> {
  const model = await loadShell();
  const client = model.clients.find((c) => c.id === clientId);
  const on = model.features.includes(ISO_FEATURE);
  return { title: [on ? label : 'Not turned on', client?.name].filter(Boolean).join(' · ') };
}

/**
 * Runs a page's API reads. A refusal it can word comes back as one; a lost session goes to sign-in, as the shell's
 * layout would; anything else is thrown to the error page.
 */
export async function isoLoad<T>(
  load: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; refusal: Refusal }> {
  try {
    return { ok: true, data: await load() };
  } catch (error) {
    const next = encodeURIComponent(await requestPath());
    if (isApiError(error, 'UNAUTHENTICATED')) redirect(`/login?next=${next}`);
    if (isApiError(error, 'MFA_REQUIRED')) redirect(`/login/verify?next=${next}`);
    const refusal = refusalFor(error);
    if (refusal) return { ok: false, refusal };
    throw error;
  }
}
