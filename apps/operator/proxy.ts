// Next proxy: a Content-Security-Policy with a fresh nonce on every page (lib/security/csp.ts). Next reads the nonce
// from the request's policy and puts it on its own scripts.
import { NextResponse, type NextRequest } from 'next/server';

import { contentSecurityPolicy, newNonce } from './lib/security/csp';

export function proxy(request: NextRequest) {
  const policy = contentSecurityPolicy({
    nonce: newNonce(),
    dev: process.env.NODE_ENV === 'development',
  });
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  matcher: ['/((?!_next/|api/|favicon.ico).*)'],
};
