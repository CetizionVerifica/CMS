// Next proxy (formerly middleware): passes the requested path to Server Components, which Next doesn't expose to
// layouts, so the shell can send a signed-out user to /login and bring them back to the same page afterwards. It also
// sets the page's Content-Security-Policy with a fresh nonce (lib/security/csp.ts).
import { NextResponse, type NextRequest } from 'next/server';

import { contentSecurityPolicy, newNonce } from './lib/security/csp';
import { PATH_HEADER } from './lib/shell/path-header';

export function proxy(request: NextRequest) {
  const policy = contentSecurityPolicy({
    nonce: newNonce(),
    dev: process.env.NODE_ENV === 'development',
    connectSrc: process.env.CANOPY_CSP_CONNECT_SRC,
  });
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  // Next takes the nonce from the request's policy and adds it to the scripts it renders.
  headers.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  matcher: ['/((?!_next/|api/|favicon.ico|icon.svg|apple-icon.png).*)'],
};
