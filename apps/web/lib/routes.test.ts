import { describe, expect, it } from 'vitest';

import {
  clientHref,
  clientIdFromPath,
  featureForPath,
  featureOn,
  findRoute,
  hrefFor,
  routeByPath,
  ROUTES,
  safeNextPath,
  switchClientHref,
  visibleTo,
} from './routes';

describe('routes', () => {
  it('covers every route in apps/web/CLAUDE.md', () => {
    expect(ROUTES.map((r) => r.path)).toEqual([
      'overview',
      'register',
      'calendar',
      'approvals',
      'evidence',
      'reports',
      'audit',
      'setup/entities',
      'setup/people',
      'setup/departments',
      'setup/reminders',
      'import',
      'portfolio',
      'library/acts',
      'library/obligations',
      'account',
      // The ISO add-on (docs/iso/plan.md §5), shipped by M17.
      'iso/overview',
      'iso/checklist',
      'iso/documents',
      'iso/risks',
      'iso/objectives',
      'iso/audits',
      'iso/nonconformities',
      'iso/management-reviews',
      'iso/certification',
    ]);
  });

  it('ties every ISO route, and only those, to the ISO add-on', () => {
    for (const route of ROUTES) {
      expect(route.feature).toBe(route.path.startsWith('iso/') ? 'isoManagement' : undefined);
      if (route.feature) expect(route).toMatchObject({ scope: 'client', module: 'M17' });
    }
    expect(featureOn(routeByPath('iso/audits'), [])).toBe(false);
    expect(featureOn(routeByPath('iso/audits'), ['isoManagement'])).toBe(true);
    expect(featureOn(routeByPath('register'), [])).toBe(true);
    expect(featureForPath(['iso'])).toBe('isoManagement');
    expect(featureForPath(['iso', 'nonconformities', '12'])).toBe('isoManagement');
    expect(featureForPath(['register'])).toBeUndefined();
    expect(featureForPath(['isotope'])).toBeUndefined();
    expect(featureForPath(['constructor'])).toBeUndefined();
    expect(featureForPath([])).toBeUndefined();
    expect(findRoute('client', ['iso', 'management-reviews'])?.label).toBe('Management reviews');
    expect(switchClientHref('/c/a/iso/audits/12', '', 'b')).toBe('/c/b/iso/audits');
  });

  it('builds client and firm hrefs', () => {
    expect(clientHref('a b')).toBe('/c/a%20b/overview');
    expect(hrefFor(routeByPath('register'), 'c1')).toBe('/c/c1/register');
    expect(hrefFor(routeByPath('portfolio'), 'c1')).toBe('/portfolio');
    expect(hrefFor(routeByPath('register'))).toBe('/register');
    expect(() => routeByPath('nope')).toThrow('Unknown route nope');
  });

  it('limits routes by role', () => {
    expect(visibleTo(routeByPath('register'), ['OWNER'])).toBe(true);
    expect(visibleTo(routeByPath('approvals'), ['OWNER'])).toBe(false);
    expect(visibleTo(routeByPath('approvals'), ['OWNER', 'APPROVER'])).toBe(true);
    expect(visibleTo(routeByPath('import'), ['CLIENT_ADMIN'])).toBe(false);
    expect(visibleTo(routeByPath('portfolio'), ['CONSULTANT'])).toBe(true);
  });

  it('finds the route a stub stands in for', () => {
    expect(findRoute('client', ['setup', 'people'])?.label).toBe('People');
    expect(findRoute('client', ['portfolio'])).toBeUndefined();
    expect(findRoute('firm', ['library', 'acts'])?.label).toBe('Acts');
    expect(findRoute('firm', ['nope'])).toBeUndefined();
  });

  it('keeps the section and query when switching client, and drops record ids', () => {
    expect(switchClientHref('/c/a/register', '?fy=2022-23&q=Q3', 'b')).toBe(
      '/c/b/register?fy=2022-23&q=Q3',
    );
    expect(switchClientHref('/c/a/register/123', 'fy=2022-23', 'b')).toBe(
      '/c/b/register?fy=2022-23',
    );
    expect(switchClientHref('/c/a/setup/people', '', 'b')).toBe('/c/b/setup/people');
    expect(switchClientHref('/c/a/unknown', '?', 'b')).toBe('/c/b/overview');
    expect(switchClientHref('/portfolio', '', 'b')).toBe('/c/b/overview');
  });

  it('reads the client id from a path', () => {
    expect(clientIdFromPath('/c/a%20b/register')).toBe('a b');
    expect(clientIdFromPath('/portfolio')).toBeUndefined();
  });

  it('accepts only same-site paths after login', () => {
    expect(safeNextPath('/c/a/register?fy=2022-23')).toBe('/c/a/register?fy=2022-23');
    expect(safeNextPath('https://evil.test')).toBeUndefined();
    expect(safeNextPath('//evil.test')).toBeUndefined();
    expect(safeNextPath('/\\evil.test')).toBeUndefined();
    expect(safeNextPath('/a\nb')).toBeUndefined();
    expect(safeNextPath('')).toBeUndefined();
    expect(safeNextPath(null)).toBeUndefined();
  });
});
