// Content-Security-Policy for every page (security review F10). proxy.ts sets it per request with a fresh nonce: Next
// reads the nonce from the request's policy and puts it on its own scripts, so no other inline script can run.

export type CspOptions = {
  nonce: string;
  /** `next dev` evaluates code with eval for fast refresh; production never does. */
  dev?: boolean;
  /**
   * Extra `connect-src` sources, space-separated (`CANOPY_CSP_CONNECT_SRC`): the object storage origin that presigned
   * upload URLs point at, so the browser may PUT evidence and import workbooks there. Only bare https origins are
   * kept (http too under `next dev`); see `connectOrigins`.
   */
  connectSrc?: string;
};

/**
 * The origins in `connectSrc` that are safe to put in the header: `https://host[:port]` and nothing else, so a
 * mistyped value can neither open uploads to plain http nor add a directive (`https://x; script-src *`). Others are
 * returned as `rejected` for the caller to report; uploads to them then fail, which is the safe way round.
 */
export function connectOrigins(
  connectSrc: string | undefined,
  dev = false,
): { origins: string[]; rejected: string[] } {
  const origins: string[] = [];
  const rejected: string[] = [];
  for (const source of connectSrc?.split(/\s+/).filter(Boolean) ?? []) {
    (isOrigin(source, dev) ? origins : rejected).push(source);
  }
  return { origins, rejected };
}

// Scheme, host name and optional port, with at most a trailing slash. Stricter than the URL parser, which takes
// `;` and other characters in a host.
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?\/?$/i;
const HTTP_ORIGIN = /^http:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?\/?$/i;

function isOrigin(source: string, dev: boolean): boolean {
  return HTTPS_ORIGIN.test(source) || (dev && HTTP_ORIGIN.test(source));
}

export function contentSecurityPolicy({ nonce, dev = false, connectSrc }: CspOptions): string {
  const connect = ["'self'", ...connectOrigins(connectSrc, dev).origins];
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
