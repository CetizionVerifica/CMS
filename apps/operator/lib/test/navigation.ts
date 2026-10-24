// A stand-in for next/navigation in jsdom: `vi.mock('next/navigation', () => navigation)` and read `router` calls.
import { vi } from 'vitest';

export const router = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
};
export const location = { pathname: '/accounts' };

export const navigation = {
  useRouter: () => router,
  usePathname: () => location.pathname,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
};
