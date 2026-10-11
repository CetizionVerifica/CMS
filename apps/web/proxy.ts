// Next proxy (formerly middleware): passes the requested path to Server Components, which Next doesn't expose to
// layouts, so the shell can send a signed-out user to /login and bring them back to the same page afterwards.
import { NextResponse, type NextRequest } from 'next/server';

import { PATH_HEADER } from './lib/shell/path-header';

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/|api/|favicon.ico|icon.svg|apple-icon.png).*)'],
};
