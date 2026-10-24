// A short cache of per-session API answers, shared by the requests one browser makes. Every page is rendered per
// request, and a page's links prefetch other pages, so without it each render asks the API for the same user and
// counts again (security review F7). Keys are a hash of the browser's cookie header, so an answer is only ever served
// back to the session it was fetched for, and the raw session token is never held as a key.
import 'server-only';

import { createHash } from 'node:crypto';

const MAX_ENTRIES = 1000;

export type SessionCache<T> = {
  get(cookie: string): T | undefined;
  set(cookie: string, value: T): void;
  forget(cookie: string): void;
  clear(): void;
};

const caches: SessionCache<unknown>[] = [];

function keyOf(cookie: string): string {
  return createHash('sha256').update(cookie).digest('base64url');
}

export function sessionCache<T>(
  ttlMs: number,
  now: () => number = () => Date.now(),
): SessionCache<T> {
  const entries = new Map<string, { value: T; expires: number }>();
  const cache: SessionCache<T> = {
    get(cookie) {
      const key = keyOf(cookie);
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expires > now()) return entry.value;
      entries.delete(key);
      return undefined;
    },
    set(cookie, value) {
      const time = now();
      if (entries.size >= MAX_ENTRIES) {
        for (const [key, entry] of entries) if (entry.expires <= time) entries.delete(key);
        // Still full of live entries: drop the oldest, which a Map keeps first.
        if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
      }
      entries.set(keyOf(cookie), { value, expires: time + ttlMs });
    },
    forget(cookie) {
      entries.delete(keyOf(cookie));
    },
    clear() {
      entries.clear();
    },
  };
  caches.push(cache as SessionCache<unknown>);
  return cache;
}

/** Drops this session's answers from every cache: its sign-in state just changed (sign-in, MFA, sign-out). */
export function forgetSession(cookie: string): void {
  for (const cache of caches) cache.forget(cookie);
}

/** Empties every cache. Tests only. */
export function clearSessionCaches(): void {
  for (const cache of caches) cache.clear();
}
