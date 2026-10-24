// Content-Security-Policy for every page (security review F10). proxy.ts sets it per request with a fresh nonce: Next
// reads the nonce from the request's policy and puts it on its own scripts, so no other inline script can run.

export type CspOptions = {
  nonce: string;
  /** `next dev` evaluates code with eval for fast refresh; production never does. */
  dev?: boolean;
  /**
   * Extra `connect-src` sources, space-separated (`CANOPY_CSP_CONNECT_SRC`): the object storage origin that presigned
   * upload URLs point at, so the browser may PUT evidence and import workbooks there.
   */
  connectSrc?: string;
};

export function contentSecurityPolicy({ nonce, dev = false, connectSrc }: CspOptions): string {
  const connect = ["'self'", ...(connectSrc?.split(/\s+/).filter(Boolean) ?? [])];
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(dev ? ["'unsafe-eval'"] : []),
    ],
    // React and the design system set style attributes; styles can't run code.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': connect,
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

/** A fresh base64 nonce, 128 bits, for one response. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
