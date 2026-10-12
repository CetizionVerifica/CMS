import { describe, expect, it } from 'vitest';

import { initialLayout, isShellLayout, layoutForWidth } from './layout-hint';

const h = (values: Record<string, string>) => new Headers(values);
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_PHONE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

describe('layout hint', () => {
  it('maps widths to the AppShell breakpoints', () => {
    expect(layoutForWidth(1280)).toBe('sidebar');
    expect(layoutForWidth(1100)).toBe('sidebar');
    expect(layoutForWidth(1099)).toBe('rail');
    expect(layoutForWidth(640)).toBe('rail');
    expect(layoutForWidth(639)).toBe('sheet');
  });

  it('trusts the cookie first', () => {
    expect(initialLayout(h({ 'user-agent': IPHONE }), 'rail')).toBe('rail');
    expect(initialLayout(h({}), 'bogus')).toBe('sidebar');
    expect(isShellLayout('sheet')).toBe(true);
    expect(isShellLayout(3)).toBe(false);
  });

  it('then the viewport-width client hint', () => {
    expect(
      initialLayout(h({ 'sec-ch-viewport-width': '390', 'sec-ch-ua-mobile': '?0' }), undefined),
    ).toBe('sheet');
    expect(initialLayout(h({ 'sec-ch-viewport-width': '800' }), undefined)).toBe('rail');
    expect(initialLayout(h({ 'sec-ch-viewport-width': 'x' }), undefined)).toBe('sidebar');
  });

  it('then the mobile hint or a phone user agent', () => {
    expect(initialLayout(h({ 'sec-ch-ua-mobile': '?1' }), undefined)).toBe('sheet');
    expect(initialLayout(h({ 'user-agent': IPHONE }), undefined)).toBe('sheet');
    expect(initialLayout(h({ 'user-agent': ANDROID_PHONE }), undefined)).toBe('sheet');
    expect(initialLayout(h({ 'user-agent': ANDROID_TABLET }), undefined)).toBe('sidebar');
    expect(initialLayout(h({}), undefined)).toBe('sidebar');
  });
});
