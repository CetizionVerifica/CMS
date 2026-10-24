// The one check on any address the console navigates to from a URL it was given (`?next=`, the page being left):
// it must be a path on the console itself. Parsing it as the browser would catches what a prefix test misses:
// `/\evil.test` and `/\t/evil.test` both resolve to another host.
const BASE = 'https://console.invalid';

/** `raw` as a path, query and fragment on the console's own origin, or null when it would leave it or go to /login. */
export function consolePath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/')) return null;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
