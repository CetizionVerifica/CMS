// jsdom stubs for Radix (same as apps/web/lib/test/setup.ts).
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

const proto = window.HTMLElement.prototype;
proto.scrollIntoView ??= function scrollIntoView() {};
proto.hasPointerCapture ??= () => false;
proto.releasePointerCapture ??= () => {};
proto.setPointerCapture ??= () => {};
window.matchMedia ??= ((query: string) => ({
  matches: query.includes('min-width'),
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

// The first render of a screen with a table can take over a second when CI runs every package's tests at once
// (the merge queue does), so findBy* waits up to 10 s instead of 1 s. Tests still fail fast on a wrong answer.
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => cleanup());
