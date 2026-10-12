import { redirect } from 'next/navigation';

import { clientHref } from '../../../../lib/routes';

type Props = { params: Promise<{ clientId: string }> };

// /c/[clientId] opens the client's overview.
export default async function ClientHome({ params }: Props) {
  redirect(clientHref((await params).clientId));
}
