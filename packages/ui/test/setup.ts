// jsdom lacks a few browser APIs Radix and the shell use. Stubs only; behaviour that needs a real browser
// (layout, contrast, media queries) is covered by the Playwright suite in e2e/.
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

// Default to desktop. Tests that need another width call `setViewport` from ./viewport.
setViewport(1280);

afterEach(() => {
  cleanup();
  setViewport(1280);
});
