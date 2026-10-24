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

type Entries = Map<string, { value: unknown; expires: number }>;

// Next bundles this module once for page renders and again for Server Actions, so module-level maps would be two
// different caches and a sign-in action couldn't clear what the next render reads. The maps live on globalThis
// instead, by name, like the mock server (mock-delegate.ts).
const shared = globalThis as typeof globalThis & { __ppSessionCaches?: Map<string, Entries> };
const registry = (shared.__ppSessionCaches ??= new Map());

function keyOf(cookie: string): string {
  return createHash('sha256').update(cookie).digest('base64url');
}

/** The cache called `name`: every copy of this module that asks for the same name shares its entries. */
export function sessionCache<T>(
  name: string,
  ttlMs: number,
  now: () => number = () => Date.now(),
): SessionCache<T> {
  let entries = registry.get(name);
  if (!entries) registry.set(name, (entries = new Map()));
  const map = entries;
  return {
    get(cookie) {
      const key = keyOf(cookie);
      const entry = map.get(key);
      if (!entry) return undefined;
      if (entry.expires > now()) return entry.value as T;
      map.delete(key);
      return undefined;
    },
    set(cookie, value) {
      const time = now();
      if (map.size >= MAX_ENTRIES) {
        for (const [key, entry] of map) if (entry.expires <= time) map.delete(key);
        // Still full of live entries: drop the oldest, which a Map keeps first.
        if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value!);
      }
      map.set(keyOf(cookie), { value, expires: time + ttlMs });
    },
    forget(cookie) {
      map.delete(keyOf(cookie));
    },
    clear() {
      map.clear();
    },
  };
}

/** Drops this session's answers from every cache: its sign-in state just changed (sign-in, MFA, sign-out). */
export function forgetSession(cookie: string): void {
  const key = keyOf(cookie);
  for (const map of registry.values()) map.delete(key);
}

/** Empties every cache. Tests only. */
export function clearSessionCaches(): void {
  for (const map of registry.values()) map.clear();
}
