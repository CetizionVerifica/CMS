import { redirect } from 'next/navigation';

import { requireMe } from '../lib/api/server';
import { buildShellModel, homeHref } from '../lib/shell/model';

// "/" sends each user to their home: the portfolio for firm users, their client's overview for client users.
export default async function Home() {
  const me = await requireMe('/');
  redirect(homeHref(buildShellModel(me)));
}
