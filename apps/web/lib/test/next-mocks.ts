// Stand-ins for next/headers and next/navigation in unit tests. Each test sets the request cookies and headers.
import { vi } from 'vitest';

export const request = {
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
  /** Cookies the code under test set with cookies().set(). */
  set: [] as { name: string; value: string; maxAge?: number }[],
};

export class RedirectError extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}
export class NotFoundError extends Error {}

export function resetRequest() {
  request.cookies.clear();
  request.headers.clear();
  request.set.length = 0;
}

export const nextHeaders = {
  headers: async () => ({
    get: (name: string) => {
      if (name === 'cookie') {
        return request.cookies.size
          ? [...request.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
          : null;
      }
      return request.headers.get(name.toLowerCase()) ?? null;
    },
  }),
  cookies: async () => ({
    get: (name: string) =>
      request.cookies.has(name) ? { name, value: request.cookies.get(name)! } : undefined,
    set: (c: { name: string; value: string; maxAge?: number }) => {
      request.set.push(c);
      if (c.maxAge === 0) request.cookies.delete(c.name);
      else request.cookies.set(c.name, c.value);
    },
  }),
};

export const nextNavigation = {
  redirect: vi.fn((url: string) => {
    throw new RedirectError(url);
  }),
  notFound: vi.fn(() => {
    throw new NotFoundError('not found');
  }),
};
