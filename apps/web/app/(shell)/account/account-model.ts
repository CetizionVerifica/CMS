// What the account page shows, as plain data: the plan's limits beside what the account uses, and PlanetPulse support
// grants in words. Formatting only; the API counts usage and decides each grant's status.
import type { AccountView, SupportGrant } from '@canopy/contracts';

export type UsageRow = {
  label: string;
  used: string;
  limit: string;
  /** True when one more would pass the limit. */
  atLimit: boolean;
};

const LIMITS = [
  ['companies', 'Companies'],
  ['units', 'Units'],
  ['users', 'Users'],
  ['storageBytes', 'Evidence storage'],
] as const;

const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'] as const;

/** "1.5 GB": powers of 1024, one decimal under 10. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${UNITS[unit]}`;
}

export function usageRows(view: AccountView): UsageRow[] {
  return LIMITS.map(([key, label]) => {
    const used = view.usage[key];
    const max = view.entitlements.limits[key];
    const show = key === 'storageBytes' ? formatBytes : (n: number) => String(n);
    return {
      label,
      used: show(used),
      limit: max === null ? 'No limit' : show(max),
      atLimit: max !== null && used >= max,
    };
  });
}

export const ACCOUNT_STATUS: Record<AccountView['status'], string> = {
  PROVISIONING: 'Being set up',
  TRIAL: 'Trial',
  ACTIVE: 'Active',
  SUSPENDED: 'Paused',
  PENDING_DELETION: 'Closing',
  DELETED: 'Deleted',
};

export const SUPPORT_LEVEL: Record<SupportGrant['level'], { label: string; detail: string }> = {
  READ_ONLY: {
    label: 'Read only',
    detail: 'Support can look at every client, but change nothing.',
  },
  ADMIN: {
    label: 'Admin',
    detail: 'Support can act as an account admin, for example to fix a setup or an import.',
  },
};

const GRANT_STATUS: Record<SupportGrant['status'], string> = {
  ACTIVE: 'Active',
  EXPIRED: 'Ended',
  REVOKED: 'Revoked',
};

/** Days a grant can run (contracts: 1 to 30, default 7). */
export const DAY_OPTIONS = [1, 3, 7, 14, 30].map((d) => ({
  value: String(d),
  label: d === 1 ? '1 day' : `${d} days`,
}));

const TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Kolkata',
});

/** "24 Oct 2026, 16:30 IST": account times are shown in India's time, the account's default zone. */
export function formatInstant(instant: string): string {
  return `${TIME.format(new Date(instant))} IST`;
}

export type GrantRow = {
  id: string;
  level: string;
  status: string;
  live: boolean;
  from: string;
  until: string;
};

/** "Business" for BUSINESS: plans are data (ADR M15-0001 decision 5), so the code is worded rather than looked up. */
export function planName(code: string): string {
  const words = code.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What a grant about to be made gives, for its confirmation: the level, the length and the end, from `now`. */
export function grantSummary(
  level: SupportGrant['level'],
  days: number,
  now: Date,
  replacing: boolean,
): string {
  const until = formatInstant(new Date(now.getTime() + days * 86_400_000).toISOString());
  const length = days === 1 ? '1 day' : `${days} days`;
  const gives = `${SUPPORT_LEVEL[level].label} access for ${length}, until about ${until}. ${SUPPORT_LEVEL[level].detail}`;
  return replacing ? `${gives} The current access ends now.` : gives;
}

export function grantRows(grants: SupportGrant[]): GrantRow[] {
  return grants.map((g) => ({
    id: g.id,
    level: SUPPORT_LEVEL[g.level].label,
    status: GRANT_STATUS[g.status],
    live: g.status === 'ACTIVE',
    from: formatInstant(g.startsAt),
    until: formatInstant(g.status === 'REVOKED' && g.revokedAt ? g.revokedAt : g.endsAt),
  }));
}
