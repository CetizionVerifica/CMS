// Next proxy (formerly middleware): passes the requested path to Server Components, which Next doesn't expose to
// layouts, so the shell can send a signed-out user to /login and bring them back to the same page afterwards. It also
// sets the page's Content-Security-Policy with a fresh nonce (lib/security/csp.ts).
import { NextResponse, type NextRequest } from 'next/server';

import { connectOrigins, contentSecurityPolicy, newNonce } from './lib/security/csp';
import { PATH_HEADER } from './lib/shell/path-header';

const dev = process.env.NODE_ENV === 'development';
const connectSrc = process.env.CANOPY_CSP_CONNECT_SRC;
// A trial before go-live: the browser reports violations in its console but blocks nothing.
const reportOnly = process.env.CANOPY_CSP_REPORT_ONLY === 'true';
const { rejected } = connectOrigins(connectSrc, dev);
if (rejected.length > 0) {
  console.warn(
    `CANOPY_CSP_CONNECT_SRC: left out ${rejected.join(' ')}; give bare https origins, like https://files.example.com`,
  );
}

export function proxy(request: NextRequest) {
  const policy = contentSecurityPolicy({ nonce: newNonce(), dev, connectSrc });
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  // Next takes the nonce from the request's policy and adds it to the scripts it renders.
  headers.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set(
    reportOnly ? 'content-security-policy-report-only' : 'content-security-policy',
    policy,
  );
  return response;
}

export const config = {
  matcher: ['/((?!_next/|api/|favicon.ico|icon.svg|apple-icon.png).*)'],
};
