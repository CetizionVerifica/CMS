// jsdom stubs for Radix and the shell (same as packages/ui/test/setup.ts). Real layout, media queries and contrast are
// checked by Playwright in e2e/tests/shell.
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import { setViewport } from './viewport';

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

setViewport(1280);

afterEach(() => {
  cleanup();
  setViewport(1280);
  document.cookie = 'pp_layout=; Max-Age=0; Path=/';
  window.localStorage.clear();
});
