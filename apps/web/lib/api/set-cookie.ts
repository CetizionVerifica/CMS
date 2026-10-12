export type CookieInit = {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  maxAge?: number;
};

/** Parses one Set-Cookie header into the shape `cookies().set()` takes. `secureByDefault` applies when the API omits it. */
export function parseSetCookie(header: string, secureByDefault = false): CookieInit | undefined {
  const [pair, ...attrs] = header.split(';').map((p) => p.trim());
  const eq = pair?.indexOf('=') ?? -1;
  if (!pair || eq <= 0) return undefined;
  const cookie: CookieInit = {
    name: pair.slice(0, eq),
    value: decodeURIComponent(pair.slice(eq + 1)),
    // Session cookies are Secure outside local development (api-conventions.md §1).
    secure: secureByDefault,
  };
  for (const attr of attrs) {
    const [rawKey, ...rest] = attr.split('=');
    const key = rawKey!.toLowerCase();
    const value = rest.join('=');
    if (key === 'path') cookie.path = value;
    else if (key === 'domain' && value) cookie.domain = value.replace(/^\./, '');
    else if (key === 'expires') {
      const expires = new Date(value);
      if (!Number.isNaN(expires.getTime())) cookie.expires = expires;
    } else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'max-age') cookie.maxAge = Number(value);
    else if (key === 'samesite') {
      const v = value.toLowerCase();
      if (v === 'lax' || v === 'strict' || v === 'none') cookie.sameSite = v;
    }
  }
  return cookie;
}
